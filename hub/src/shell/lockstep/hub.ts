/**
 * The hub in lockstep (hub-design.md section 11, "Lockstep"): the real core, the real loop of
 * section 4, the real writer on a real file with section 5's rules, and the real control
 * commands, driven by the controller's messages (`control-protocol/lockstep.ts`) instead of the
 * host's clock and sockets. Nothing here reads the host's clock or its random source.
 *
 * An `advance {to}` runs the hub through every instant up to `to`, earliest first: the instants
 * are the times of the inputs given (frames, links, commands, clock changes) and the times the
 * hub wakes for (a core timer, the writer's flush). At each instant the clock reads that instant;
 * a `clock` change given for it applies first; then its inputs go to the loop in the order they
 * came, and the loop turns until nothing waits, as section 4's loop does, a turn taking at most
 * 64 inputs. When none came but a wake is due, one `tick` turn runs. What the hub sent, recorded
 * and answered meanwhile is the `idle` answer.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { type Calendar, EVERY_DAY } from "../../core/model/calendar.ts";
import { makeCalendar } from "../calendar/calendar.ts";
import { join } from "node:path";
import { fromHex, toHex } from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import {
  type LockstepIdle,
  type LockstepToHub,
  type ReplyLine,
  typedCommand,
} from "../../control-protocol/index.ts";
import type { AuditRecord } from "../../core/model/audit.ts";
import type { ControlReply } from "../../core/model/control.ts";
import { closeDatabase } from "../safe/sqlite.ts";
import type { HubError } from "../../core/model/errors.ts";
import { connId, type RequestId, requestId } from "../../core/model/ids.ts";
import { DEFAULT_RULES, type HubRules } from "../../core/model/rules.ts";
import { type Mono, mono, type Now } from "../../core/model/time.ts";
import { type Core, MODULES, makeCore } from "../../core/step.ts";
import type { Clock } from "../../ports/clock.ts";
import type { LogQuery } from "../../ports/reader.ts";
import { ensureHubKeys, seededHubKeys } from "../advertise/hub-keys.ts";
import { controlChunkReply, UploadStore } from "../app/uploads.ts";
import { retryWaitingRestore } from "../backup/restore.ts";
import { KeyStoreCipher } from "../cipher/device-cipher.ts";
import { recordJson } from "../control/records.ts";
import { TransferServer } from "../firmware/serve.ts";
import { sendSession } from "../firmware/session.ts";
import { LockstepLinks } from "../links/lockstep.ts";
import { LinkRegistry } from "../links/registry.ts";
import { HubLoop } from "../loop.ts";
import { MemoryKeyStore } from "../storage/keys.ts";
import { type OpenedStore, openStore } from "../storage/store.ts";
import { benchRestore, lockstepFiles, seedBackupKeys, writeRunStats } from "./files.ts";
import { SeededRandom } from "./random.ts";

const ORIGIN = "shell/lockstep";
/** Instants one `advance` may run before the hub gives up: a wake that never moves on. */
const MAX_INSTANTS_PER_ADVANCE = 10_000_000;
/** Turns at one instant before the hub gives up: inputs that keep making inputs. */
const MAX_TURNS_PER_INSTANT = 100_000;

type Start = Extract<LockstepToHub, { readonly type: "start" }>;
type Input = Extract<
  LockstepToHub,
  { readonly type: "frame" | "linkUp" | "linkDown" | "control" | "clock" }
>;

/** Whether the calendar knows `zone`: every day has a midnight in a zone it knows. */
function knownZone(calendar: Calendar, zone: string, wallMs: number): boolean {
  return calendar.next({ at: { hour: 0, minute: 0 }, days: EVERY_DAY }, zone, wallMs) !== undefined;
}

/**
 * A run's random bytes: the seed with the boot's number mixed in (4 bytes, little-endian), so one
 * seed gives each run of the hub its own stream, and the same seed and boot the same one.
 */
/**
 * The bench's control requests come on its one wire, so on one control connection: `ConnId` 1 of
 * this hub's counter (m2-design.md section 6), which opens no app connection.
 */
const LOCKSTEP_CONTROL_CONN = connId(1);

export function lockstepRandom(seed: Uint8Array, boot: number): SeededRandom {
  const bootBytes = new Uint8Array(4);
  new DataView(bootBytes.buffer).setUint32(0, boot, true);
  return new SeededRandom(new Uint8Array([...seed, ...bootBytes]));
}

/**
 * The clock in lockstep: the instant being run, on the controller's clock, and the wall clock the
 * controller set. The hub reads its own monotonic time: the controller's less `offset`, so it
 * starts again at every `start` (at `start.mono`, 0 by default), as a real hub's does at every
 * restart; every time on the wire stays on the controller's clock.
 */
export class LockstepClock implements Clock {
  /** The controller's time now. */
  #mono: number;
  readonly #offset: number;
  /** The wall clock reads `#wall` at `#wallAt`, and runs with the true clock from there. */
  #wall: number;
  #wallAt: number;
  #trusted: boolean;

  constructor(at: number, wall: number, trusted: boolean, startMono = 0) {
    this.#mono = at;
    this.#offset = at - startMono;
    this.#wall = wall;
    this.#wallAt = at;
    this.#trusted = trusted;
  }

  /** The controller's time now. */
  get mono(): number {
    return this.#mono;
  }

  /** The controller's time of the hub's monotonic `at`. */
  controllerTime(at: Mono): number {
    return at + this.#offset;
  }

  now(): Now {
    return {
      mono: mono(this.#mono - this.#offset),
      wall: this.#wall + Math.floor((this.#mono - this.#wallAt) / 1000),
      wallTrusted: this.#trusted,
    };
  }

  moveTo(at: number): void {
    this.#mono = Math.max(this.#mono, at);
  }

  setWall(at: number, wall: number, trusted: boolean): void {
    this.#wall = wall;
    this.#wallAt = at;
    this.#trusted = trusted;
  }
}

export interface LockstepOptions {
  readonly dataDir: string;
  readonly rules?: HubRules;
  readonly migrationsFolder?: string;
  /** The core to run: the real one when left out; a test stands in one that faults. */
  readonly core?: Core;
}

/** What the lockstep hub keeps for its file work: uploads, transfers, the restore's inputs. */
interface LockstepFileParts {
  readonly uploads: UploadStore;
  readonly transfers: TransferServer;
  readonly dataDir: string;
  readonly migrationsFolder: string;
  readonly rules: HubRules;
}

/** Why the hub refused a message: the run cannot go on (section 11, "Errors"). */
export interface LockstepRefusal {
  readonly kind: "refused";
  readonly message: string;
}

export class LockstepHub {
  readonly #clock: LockstepClock;
  readonly #store: OpenedStore;
  readonly #loop: HubLoop;
  readonly #links: LockstepLinks;
  readonly #pending: Input[] = [];
  /** The time handled so far: inputs may not be given before it. */
  #reached: number;
  #frames: { link: string; at: number; bytes: string }[] = [];
  #records: AuditRecord[] = [];
  #replies: ReplyLine[] = [];
  readonly #asked = new Map<RequestId, number>();
  #nextRequest = 1;
  #stopped = false;
  /** A fatal error the loop reported: it takes nothing more, so every answer is `error`. */
  #fatal: string | undefined;
  readonly #files: LockstepFileParts;

  private constructor(
    clock: LockstepClock,
    store: OpenedStore,
    loop: HubLoop,
    links: LockstepLinks,
    at: number,
    files: LockstepFileParts,
  ) {
    this.#clock = clock;
    this.#store = store;
    this.#loop = loop;
    this.#links = links;
    this.#reached = at;
    this.#files = files;
  }

  /**
   * The hub's start (section 7, "Hub restart") at the `start` message's time: the database, the
   * keys (made from the seed at the first start), the key store, the boot. Answers the first `idle`.
   */
  static async start(
    message: Start,
    options: LockstepOptions,
  ): Promise<Result<{ readonly hub: LockstepHub; readonly idle: LockstepIdle }, HubError>> {
    const rules = options.rules ?? DEFAULT_RULES;
    // The calendar first: a zone it does not know is refused before the database is opened, so a
    // refused `start` leaves nothing half started.
    const calendar = makeCalendar();
    if (calendar.isErr()) return err(calendar.error);
    const zone = message.zone;
    if (zone !== undefined && !knownZone(calendar.value, zone, message.wall))
      return err({
        kind: "config",
        origin: ORIGIN,
        message: `the time zone ${JSON.stringify(zone)} is not one the calendar knows`,
      });
    const clock = new LockstepClock(message.at, message.wall, message.trusted, message.mono ?? 0);
    const seed = fromHex(message.seed);
    const keysHolder: { keys: MemoryKeyStore | undefined } = { keys: undefined };
    const migrationsFolder =
      options.migrationsFolder ?? join(import.meta.dir, "..", "..", "..", "drizzle");
    // A restore the controller asked for (`benchRestore`) is put in place before the database
    // opens, as `main.ts` puts a waiting one (m2-design.md section 9, "A swap that did not happen").
    const retried = retryWaitingRestore(options.dataDir);
    const opened = openStore({
      dataDir: options.dataDir,
      migrationsFolder,
      clock,
      rules,
      platform: process.platform,
      onCommitted: (ops) => keysHolder.keys?.applyCommitted(ops),
      stopwatch: () => 0,
    });
    if (opened.isErr()) return err(opened.error);
    const store = opened.value;
    const random = lockstepRandom(seed, store.boot.id);
    // The hub's keys from the seed's own stream, so they do not depend on what else used it.
    const scalar = new SeededRandom(new Uint8Array([...seed, 0x6b, 0x65, 0x79, 0x73])).bytes(32);
    if (scalar.isErr()) return err(scalar.error);
    const hubKeys = await ensureHubKeys(store.snapshot.hubKeys, store.writer, crypto.subtle, () =>
      seededHubKeys(scalar.value),
    );
    if (hubKeys.isErr()) return err(hubKeys.error);
    // The backup key and the app key from the seed at the first start (`files.ts`), so the
    // controller can restore a backup the hub wrote.
    const seeded = seedBackupKeys(store.db, store.writer, seed, store.snapshot.m2.backupKey);
    if (seeded.isErr()) return err(seeded.error);
    const keys = MemoryKeyStore.load(store.db);
    if (keys.isErr()) return err(keys.error);
    keysHolder.keys = keys.value;
    const uploads = new UploadStore(options.dataDir);
    const cleared = uploads.clearAll();
    if (cleared.isErr()) return err(cleared.error);
    const registry = new LinkRegistry();
    const links = new LockstepLinks(registry, () => clock.mono);
    const holder: {
      respond: ((request: RequestId, reply: ControlReply) => void) | undefined;
      publish: ((record: AuditRecord) => void) | undefined;
      fatal: ((error: HubError) => void) | undefined;
      loop: HubLoop | undefined;
    } = { respond: undefined, publish: undefined, fatal: undefined, loop: undefined };
    // Firmware transfers on granted links, answered by the shell as on the running hub
    // (m3-updates-design section 5): their frames leave in the `idle` with the hub's own.
    const transfers = new TransferServer({
      dataDir: options.dataDir,
      send: (link, bytes) => registry.sendTransfer(link, bytes),
      emit: (event) => {
        holder.loop?.enqueue(event);
      },
      // Measured for the run's figures only: no answer on the wire carries it.
      stopwatch: () => performance.now(),
    });
    registry.serveTransfers(transfers);
    // A backup's salt from the seed's own stream: never the host's random source.
    const salts = lockstepRandom(new Uint8Array([...seed, 0x73]), store.boot.id);
    const loop: HubLoop = new HubLoop(
      options.core ?? makeCore(MODULES),
      { cipher: new KeyStoreCipher(keys.value), rules, calendar: calendar.value, sha256 },
      {
        clock,
        random,
        links: registry,
        control: {
          respond: (request, reply) => holder.respond?.(request, reply),
          publish: (record) => holder.publish?.(record),
        },
        writer: store.writer,
        advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
        wakeAt: () => undefined,
        soon: () => undefined,
        report: () => undefined,
        // The loop has stopped (section 10): the next answer is `error`, never a silent `idle`.
        fatal: (error) => holder.fatal?.(error),
        // Each turn's own time, for the run's figures only (`writeRunStats`): `hsn status` in
        // lockstep still says 0, so no answer on the wire depends on the machine's speed.
        stopwatch: () => performance.now(),
        files: lockstepFiles({
          db: store.db,
          dataDir: options.dataDir,
          migrationsFolder,
          rules,
          uploads,
          writer: store.writer,
          state: () => loop.state,
          nowMs: () => clock.now().wall,
          random: (length) => salts.bytes(length),
        }),
        transfers,
        // `firmware.bluetooth`'s answer, with the session key, on the control line that asked.
        // A key that cannot be derived is answered `unavailable` by `sendSession` itself.
        bluetoothSession: (effect) => {
          sendSession(effect, keys.value, {
            app: () => undefined,
            control: (request, reply) => holder.respond?.(request, reply),
          }).match(
            () => undefined,
            () => undefined,
          );
        },
      },
    );
    holder.loop = loop;
    registry.listen((event) => {
      loop.enqueue(event);
    });
    const hub = new LockstepHub(clock, store, loop, links, message.at, {
      uploads,
      transfers,
      dataDir: options.dataDir,
      migrationsFolder,
      rules,
    });
    holder.respond = (request, reply) => {
      hub.#respond(request, reply);
    };
    holder.publish = (record) => {
      hub.#records.push(record);
    };
    holder.fatal = (error) => {
      hub.#fatal ??= error.message;
    };
    const m2 = store.snapshot.m2;
    loop.enqueue({
      kind: "boot",
      snapshot: {
        ...store.snapshot,
        hubKeys: hubKeys.value,
        m2: {
          ...m2,
          backupKey: seeded.value.backupKey,
          appKeys: { appStaticPublic: seeded.value.appStaticPublic },
        },
      },
      boot: store.boot,
    });
    if (retried.kind === "refused")
      loop.enqueue({
        kind: "shellWarning",
        code: "restore_waiting",
        message: "a restore is waiting and could not be put in place",
        detail: JSON.stringify({ reason: retried.reason }),
      });
    // The time zone, when the controller gives one: queued behind the boot, before anything else
    // is admitted, as `main.ts` queues the system's (section 2).
    if (zone !== undefined) loop.enqueue({ kind: "timeZone", zone });
    const ran = hub.#runInstant(message.at);
    if (ran.isErr()) return err({ kind: "internal", origin: ORIGIN, message: ran.error.message });
    return ok({ hub, idle: hub.#idle(message.at) });
  }

  get store(): OpenedStore {
    return this.#store;
  }

  /** One message after `start`: `idle` for `advance`, `idle` then `stopped` for `stop`. */
  handle(
    message: LockstepToHub,
  ): Result<
    readonly ({ readonly type: "stopped"; readonly at: number } | LockstepIdle)[],
    LockstepRefusal
  > {
    if (this.#stopped) return err({ kind: "refused", message: "the hub has stopped" });
    switch (message.type) {
      case "start":
        return err({ kind: "refused", message: "the hub has started already: `start` comes once" });
      case "advance": {
        if (message.to < this.#reached)
          return err({
            kind: "refused",
            message: `advance to ${message.to}, before ${this.#reached}`,
          });
        return this.#advance(message.to).map((idle) => [idle]);
      }
      case "stop": {
        if (message.at < this.#reached)
          return err({
            kind: "refused",
            message: `stop at ${message.at}, before ${this.#reached}`,
          });
        return this.#advance(message.at).andThen((idle) => {
          this.#loop.stop();
          const stopped = this.#store.writer.stop();
          if (stopped.isErr())
            return err({ kind: "refused" as const, message: stopped.error.message });
          this.#stopped = true;
          // What the run cost, for the controller's budget (`files.ts`, `writeRunStats`).
          writeRunStats(this.#files.dataDir, {
            writer: this.#store.writer.stats,
            longestTurnMs: this.#loop.takeLongestTurnMs(),
            longestTransferMs: this.#files.transfers.takeLongestMs(),
          });
          // The clean stop's commit is not a record: the idle before it is the last.
          return ok([idle, { type: "stopped" as const, at: message.at }]);
        });
      }
      default: {
        if (message.at < this.#reached)
          return err({
            kind: "refused",
            message: `${message.type} at ${message.at}, before ${this.#reached}, which is already handled`,
          });
        this.#pending.push(message);
        return ok([]);
      }
    }
  }

  /** Closes the database without committing anything more, as a kill would leave it. */
  close(): Result<void, HubError> {
    this.#files.transfers.close();
    return closeDatabase(this.#store.db, ORIGIN);
  }

  #respond(request: RequestId, reply: ControlReply): void {
    const id = this.#asked.get(request);
    if (id === undefined) return;
    this.#asked.delete(request);
    this.#replies.push({ id, reply: this.#withWriterStatus(reply) });
  }

  /** `hsn status`'s writer figures, as the control socket fills them in (section 9). */
  #withWriterStatus(reply: ControlReply): ControlReply {
    if (!reply.ok || reply.result.kind !== "status") return reply;
    const { writer } = this.#store;
    return {
      ok: true,
      result: {
        ...reply.result,
        lastCommitMs: writer.lastCommitMs ?? null,
        stagedItems: writer.staged,
        databaseBytes: writer.inUseBytes ?? null,
        historyShortened: writer.trimming,
        // Fixed: a figure of the machine's own speed would make two runs of a session differ.
        longestTurnMs: 0,
      },
    };
  }

  #idle(to: number): LockstepIdle {
    const idle: LockstepIdle = {
      type: "idle",
      to,
      boot: this.#store.boot.id,
      frames: [...this.#frames, ...this.#links.drainSent()],
      closed: this.#links.drainClosed(),
      records: this.#records.map(recordJson),
      replies: this.#replies,
      wake: this.#wake() ?? null,
    };
    this.#frames = [];
    this.#records = [];
    this.#replies = [];
    return idle;
  }

  /** The hub's next wake, on the controller's clock. */
  #wake(): number | undefined {
    const wake = this.#loop.nextWake();
    return wake === undefined ? undefined : this.#clock.controllerTime(wake);
  }

  /** The next instant after the one reached: an input's or a wake's, if any is at or before `to`. */
  #nextInstant(to: number): number | undefined {
    const inputs = this.#pending.map((m) => m.at);
    const wake = this.#wake();
    const times = [...inputs, ...(wake === undefined ? [] : [Math.max(wake, this.#reached)])];
    const next = times.length === 0 ? undefined : Math.min(...times);
    return next === undefined || next > to ? undefined : next;
  }

  #advance(to: number): Result<LockstepIdle, LockstepRefusal> {
    for (let instants = 0; ; instants++) {
      if (instants > MAX_INSTANTS_PER_ADVANCE)
        return err({
          kind: "refused",
          message: `more than ${MAX_INSTANTS_PER_ADVANCE} instants up to ${to}`,
        });
      const next = this.#nextInstant(to);
      if (next === undefined) break;
      const ran = this.#runInstant(next);
      if (ran.isErr()) return err(ran.error);
    }
    this.#clock.moveTo(to);
    this.#reached = to;
    return ok(this.#idle(to));
  }

  /** Everything at one instant: its clock changes, its inputs in order, the turns they need. */
  #runInstant(at: number): Result<void, LockstepRefusal> {
    this.#clock.moveTo(at);
    this.#reached = at;
    const here = this.#pending.filter((m) => m.at === at);
    const later = this.#pending.filter((m) => m.at !== at);
    this.#pending.length = 0;
    this.#pending.push(...later);
    for (const m of here) if (m.type === "clock") this.#clock.setWall(at, m.wall, m.trusted);
    for (const m of here) {
      switch (m.type) {
        case "clock":
          break;
        case "frame":
        case "linkUp":
        case "linkDown":
          this.#links.accept(m);
          this.#links.release(at);
          break;
        case "control":
          this.#command(m.request.id, m.request.actor, m.request.command);
          break;
      }
    }
    if (this.#loop.waiting === 0) {
      const wake = this.#wake();
      if (wake !== undefined && wake <= at) this.#loop.enqueue({ kind: "tick" });
    }
    // A file job in pieces runs a piece a turn (m2-design.md section 3); in lockstep its turns
    // take no time, so it runs to its end at the instant it began, the inputs it makes with it.
    for (let turns = 0; this.#loop.waiting > 0 || this.#loop.openJobs > 0; turns++) {
      if (turns > MAX_TURNS_PER_INSTANT)
        return err({
          kind: "refused",
          message: `more than ${MAX_TURNS_PER_INSTANT} turns at ${at}`,
        });
      this.#loop.turn();
    }
    if (this.#fatal !== undefined)
      return err({ kind: "refused", message: `the hub stopped on a fatal error: ${this.#fatal}` });
    return ok(undefined);
  }

  /** A command, as the control socket takes it (section 9): `log` answered here, the rest by the core. */
  #command(
    id: number,
    actor: string,
    parsed: Extract<LockstepToHub, { readonly type: "control" }>["request"]["command"],
  ): void {
    if (parsed.kind === "fileChunk") {
      // The shell's own (m2-design.md section 6), kept for the operation that names its job.
      const { job, n, data, end } = parsed;
      const chunk = end === undefined ? { job, n, data } : { job, n, data, end };
      this.#replies.push({
        id,
        reply: controlChunkReply(this.#files.uploads.chunk(LOCKSTEP_CONTROL_CONN, chunk)),
      });
      return;
    }
    if (parsed.kind === "benchRestore") {
      // The lockstep hub's alone, before the core (which refuses it on every other socket).
      const restored = benchRestore(parsed.file, parsed.key, this.#files);
      this.#replies.push({
        id,
        reply: restored.isOk()
          ? { ok: true, result: { kind: "benchRestore" } }
          : { ok: false, error: { code: "failed", message: `benchRestore: ${restored.error}` } },
      });
      return;
    }
    const typed = typedCommand(parsed);
    if (typed === undefined) return;
    const command = typed;
    const request = requestId(this.#nextRequest++);
    if (command.kind !== "log") {
      this.#asked.set(request, id);
      this.#loop.enqueue({ kind: "command", request, conn: LOCKSTEP_CONTROL_CONN, actor, command });
      return;
    }
    // Recorded like any command; answered from the database after a flush (section 3).
    this.#loop.enqueue({ kind: "command", request, conn: LOCKSTEP_CONTROL_CONN, actor, command });
    this.#loop.turn();
    if (command.follow) {
      this.#replies.push({
        id,
        reply: {
          ok: false,
          error: {
            code: "failed",
            message: "no --follow in lockstep: every record is in the idle answers",
          },
        },
      });
      return;
    }
    const query: LogQuery = {
      ...(command.device === undefined ? {} : { device: command.device }),
      ...(command.since === undefined ? {} : { since: command.since }),
      ...(command.logKind === undefined ? {} : { logKind: command.logKind }),
    };
    const read = this.#store.writer.flush("log").andThen(() => this.#store.reader.query(query));
    this.#replies.push({
      id,
      reply: read.isOk()
        ? { ok: true, result: { kind: "log", records: read.value.map(recordJson) } }
        : {
            ok: false,
            error: { code: "failed", message: `the log could not be read: ${read.error.message}` },
          },
    });
  }
}

/** Bytes of a sent frame, for tests. */
export function frameBytes(frame: { readonly bytes: string }): Uint8Array {
  return fromHex(frame.bytes);
}

export { toHex };
export type { Mono };

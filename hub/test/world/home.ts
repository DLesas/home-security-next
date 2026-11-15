/**
 * A whole home on the whole hub (hub-design.md section 11): the loop of section 4
 * (`shell/loop.ts`) running the real `step` with all thirteen modules, over the real writer on a
 * real SQLite file and the real cipher with keys from `device_keys`, and on the far ends of its
 * links the scripted gateways, sensors and sirens of `test/world/`.
 *
 * - **Time.** One true time runs through the day, in microseconds; the devices live on it. The
 *   hub's monotonic clock starts at zero at each of its boots and its wall clock follows the true
 *   time, so a restart is a new boot while the devices carry on.
 * - **The air.** Every sensor and siren packet goes on one site channel at its rate; each gateway
 *   that listens there at that rate hears it, unless it overlapped another packet on the channel
 *   or the gateway was sending, and forwards it 30 ms after its end. A gateway's transmission
 *   reaches the device it is addressed to at its start.
 * - **Links.** Each gateway has a network link, each siren with Wi-Fi a network link of its own.
 *   A frame the hub sends is given to the device at once; what it answers is the next input.
 * - **Power.** `restart("clean")` stops the hub as SIGTERM does; `restart("cut")` keeps exactly
 *   the files as they are at that instant (`synchronous = FULL`). Either way the hub is off for a
 *   while, the devices go on without it, and it starts again from the disk.
 *
 * Every loop here is bounded: a run that stops making progress fails with a message.
 */
import { nodeSha256 } from "@hsn/protocol";
import { UNBUILT_CALENDAR } from "../../src/shell/calendar/unbuilt.ts";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Message,
  MessageType,
  ResumeStep,
  SirenState,
  spreadingFactor,
  timeOnAirMs,
} from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import type { AuditRecord } from "../../src/core/model/audit.ts";
import type { ControlCommand, ControlReply } from "../../src/core/model/control.ts";
import type { DecisionKind } from "../../src/core/model/decisions.ts";
import type { CounterUse as SendCounterUse, Effect } from "../../src/core/model/effects.ts";
import type { HubEvent } from "../../src/core/model/events.ts";
import {
  type DeviceId,
  deviceId,
  type LinkId,
  linkId,
  type RequestId,
  requestId,
  type SendRef,
  connId,
} from "../../src/core/model/ids.ts";
import { coreFault } from "../../src/core/model/errors.ts";
import { DEFAULT_RULES, type HubRules } from "../../src/core/model/rules.ts";
import {
  type DecisionRow,
  DeviceState,
  type DeviceRow,
  type GatewayConfigRow,
  type SirenConfigRow,
} from "../../src/core/model/rows.ts";
import type { StoreOp } from "../../src/core/model/store.ts";
import { type Mono, mono, type Now } from "../../src/core/model/time.ts";
import { type Core, makeCore, MODULES } from "../../src/core/step.ts";
import type { Clock } from "../../src/ports/clock.ts";
import type { LinkError, Links } from "../../src/ports/links.ts";
import type { StagedEffect } from "../../src/ports/writer.ts";
import { ensureHubKeys } from "../../src/shell/advertise/hub-keys.ts";
import { KeyStoreCipher } from "../../src/shell/cipher/device-cipher.ts";
import {
  type ChannelEffect,
  HubLoop,
  type LoopWriter,
  type TurnSummary,
} from "../../src/shell/loop.ts";
import { MemoryKeyStore } from "../../src/shell/storage/keys.ts";
import { PAGE_SIZE } from "../../src/shell/storage/settings.ts";
import { DATABASE_FILE, openStore, type OpenedStore } from "../../src/shell/storage/store.ts";
import { WAL_FRAME_HEADER_BYTES, walFrames } from "../../src/shell/storage/wal.ts";
import { sensorRow, siteRowAt } from "../scenarios/sensors/bench.ts";
import { tempDir } from "../unit/storage/fixtures.ts";
import { SeededBytes } from "./entropy.ts";
import { ScriptedGateway } from "./scripted-gateway.ts";
import { ScriptedSensor, type Transmission } from "./scripted-sensor.ts";
import { ScriptedSiren } from "./scripted-siren.ts";
import type { ScriptedDevice } from "./world.ts";

export const SECOND = 1_000_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** The wall clock at true time 0: 2026-11-13 00:00 UTC. */
export const WALL_AT_START_MS = Date.UTC(2026, 10, 13);
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");
/** The site's rate: DR5 (section 8's default). */
const SITE_RATE = 5;
/** The site channel the home starts on: 868.3 MHz. */
const SITE_CHANNEL = 1;
/** From a packet's end to its forwarded copy reaching the hub. */
const FORWARD_DELAY_US = 30_000;
/** Transmissions older than this cannot overlap anything new. */
const KEEP_AIR_US = 10 * SECOND;
/**
 * Rounds at one instant with nothing new (no state, commit, send or frame) before the home gives
 * up: a wake that is never handled would otherwise spin for ever.
 */
export const MAX_ROUNDS_WITHOUT_PROGRESS = 100;
/** Turns run for one instant before the home gives up: inputs that keep making inputs. */
export const MAX_TURNS_AT_ONCE = 20_000;
const WAL_HEADER_BYTES = 32;
const FRAME_BYTES = PAGE_SIZE + WAL_FRAME_HEADER_BYTES;

/** A home of section 5: its devices. */
export interface HomeSpec {
  readonly name: string;
  readonly sensors: number;
  readonly sirens: number;
  readonly gateways: number;
  /** The seed of every random choice: entropy, drifts, door times, crash points. */
  readonly seed?: number;
  readonly rules?: HubRules;
}

/** Section 5's home A: 10 sensors, 4 sirens; one gateway. */
export const HOME_A: HomeSpec = { name: "A", sensors: 10, sirens: 4, gateways: 1 };
/** Section 5's home B: 30 sensors, 4 sirens; one gateway. */
export const HOME_B: HomeSpec = { name: "B", sensors: 30, sirens: 4, gateways: 1 };

/** Why a run of the home stopped short. */
export interface HomeStalled {
  readonly kind: "stalled";
  readonly message: string;
}

/** Where in a turn the power goes (section 4's table, "What a crash leaves behind"). */
export const CRASH_POINTS = [
  "inStep",
  "afterStaging",
  "inCommit",
  "afterCommit",
  "afterSends",
  "inCheckpoint",
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

/** A device of the home and its row. */
interface Member {
  readonly row: DeviceRow;
  readonly key: Uint8Array;
}

/** A gateway: the scripted one, its link while up, and what it sent. */
interface GatewayMember extends Member {
  readonly gateway: ScriptedGateway;
  link: LinkId | undefined;
  /** How many of its transmissions the air has taken. */
  taken: number;
  /** When it sends its next status, on true time (§6, every status interval). */
  statusAt: number | undefined;
  connectedAt: number;
  busy: { readonly from: number; readonly until: number }[];
}

interface SirenMember extends Member {
  readonly siren: ScriptedSiren;
  wifiLink: LinkId | undefined;
  /** Whether its Wi-Fi network is up: it connects whenever the hub is there. */
  wifi: boolean;
}

/** A board on a USB port (`test/unit/setup/support/board.ts`), plugged in until unplugged. */
interface BoardMember {
  readonly board: ScriptedDevice;
  readonly port: string;
  link: LinkId | undefined;
  plugged: boolean;
}

type LinkOwner = GatewayMember | SirenMember | BoardMember;

/** A commit and what it held, as the loop staged it. */
export interface Committed {
  readonly items: readonly StagedEffect[];
  readonly wallMs: number;
  /** The turn that committed it, counted over all runs. */
  readonly turn: number;
}

/** A packet a gateway forwarded to the hub. */
export interface Forwarded {
  readonly at: number;
  readonly packet: Uint8Array;
  /** The turn whose step took it, counted over all runs; undefined until a step takes it. */
  turn: number | undefined;
}

interface SensorMember extends Member {
  readonly sensor: ScriptedSensor;
}

/** A packet on the air, by whom. */
interface OnAir {
  readonly start: number;
  readonly end: number;
  readonly channel: number;
  readonly dataRate: number;
  readonly packet: Uint8Array;
}

/** The clock the hub reads: its own boot's monotonic time, the wall clock following true time. */
class HomeClock implements Clock {
  trueUs = 0;
  bootAtUs = 0;
  trusted = true;

  now(): Now {
    return {
      mono: mono(this.trueUs - this.bootAtUs),
      wall: WALL_AT_START_MS + Math.floor(this.trueUs / 1000),
      wallTrusted: this.trusted,
    };
  }

  /** True time of the hub's monotonic `at`. */
  trueOf(at: Mono): number {
    return at + this.bootAtUs;
  }
}

function key(seed: number): Uint8Array {
  return new Uint8Array(16).map((_, j) => (seed * 37 + j * 13 + 7) & 0xff);
}

function addressOf(packet: Uint8Array): number {
  return new DataView(packet.buffer, packet.byteOffset + 1, 4).getUint32(0, true);
}

function airtimeUs(dataRate: number, length: number): number {
  return Math.ceil(timeOnAirMs(spreadingFactor(dataRate) ?? 7, length) * 1000);
}

/** What `hsn` was told, with the request. */
export interface Told {
  readonly request: RequestId;
  readonly command: ControlCommand;
  readonly reply: ControlReply;
  readonly at: number;
}

/** A send that left the hub: its link, bytes and counters. */
export interface LeftHub {
  readonly at: number;
  readonly link: LinkId;
  readonly bytes: Uint8Array;
  readonly counters: readonly SendCounterUse[];
  /** Which run of the hub sent it: 0 before the first restart. */
  readonly run: number;
}

export class Home {
  readonly spec: HomeSpec;
  readonly rules: HubRules;
  readonly clock = new HomeClock();
  readonly sensors: SensorMember[] = [];
  readonly sirens: SirenMember[] = [];
  readonly gateways: GatewayMember[] = [];
  /** Every record the loop staged, over all runs (some lost to a power cut). */
  readonly records: AuditRecord[] = [];
  /** Every answer `hsn` got. */
  readonly told: Told[] = [];
  /** Every effect the loop handed the app side (sessions' replies and events), over all runs. */
  readonly app: ChannelEffect[] = [];
  /** Every send that left the hub, over all runs. */
  readonly left: LeftHub[] = [];
  /** Every turn's summary, this run. */
  turns = 0;
  restarts = 0;
  readonly #random: SeededBytes;
  #dir = tempDir("home");
  #store: OpenedStore | undefined;
  #keys: MemoryKeyStore | undefined;
  #loop: HubLoop | undefined;
  #core: Core;
  /** The counters of each send of the turn being run, by its ref. */
  readonly #counters = new Map<SendRef, readonly SendCounterUse[]>();
  #nextLink = 1;
  #nextRequest = 1;
  readonly #requests = new Map<RequestId, { command: ControlCommand; at: number }>();
  readonly #linkOwner = new Map<LinkId, LinkOwner>();
  readonly boards: BoardMember[] = [];
  /** Every commit, over all runs, and what is staged since the last (section 11, condition 5). */
  readonly commitLog: Committed[] = [];
  pendingItems: StagedEffect[] = [];
  /** Every packet the gateways forwarded, over all runs (condition 6). */
  readonly forwardedLog: Forwarded[] = [];
  /** Called when the store is open, before the boot event; then once the links are up again. */
  onOpen: ((store: OpenedStore) => void) | undefined;
  onStarted: (() => void) | undefined;
  #crashNeedsNow = false;
  #faultNext = false;
  #crashTurn = false;
  /** The turns the power was lost in, counted over all runs. */
  readonly crashedTurns = new Set<number>();
  readonly #forwardedFrames = new Map<Uint8Array, Forwarded>();
  #air: OnAir[] = [];
  #forwards: { readonly at: number; readonly gateway: GatewayMember; readonly t: OnAir }[] = [];
  #deliveries: { readonly at: number; readonly packet: Uint8Array; readonly rate: number }[] = [];
  /** Set while a turn runs after its power was cut: nothing more leaves the hub. */
  #dead = false;
  #crashAt: CrashPoint | undefined;
  #crashed: { readonly how: "asIs" | "torn" | "checkpoint"; readonly frames?: number } | undefined;
  /** Set when a run stopped short; every later call reports it. */
  #stalled: HomeStalled | undefined;

  private constructor(spec: HomeSpec) {
    this.spec = spec;
    this.rules = spec.rules ?? DEFAULT_RULES;
    this.#random = new SeededBytes(spec.seed ?? 1);
    const real = makeCore(MODULES);
    // The loop does not say which counters each send carried; the home keeps them by ref, for
    // the crash tests' "no counter twice".
    this.#core = {
      ...real,
      step: (state, input, deps) => {
        if (this.#faultNext && input.event.kind === "frame") {
          // A bug in a module, standing in: the step fails and the state stays (section 10).
          this.#faultNext = false;
          return err(
            coreFault("frame", "test/home", "a fault the test asked for", { at: this.now }),
          );
        }
        if (input.event.kind === "frame") {
          const forwarded = this.#forwardedFrames.get(input.event.bytes);
          this.#forwardedFrames.delete(input.event.bytes);
          if (forwarded !== undefined) forwarded.turn = this.turns;
        }
        const stepped = real.step(state, input, deps);
        if (stepped.isOk()) {
          for (const effect of stepped.value.effects) {
            if (effect.kind === "send") this.#counters.set(effect.ref, effect.counters);
            if (
              (effect.kind === "write" || effect.kind === "record") &&
              effect.durability === "now"
            )
              this.#crashTurn = true;
          }
        }
        // Power lost in the step: nothing of this turn reaches the disk.
        if (this.#crashAt === "inStep" && (!this.#crashNeedsNow || this.#crashTurn))
          this.#cut("asIs");
        return stepped;
      },
    };
    this.#makeDevices();
  }

  /** A home with every device paired already, the hub started on it. */
  static async create(spec: HomeSpec, prepare?: (store: OpenedStore) => void): Promise<Home> {
    const home = new Home(spec);
    await home.#seed(prepare);
    home.#start();
    return home;
  }

  /** Why the home stopped short, if it did. */
  get stalled(): HomeStalled | undefined {
    return this.#stalled;
  }

  /** The uniform random number in [0, 1) the seed gives next. */
  uniform(): number {
    return this.#random.next() / 2 ** 32;
  }

  get store(): OpenedStore | undefined {
    return this.#store;
  }

  get loop(): HubLoop | undefined {
    return this.#loop;
  }

  /** True time now. */
  get now(): number {
    return this.clock.trueUs;
  }

  sensor(name: string): ScriptedSensor | undefined {
    return this.sensors.find((m) => m.row.name === name)?.sensor;
  }

  siren(name: string): ScriptedSiren | undefined {
    return this.sirens.find((m) => m.row.name === name)?.siren;
  }

  // ----- The devices and the database before the first start -----

  #makeDevices(): void {
    let id = 1;
    const row = (address: number, role: number, name: string): DeviceRow => ({
      id: deviceId(id++),
      address,
      role,
      name,
      chipId: new Uint8Array([role, 0, 0, 0, (address >> 8) & 0xff, address & 0xff]),
      firmware: 0x010000,
      development: false,
      state: DeviceState.Contacted,
      addedMs: WALL_AT_START_MS - 86_400_000,
      removedMs: null,
    });
    for (let i = 0; i < this.spec.gateways; i++) {
      const r = row(0x6a000001 + i, 3, `gateway-${i + 1}`);
      const random = new SeededBytes(1000 + i);
      this.gateways.push({
        row: r,
        key: key(r.id),
        gateway: new ScriptedGateway({
          key: key(r.id),
          address: r.address,
          nextRandom: () => random.bytes(8),
          settingsVersion: 0,
          clockOffsetMicros: 7_000_000 * (i + 1),
          drift: 0.00002 * (i + 1),
        }),
        link: undefined,
        taken: 0,
        statusAt: undefined,
        connectedAt: 0,
        busy: [],
      });
    }
    for (let i = 0; i < this.spec.sensors; i++) {
      const r = row(0x5e000001 + i, 1, `door-${i + 1}`);
      const drift = this.spec.sensors === 1 ? 0 : -0.03 + (0.06 * i) / (this.spec.sensors - 1);
      this.sensors.push({
        row: r,
        key: key(r.id),
        sensor: new ScriptedSensor({
          key: key(r.id),
          address: r.address,
          channel: SITE_CHANNEL,
          rate: SITE_RATE,
          drift,
          random: () => this.uniform(),
          startAt: mono(SECOND + Math.round((170 * SECOND * i) / this.spec.sensors)),
        }),
      });
    }
    for (let i = 0; i < this.spec.sirens; i++) {
      const r = row(0x51000001 + i, 2, `siren-${i + 1}`);
      this.sirens.push({
        row: r,
        key: key(r.id),
        siren: new ScriptedSiren({
          key: key(r.id),
          address: r.address,
          resumePoint: ResumeStep.SirenOrGateway,
          phase: (i + 0.5) / this.spec.sirens,
        }),
        wifiLink: undefined,
        wifi: true,
      });
    }
  }

  /** The rows of a home whose devices were all paired the day before. */
  #seedOps(): readonly StoreOp[] {
    const members: readonly Member[] = [...this.gateways, ...this.sensors, ...this.sirens];
    const ops: StoreOp[] = [
      { table: "site", op: "upsert", row: siteRowAt(SITE_RATE, {}, this.rules) },
    ];
    for (const m of members) {
      ops.push({ table: "devices", op: "upsert", row: m.row });
      ops.push({ table: "device_keys", op: "upsert", row: { deviceId: m.row.id, key: m.key } });
      ops.push({
        table: "send_counters",
        op: "upsert",
        row: { deviceId: m.row.id, resumePoint: ResumeStep.Hub },
      });
    }
    for (const m of this.sensors)
      ops.push({ table: "sensor_config", op: "upsert", row: sensorRow(m.row.id, SITE_RATE) });
    for (const m of this.sirens) {
      const row: SirenConfigRow = {
        deviceId: m.row.id,
        version: 1,
        wifiIntervalS: 30,
        loraCheckUnits: 20,
        maxSoundS: 300,
        sendRate: SITE_RATE,
        commandRate: SITE_RATE,
        siteChannel: SITE_CHANNEL,
        versionHistory: new Uint8Array(),
      };
      ops.push({ table: "siren_config", op: "upsert", row });
    }
    for (const m of this.gateways) {
      const row: GatewayConfigRow = {
        deviceId: m.row.id,
        version: 1,
        statusIntervalS: 30,
        interferenceDb: 10,
        interferenceS: 30,
        defaultPowerDbm: 22,
        sirenPowerDbm: 22,
      };
      ops.push({ table: "gateway_config", op: "upsert", row });
    }
    return ops;
  }

  async #seed(prepare: ((store: OpenedStore) => void) | undefined): Promise<void> {
    const store = this.#openStore()._unsafeUnwrap();
    store.writer.stage(
      this.#seedOps().map((op): StagedEffect => ({ kind: "write", durability: "now", op })),
    );
    store.writer.flush("now")._unsafeUnwrap();
    (await ensureHubKeys(store.snapshot.hubKeys, store.writer))._unsafeUnwrap();
    prepare?.(store);
    store.writer.stop()._unsafeUnwrap();
    store.db.close();
  }

  #openStore(): Result<OpenedStore, { message: string }> {
    return openStore({
      dataDir: this.#dir.path,
      migrationsFolder: MIGRATIONS,
      clock: this.clock,
      rules: this.rules,
      platform: process.platform,
      onCommitted: (ops) => this.#keys?.applyCommitted(ops),
    });
  }

  // ----- The hub: start, links, turns -----

  /** Starts the hub from the disk (section 7, "Hub restart"), then opens every link. */
  #start(): void {
    this.clock.bootAtUs = this.clock.trueUs;
    const store = this.#openStore()._unsafeUnwrap();
    this.#store = store;
    const keys = MemoryKeyStore.load(store.db)._unsafeUnwrap();
    this.#keys = keys;
    const writer = this.#crashWriter(store.writer);
    const links: Links = {
      listen: () => undefined,
      send: (link, bytes, ref) => this.#send(link, bytes, ref),
      close: (link) => this.#closeByHub(link),
    };
    this.#loop = new HubLoop(
      this.#core,
      {
        cipher: new KeyStoreCipher(keys),
        rules: this.rules,
        calendar: UNBUILT_CALENDAR,
        sha256: nodeSha256,
      },
      {
        clock: this.clock,
        random: { bytes: (length) => ok(this.#random.bytes(length)) },
        links,
        control: {
          respond: (request, reply) => {
            const asked = this.#requests.get(request);
            if (asked !== undefined && !this.#dead) this.told.push({ request, reply, ...asked });
          },
          publish: (record) => {
            if (!this.#dead) this.records.push(record);
          },
        },
        writer,
        advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
        wakeAt: () => undefined,
        soon: () => undefined,
        report: () => undefined,
        fatal: (error) => {
          this.#stalled = { kind: "stalled", message: `the hub stopped: ${error.message}` };
        },
        channel: {
          perform: (effect) => {
            if (!this.#dead) this.app.push(effect);
          },
        },
      },
    );
    this.onOpen?.(store);
    this.pendingItems = [];
    this.#loop.enqueue({ kind: "boot", snapshot: store.snapshot, boot: store.boot });
    this.#drain();
    for (const g of this.gateways) this.#connectGateway(g);
    for (const s of this.sirens) if (s.wifi) this.#connectSiren(s);
    for (const b of this.boards) if (b.plugged) b.link = this.#openLink(b.port, b, "usb");
    this.#drain();
    this.onStarted?.();
  }

  #openLink(label: string, owner: LinkOwner, kind: "usb" | "network" = "network"): LinkId {
    const link = linkId(this.#nextLink++);
    this.#linkOwner.set(link, owner);
    this.#loop?.enqueue({ kind: "linkOpened", link, linkKind: kind, label });
    return link;
  }

  /** A board plugged into a USB port of the hub. */
  plugBoard(board: ScriptedDevice, port: string): void {
    const member: BoardMember = { board, port, link: undefined, plugged: true };
    this.boards.push(member);
    member.link = this.#openLink(port, member, "usb");
    this.#drain();
  }

  /** The packets forwarded since `wallMs`, forwarded again by every gateway (condition 6). */
  replay(packets: readonly Uint8Array[]): void {
    for (const packet of packets) {
      for (const g of this.gateways) {
        if (g.link === undefined) continue;
        const frame = g.gateway.forward(packet, {
          endedAt: mono(this.now),
          rssiDbm: -92,
          snrQuarterDb: 24,
          dataRate: SITE_RATE,
          siteChannel: SITE_CHANNEL,
        });
        if (frame !== undefined) this.#frame(g.link, frame);
      }
    }
    this.#drain();
  }

  #connectGateway(g: GatewayMember): void {
    g.link = this.#openLink(`ws:${g.row.name}`, g);
    g.connectedAt = this.now;
    g.statusAt = this.now + 30 * SECOND;
    const hello = g.gateway.hello();
    if (hello !== undefined) this.#frame(g.link, hello);
  }

  #connectSiren(s: SirenMember): void {
    s.wifiLink = this.#openLink(`ws:${s.row.name}`, s);
    s.siren.setWifi(true, mono(this.now));
  }

  #frame(link: LinkId, bytes: Uint8Array): void {
    this.#loop?.enqueue({ kind: "frame", link, bytes });
  }

  /** A send the loop let through: given to the device; what it answers is queued. */
  #send(link: LinkId, bytes: Uint8Array, ref: SendRef): Result<void, LinkError> {
    if (this.#dead) return ok(undefined);
    const owner = this.#linkOwner.get(link);
    const live =
      owner !== undefined && ("siren" in owner ? owner.wifiLink === link : owner.link === link);
    if (owner === undefined || !live) {
      return err({ kind: "link", origin: "test/home", code: "closed", message: "link closed" });
    }
    this.left.push({
      at: this.now,
      link,
      bytes,
      counters: this.#counters.get(ref) ?? [],
      run: this.restarts,
    });
    const now = mono(this.now);
    if ("gateway" in owner) {
      for (const answer of owner.gateway.receive(bytes, now)) this.#frame(link, answer);
      this.#takeTransmissions(owner);
    } else if ("board" in owner) {
      for (const answer of owner.board.receive(bytes, now)) this.#frame(link, answer);
    } else {
      for (const answer of owner.siren.wifi.receive(bytes, now)) this.#frame(link, answer);
    }
    return ok(undefined);
  }

  #closeByHub(link: LinkId): Result<void, LinkError> {
    const owner = this.#linkOwner.get(link);
    if (owner !== undefined && !("siren" in owner) && owner.link === link) owner.link = undefined;
    if (owner !== undefined && "siren" in owner && owner.wifiLink === link)
      owner.wifiLink = undefined;
    this.#loop?.enqueue({ kind: "linkClosed", link, reason: "closedByHub" });
    return ok(undefined);
  }

  #drain(): void {
    const loop = this.#loop;
    if (loop === undefined) return;
    let turns = 0;
    while (this.#loop === loop && loop.waiting > 0) {
      if (++turns > MAX_TURNS_AT_ONCE) {
        this.#stalled = {
          kind: "stalled",
          message: `more than ${MAX_TURNS_AT_ONCE} turns at true time ${this.now} µs: inputs keep making inputs`,
        };
        return;
      }
      this.#turn(loop);
    }
  }

  #turn(loop: HubLoop): TurnSummary {
    this.#counters.clear();
    this.#crashTurn = false;
    const summary = loop.turn();
    this.turns++;
    if (this.#crashed !== undefined) this.#afterCut();
    return summary;
  }

  // ----- Control -----

  /** An `hsn` command, as the control socket gives it (section 9); runs it at once. */
  /** An input as the app channel gives it (a session, a request), and the turns it makes. */
  input(event: HubEvent): void {
    this.#loop?.enqueue(event);
    this.#drain();
  }

  command(command: ControlCommand, actor = "dimi"): RequestId {
    const request = requestId(this.#nextRequest++);
    this.#requests.set(request, { command, at: this.now });
    this.#loop?.enqueue({ kind: "command", conn: connId(0), request, actor, command });
    this.#drain();
    return request;
  }

  /** The answer to a request, if it came. */
  replyTo(request: RequestId): ControlReply | undefined {
    return this.told.find((t) => t.request === request)?.reply;
  }

  decisions(kind: DecisionKind): readonly DecisionRow[] {
    return this.records.flatMap((r) =>
      r.kind === "decision" && r.row.kind === kind ? [r.row] : [],
    );
  }

  hubEvents(code: string) {
    return this.records.flatMap((r) =>
      r.kind === "hubEvent" && r.row.code === code ? [r.row] : [],
    );
  }

  // ----- Time -----

  /** The earliest of the hub's wake and every device's, in true time. */
  #nextWake(): number | undefined {
    const hub = this.#loop?.nextWake();
    const wakes = [
      hub === undefined ? undefined : this.clock.trueOf(hub),
      ...this.sensors.map((m) => m.sensor.nextWake()),
      ...this.sirens.map((m) => m.siren.lora.nextWake()),
      ...this.sirens.map((m) => (m.wifiLink === undefined ? undefined : m.siren.wifi.nextWake())),
      ...this.gateways.map((m) => (m.link === undefined ? undefined : m.gateway.nextWake())),
      ...this.gateways.map((m) => (m.link === undefined ? undefined : m.statusAt)),
      ...this.boards.map((b) => (b.link === undefined ? undefined : b.board.nextWake())),
      this.#forwards[0]?.at,
      this.#deliveries[0]?.at,
    ].filter((at) => at !== undefined);
    return wakes.length === 0 ? undefined : Math.min(...wakes);
  }

  /** Runs everything due up to and including true time `to`, then leaves the clock there. */
  advanceTo(to: number): Result<void, HomeStalled> {
    let stuck = 0;
    for (let wake = this.#nextWake(); wake !== undefined && wake <= to; wake = this.#nextWake()) {
      if (this.#stalled !== undefined) return err(this.#stalled);
      const before = this.#progressMark();
      this.clock.trueUs = Math.max(this.clock.trueUs, wake);
      this.#runDue();
      this.#drain();
      const stalled = this.stalled;
      if (stalled !== undefined) return err(stalled);
      stuck = before.every((value, i) => value === this.#progressMark()[i]) ? stuck + 1 : 0;
      if (stuck >= MAX_ROUNDS_WITHOUT_PROGRESS) {
        this.#stalled = {
          kind: "stalled",
          message: `no progress at true time ${this.now} µs after ${stuck} rounds: the wake at ${wake} is never handled`,
        };
        return err(this.#stalled);
      }
    }
    if (this.#stalled !== undefined) return err(this.#stalled);
    this.clock.trueUs = Math.max(this.clock.trueUs, to);
    return ok(undefined);
  }

  advanceBy(us: number): Result<void, HomeStalled> {
    return this.advanceTo(this.now + us);
  }

  #progressMark(): readonly unknown[] {
    return [
      this.now,
      this.#loop?.state,
      this.turns,
      this.left.length,
      this.#forwards.length,
      this.#deliveries.length,
      this.#store?.writer.stats.commits,
    ];
  }

  #runDue(): void {
    const now = this.now;
    const hub = this.#loop?.nextWake();
    if (hub !== undefined && this.clock.trueOf(hub) <= now) this.#loop?.enqueue({ kind: "tick" });
    // Gateways' packets reach the devices at their start.
    while (this.#deliveries[0] !== undefined && this.#deliveries[0].at <= now) {
      const delivery = this.#deliveries.shift();
      if (delivery === undefined) break;
      const address = addressOf(delivery.packet);
      for (const m of this.sensors)
        if (m.row.address === address)
          m.sensor.hear(delivery.packet, delivery.rate, mono(delivery.at));
      for (const m of this.sirens) {
        if (m.row.address !== address) continue;
        for (const answer of m.siren.lora.receive(delivery.packet, mono(now)))
          this.#transmit(answer, m.siren.held.siteChannel, m.siren.held.sendRate);
      }
    }
    for (const m of this.sensors) {
      const due = m.sensor.nextWake();
      if (due === undefined || due > now) continue;
      for (const t of m.sensor.wake(mono(now))) this.#onAir(t);
    }
    for (const m of this.sirens) {
      const loraDue = m.siren.lora.nextWake();
      if (loraDue !== undefined && loraDue <= now) {
        for (const packet of m.siren.lora.wake(mono(now)))
          this.#transmit(packet, m.siren.held.siteChannel, m.siren.held.sendRate);
      }
      const wifiDue = m.siren.wifi.nextWake();
      if (m.wifiLink !== undefined && wifiDue !== undefined && wifiDue <= now) {
        for (const bytes of m.siren.wifi.wake(mono(now))) this.#frame(m.wifiLink, bytes);
      }
    }
    for (const m of this.gateways) {
      const due = m.gateway.nextWake();
      if (m.link !== undefined && due !== undefined && due <= now)
        for (const bytes of m.gateway.wake(mono(now))) this.#frame(m.link, bytes);
      if (m.link !== undefined && m.statusAt !== undefined && m.statusAt <= now) {
        const interval = m.gateway.settings?.statusIntervalSeconds ?? 30;
        m.statusAt = now + Math.max(1, interval) * SECOND;
        const status = this.#status(m, now);
        if (status !== undefined) this.#frame(m.link, status);
      }
    }
    for (const b of this.boards) {
      const due = b.board.nextWake();
      if (b.link !== undefined && due !== undefined && due <= now)
        for (const bytes of b.board.wake(mono(now))) this.#frame(b.link, bytes);
    }
    this.#forwardDue(now);
  }

  /** A gateway's status: quiet air, its settings, its uptime since it connected. */
  #status(m: GatewayMember, now: number): Uint8Array | undefined {
    return m.gateway.status({
      settingsVersion: m.gateway.settings?.settingsVersion ?? 0,
      // The gateway never restarts here: its uptime runs from true time 0, across the hub's runs.
      uptimeSeconds: Math.floor(now / SECOND),
      airtimeHundredthsPercent: 12,
      noiseMedianDbm: -118,
      noiseHighestDbm: -110,
      normalNoiseDbm: -118,
      packetsReceived: 0,
      packetsCrcFailed: 0,
      wifiRssiDbm: -60,
      flags: { usbConnected: false, cellFitted: false, onMains: true },
    });
  }

  /**
   * A day of doors (section 5: about 20 door reports a day): `opens` openings at seeded moments
   * between 07:00 and 21:00, each closing again after 5 to 120 s, spread over the sensors.
   */
  scriptDoors(opens: number, from = this.now): void {
    for (let i = 0; i < opens; i++) {
      const m = this.sensors[i % this.sensors.length];
      const at = from + 7 * HOUR + Math.floor(this.uniform() * 14 * HOUR);
      const lasts = 5 * SECOND + Math.floor(this.uniform() * 115 * SECOND);
      m?.sensor.door(mono(at), true);
      m?.sensor.door(mono(at + lasts), false);
    }
  }

  /**
   * Section 5's day of doors: each sensor's door opens `opensPerSensor` times (each opening and
   * closing a door event, so 20 a sensor for 10), at seeded moments inside `windows` (true
   * times), each staying open 5 to 120 s.
   */
  scriptDesignDoors(opensPerSensor: number, windows: readonly (readonly [number, number])[]): void {
    const spans = windows.map(([from, to]) => to - from);
    const total = spans.reduce((a, b) => a + b, 0);
    for (const m of this.sensors) {
      for (let i = 0; i < opensPerSensor; i++) {
        let offset = Math.floor(this.uniform() * total);
        const window = windows.find((_, w) => {
          const span = spans[w] ?? 0;
          if (offset < span) return true;
          offset -= span;
          return false;
        });
        if (window === undefined) continue;
        const at = window[0] + offset;
        const lasts = 5 * SECOND + Math.floor(this.uniform() * 115 * SECOND);
        m.sensor.door(mono(at), true);
        m.sensor.door(mono(Math.min(at + lasts, window[1])), false);
      }
    }
  }

  /** A device packet starting now on `channel` at `dataRate`. */
  #transmit(packet: Uint8Array, channel: number, dataRate: number): void {
    const start = this.now;
    this.#onAir({
      packet,
      channel,
      dataRate,
      start: mono(start),
      end: mono(start + airtimeUs(dataRate, packet.length)),
    });
  }

  #onAir(t: Transmission): void {
    const onAir: OnAir = { ...t };
    this.#air.push(onAir);
    for (const gateway of this.gateways)
      this.#forwards.push({ at: t.end + FORWARD_DELAY_US, gateway, t: onAir });
    this.#forwards.sort((a, b) => a.at - b.at);
  }

  #forwardDue(now: number): void {
    this.#air = this.#air.filter((a) => a.end > now - KEEP_AIR_US);
    while (this.#forwards[0] !== undefined && this.#forwards[0].at <= now) {
      const forward = this.#forwards.shift();
      if (forward === undefined) break;
      const { gateway: g, t } = forward;
      const settings = g.gateway.settings;
      const collided = this.#air.some(
        (a) => a !== t && a.channel === t.channel && a.start < t.end && t.start < a.end,
      );
      const deaf = g.busy.some((b) => b.from < t.end && t.start < b.until);
      const listening =
        settings?.siteChannel === t.channel &&
        ((settings.listenDataRateMask >> t.dataRate) & 1) === 1;
      if (collided || deaf || !listening || g.link === undefined) continue;
      const frame = g.gateway.forward(t.packet, {
        endedAt: mono(t.end),
        rssiDbm: -92,
        snrQuarterDb: 24,
        dataRate: t.dataRate,
        siteChannel: t.channel,
      });
      if (frame === undefined) continue;
      const forwarded: Forwarded = { at: now, packet: t.packet, turn: undefined };
      this.forwardedLog.push(forwarded);
      this.#forwardedFrames.set(frame, forwarded);
      this.#frame(g.link, frame);
    }
  }

  /** The gateway's new transmissions: on the air from their start. */
  #takeTransmissions(g: GatewayMember): void {
    for (const t of g.gateway.transmissions.slice(g.taken)) {
      const start = g.gateway.hubTimeAt(t.startMicros);
      const until = start + airtimeUs(t.dataRate, t.packet.length);
      g.busy = [...g.busy.filter((b) => b.until > this.now - KEEP_AIR_US), { from: start, until }];
      this.#deliveries.push({ at: start, packet: t.packet, rate: t.dataRate });
    }
    g.taken = g.gateway.transmissions.length;
    this.#deliveries.sort((a, b) => a.at - b.at);
  }

  // ----- Restarts and power cuts -----

  /**
   * The hub stops (cleanly, as on SIGTERM, or by losing power at once), stays off for `offUs`
   * while the devices go on, and starts again from the disk.
   */
  restart(how: "clean" | "cut", offUs = 10 * SECOND): Result<void, HomeStalled> {
    if (how === "clean") {
      this.#loop?.turn();
      this.#loop?.stop();
      this.#store?.writer.stop()._unsafeUnwrap();
      this.commitLog.push({
        items: this.pendingItems,
        wallMs: this.clock.now().wall,
        turn: this.turns,
      });
      this.pendingItems = [];
      this.#off(offUs);
      return this.#stalled === undefined ? ok(undefined) : err(this.#stalled);
    }
    this.#cut("asIs");
    this.#afterCut(offUs);
    return this.#stalled === undefined ? ok(undefined) : err(this.#stalled);
  }

  /** The core faults on the next frame it is given. */
  faultNext(): void {
    this.#faultNext = true;
  }

  /**
   * The next turn loses power at `point` (section 4's table); with `needsNow`, the next turn that
   * stages something written now.
   */
  crashAt(point: CrashPoint, needsNow = false): void {
    this.#crashAt = point;
    this.#crashNeedsNow = needsNow;
  }

  /** A writer that loses power at the point asked for, then lets the turn run on unseen. */
  #crashWriter(writer: OpenedStore["writer"]): LoopWriter {
    const at = (point: CrashPoint) =>
      this.#crashAt === point &&
      this.#crashed === undefined &&
      (!this.#crashNeedsNow || this.#crashTurn);
    return {
      stage: (items) => {
        writer.stage(items);
        this.pendingItems.push(...items);
        if (at("afterStaging")) this.#cut("asIs");
      },
      setCadence: (everyMs) => {
        writer.setCadence(everyMs);
      },
      durable: (device) => writer.durable(device),
      due: (now) => writer.due(now),
      flushIfDue: (now) => {
        const before = writer.stats.walFrames;
        const flushed = writer.flushIfDue(now);
        const frames = writer.stats.walFrames - before;
        const committed = flushed.isOk() && flushed.value?.committed === true;
        if (committed && !this.#dead) {
          this.commitLog.push({
            items: this.pendingItems,
            wallMs: this.clock.now().wall,
            turn: this.turns,
          });
          this.pendingItems = [];
        }
        if (at("inCommit") && committed && frames > 0) {
          // The commit is cut short: it never happened.
          this.pendingItems = [...(this.commitLog.pop()?.items ?? [])];
          this.#cut("torn", frames);
        } else if (at("inCommit") || at("afterCommit")) this.#cut("asIs");
        return flushed;
      },
      flush: (reason) => writer.flush(reason),
      takeOutcome: () => writer.takeOutcome(),
      maintain: () => {
        if (at("afterSends")) this.#cut("asIs");
        if (at("inCheckpoint")) {
          this.#cut("checkpoint");
          return ok(undefined);
        }
        return writer.maintain();
      },
    };
  }

  /** Power is lost now: the disk as it is, or with its last commit torn, or mid-checkpoint. */
  #cut(how: "asIs" | "torn" | "checkpoint", frames = 0): void {
    if (this.#crashed !== undefined) return;
    this.#crashAt = undefined;
    const store = this.#store;
    if (store === undefined) return;
    const db = join(this.#dir.path, DATABASE_FILE);
    const disk = tempDir("home");
    if (how === "checkpoint") {
      const mainBefore = readFileSync(db);
      const wal = existsSync(`${db}-wal`) ? readFileSync(`${db}-wal`) : undefined;
      store.writer.checkpointNow()._unsafeUnwrap();
      const mainAfter = readFileSync(db);
      const torn = Buffer.from(
        mainBefore.length >= mainAfter.length
          ? mainBefore
          : Buffer.concat([mainBefore, mainAfter.subarray(mainBefore.length)]),
      );
      for (let page = 0; page * PAGE_SIZE < mainAfter.length; page++) {
        if (this.#random.next() % 2 === 0)
          mainAfter.copy(torn, page * PAGE_SIZE, page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      }
      writeFileSync(join(disk.path, DATABASE_FILE), torn);
      if (wal !== undefined) writeFileSync(join(disk.path, `${DATABASE_FILE}-wal`), wal);
    } else {
      copyFileSync(db, join(disk.path, DATABASE_FILE));
      if (existsSync(`${db}-wal`)) {
        const wal = readFileSync(`${db}-wal`);
        let cut = wal.length;
        if (how === "torn") {
          const after = walFrames(db, PAGE_SIZE)._unsafeUnwrap() ?? frames;
          const start = WAL_HEADER_BYTES + (after - frames) * FRAME_BYTES;
          const end = Math.max(start + 1, WAL_HEADER_BYTES + after * FRAME_BYTES);
          cut = start + (this.#random.next() % (end - start));
        }
        writeFileSync(join(disk.path, `${DATABASE_FILE}-wal`), wal.subarray(0, cut));
      }
    }
    this.#crashed = { how };
    this.crashedTurns.add(this.turns);
    this.#dead = true;
    this.#nextDir = disk;
  }

  #nextDir: ReturnType<typeof tempDir> | undefined;

  /** After the cut: the rest of the turn is gone; the hub is off, then starts from the copy. */
  #afterCut(offUs = 10 * SECOND): void {
    this.#loop?.stop();
    this.#off(offUs);
  }

  #off(offUs: number): void {
    this.restarts++;
    this.#store?.db.close();
    this.#store = undefined;
    this.#loop = undefined;
    for (const g of this.gateways) g.link = undefined;
    for (const b of this.boards) b.link = undefined;
    for (const s of this.sirens) {
      s.wifiLink = undefined;
      if (s.siren.wifiUp) s.siren.setWifi(false, mono(this.now));
    }
    this.#linkOwner.clear();
    this.#forwards = [];
    this.#forwardedFrames.clear();
    if (this.#nextDir !== undefined) {
      this.#dir.remove();
      this.#dir = this.#nextDir;
      this.#nextDir = undefined;
    }
    // The devices go on while the hub is off.
    this.advanceTo(this.now + offUs).match(
      () => undefined,
      () => undefined,
    );
    this.#dead = false;
    this.#crashed = undefined;
    this.#start();
  }

  /** The database file of this run, for checks. */
  query<T>(sql: string, ...params: readonly (string | number)[]): T[] {
    return this.#store?.db.query<T, (string | number)[]>(sql).all(...params) ?? [];
  }

  close(): void {
    this.#store?.db.close();
    this.#store = undefined;
    this.#dir.remove();
    this.#nextDir?.remove();
  }

  // ----- What the devices did -----

  /** Whether every siren sounds an alarm now. */
  sirensSounding(): boolean {
    return this.sirens.every((m) => m.siren.output === SirenState.SoundingAlarm);
  }

  /** The commands a siren acted on, decoded. */
  acted(name: string): readonly Message[] {
    return (this.siren(name)?.acted ?? []).map((a) => a.message);
  }
}

/** Whether a message is a siren command. */
export function isSirenCommand(message: Message): boolean {
  return message.type === MessageType.SirenCommand;
}

/** Effects of a kind, typed. */
export function effectsOf<K extends Effect["kind"]>(
  effects: readonly Effect[],
  kind: K,
): readonly Extract<Effect, { kind: K }>[] {
  return effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === kind);
}

/** The id the home gives device `name`. */
export function idOf(home: Home, name: string): DeviceId | undefined {
  return [...home.gateways, ...home.sensors, ...home.sirens].find((m) => m.row.name === name)?.row
    .id;
}

export type { HubEvent };

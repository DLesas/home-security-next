/**
 * The loop of section 4 (`shell/loop.ts`) on its own: the real `HubLoop` with a core that does
 * what each test scripts (standing in for the modules, a bug included), a writer whose flush can
 * be made to fail, and links and a control socket that record what they are given. The rules
 * only a failing commit, a failing link or a fault in the core exercise:
 *
 * - a turn whose "now" commit fails hands nothing to any link, and its answers wait;
 * - every send goes through the send gate: a counter at or above its key's committed resume
 *   point is refused, whatever the core says;
 * - while a commit fails, sends that need nothing uncommitted still go;
 * - a refused send, a failing link, a fault, failing random bytes: what each becomes;
 * - jobs in pieces (m2-design.md section 3, "Jobs in pieces, the loop's contract"): one piece of
 *   each open job a turn, after the turn's inputs, so an input never waits for a job's end; a stop
 *   aborts them; every job's end, a throw included, frees its upload.
 */
import { nodeSha256 } from "@hsn/protocol";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import type { Effect, FileWork } from "../../../src/core/model/effects.ts";
import { type CoreFault, coreFault, type HubError } from "../../../src/core/model/errors.ts";
import type {
  CommitOutcome,
  FileOutcome,
  HubEvent,
  Input,
} from "../../../src/core/model/events.ts";
import {
  type DeviceId,
  deviceId,
  jobId,
  linkId,
  type RequestId,
  requestId,
  sendRef,
  connId,
} from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import type { StoreOp } from "../../../src/core/model/store.ts";
import { type Mono, mono, type Now } from "../../../src/core/model/time.ts";
import type { Core } from "../../../src/core/step.ts";
import type { LinkError } from "../../../src/ports/links.ts";
import type { CommitInfo, StagedEffect, StorageError } from "../../../src/ports/writer.ts";
import {
  HubLoop,
  type JobPieces,
  type LoopPorts,
  type LoopWriter,
  MAX_FAULTS_PER_HOUR,
  MAX_INPUTS_PER_TURN,
} from "../../../src/shell/loop.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";

const LINK = linkId(1);
const SENSOR = deviceId(3);
const BOOT = 4;
/** A state with a boot, which is all the loop reads of it (for its fault records). */
const STATE = { clock: { boot: { id: BOOT } } } as unknown as HubState;

/** What the stand-in core makes of one input. */
type Script = (event: HubEvent) => readonly Effect[] | CoreFault;

function fakeCore(script: Script, seen: HubEvent[]): Core {
  return {
    emptyState: () => STATE,
    nextDeadline: () => undefined,
    step: (state: HubState, input: Input) => {
      seen.push(input.event);
      const made = script(input.event);
      if ("origin" in made && "event" in made) return err(made);
      return ok({ state, effects: made, wake: undefined });
    },
  };
}

/**
 * A writer that keeps what is staged and commits it on a "now" item or when told, or fails while
 * `failing`. Committed `send_counters` rows are what the gate reads (`durable`).
 */
class TestWriter implements LoopWriter {
  failing = false;
  staged: StagedEffect[] = [];
  readonly committed: StagedEffect[][] = [];
  readonly resumePoints = new Map<DeviceId, number>();
  #outcome: CommitOutcome | undefined;
  #failedLast = false;
  maintainFails = false;

  stage(items: readonly StagedEffect[]): void {
    this.staged.push(...items);
  }
  setCadence(): void {
    // The tests never run a countdown.
  }
  durable(device: DeviceId): number | undefined {
    return this.resumePoints.get(device);
  }
  due(now: Mono): Mono | undefined {
    return this.staged.length > 0 ? now : undefined;
  }
  flushIfDue(): Result<(CommitInfo & { readonly committed: boolean }) | undefined, StorageError> {
    if (this.staged.length === 0) return ok(undefined);
    return this.flush();
  }
  flush(): Result<CommitInfo & { readonly committed: boolean }, StorageError> {
    if (this.failing) {
      // The core hears of a failure once, then of the recovery (section 10).
      if (!this.#failedLast) this.#outcome = { kind: "failed", message: "disk full" };
      this.#failedLast = true;
      return err({ kind: "storage", origin: "test", message: "disk full" });
    }
    for (const item of this.staged) {
      const op: StoreOp | undefined = item.kind === "write" ? item.op : undefined;
      if (op?.op === "upsert" && op.table === "send_counters")
        this.resumePoints.set(op.row.deviceId, op.row.resumePoint);
    }
    this.committed.push(this.staged);
    const items = this.staged.length;
    this.staged = [];
    if (this.#failedLast) this.#outcome = { kind: "recovered" };
    this.#failedLast = false;
    return ok({ items, durationMs: 1, committed: true });
  }
  takeOutcome(): CommitOutcome | undefined {
    const outcome = this.#outcome;
    this.#outcome = undefined;
    return outcome;
  }
  maintain(): Result<void, StorageError> {
    return this.maintainFails
      ? err({ kind: "storage", origin: "test", message: "checkpoint failed" })
      : ok(undefined);
  }
}

interface Rig {
  readonly loop: HubLoop;
  readonly writer: TestWriter;
  /** Every input the core took, in order. */
  readonly seen: HubEvent[];
  /** Every packet handed to a link. */
  readonly sent: { readonly bytes: Uint8Array; readonly ref: number }[];
  readonly answered: RequestId[];
  readonly reported: HubError[];
  readonly fatal: HubError[];
  linkFails: LinkError["code"] | undefined;
  randomFails: boolean;
  now: number;
  /** How many times the loop asked for another turn soon. */
  soons: number;
}

function rig(script: Script, files?: LoopPorts["files"], stopwatch?: LoopPorts["stopwatch"]): Rig {
  const seen: HubEvent[] = [];
  const writer = new TestWriter();
  const state = {
    sent: [] as { bytes: Uint8Array; ref: number }[],
    answered: [] as RequestId[],
    reported: [] as HubError[],
    fatal: [] as HubError[],
    linkFails: undefined as LinkError["code"] | undefined,
    randomFails: false,
    now: 0,
    soons: 0,
  };
  const clock = {
    now: (): Now => ({ mono: mono(state.now), wall: 1_800_000_000_000, wallTrusted: true }),
  };
  const ports: LoopPorts = {
    clock,
    random: {
      bytes: (length) =>
        state.randomFails
          ? err({ kind: "random", origin: "test", message: "no entropy" })
          : ok(new Uint8Array(length)),
    },
    links: {
      listen: () => undefined,
      send: (_link, bytes, ref) => {
        if (state.linkFails !== undefined)
          return err({ kind: "link", origin: "test", code: state.linkFails, message: "gone" });
        state.sent.push({ bytes, ref });
        return ok(undefined);
      },
      close: () => err({ kind: "link", origin: "test", code: "closed", message: "already closed" }),
    },
    control: {
      respond: (request) => state.answered.push(request),
      publish: () => undefined,
    },
    writer,
    advertiser: {
      advertise: () => err({ kind: "internal", origin: "test", message: "no multicast" }),
      stop: () => ok(undefined),
    },
    wakeAt: () => undefined,
    soon: () => {
      state.soons += 1;
    },
    report: (error) => state.reported.push(error),
    fatal: (error) => state.fatal.push(error),
    ...(files === undefined ? {} : { files }),
    ...(stopwatch === undefined ? {} : { stopwatch }),
  };
  const loop = new HubLoop(
    fakeCore(script, seen),
    {
      cipher: VectorCipher.fromVectors(),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
    },
    ports,
  );
  return Object.assign(state, { loop, writer, seen });
}

/** Runs turns until nothing waits (bounded). */
function drain(r: Rig): void {
  for (let turns = 0; r.loop.waiting > 0; turns++) {
    expect(turns).toBeLessThan(100);
    r.loop.turn();
  }
}

const frame = (n: number): HubEvent => ({ kind: "frame", link: LINK, bytes: new Uint8Array([n]) });

function send(counter: number, n = 1): Effect {
  return {
    kind: "send",
    link: LINK,
    bytes: new Uint8Array([0xee, counter & 0xff]),
    ref: sendRef(n),
    counters: [{ device: SENSOR, counter }],
  };
}

function writeNow(resumePoint: number): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "send_counters", op: "upsert", row: { deviceId: SENSOR, resumePoint } },
  };
}

/** Something a reply depends on, written now: a countdown's row stands for any. */
const COUNTDOWN: Effect = {
  kind: "write",
  durability: "now",
  op: {
    table: "countdowns",
    op: "upsert",
    row: {
      sensorId: SENSOR,
      boot: BOOT as never,
      openedMono: mono(0),
      deadlineMono: mono(30_000_000),
      newestCounter: 9,
      replyGatewayId: null,
      replyRate: 5,
      causeSeq: 1 as never,
    },
  },
};

/** The sensor's key with a committed resume point of 2,048. */
function withDurable(r: Rig): void {
  r.writer.resumePoints.set(SENSOR, 2048);
}

const sendFailures = (r: Rig) =>
  r.seen.flatMap((e) => (e.kind === "sendFailed" ? [[e.ref, e.error]] : []));

describe("a turn whose now commit fails (section 4, step 4)", () => {
  test("hands nothing to any link; the core gets sendFailed {notDurable}; the packet goes after a flush succeeds", () => {
    let recovered = false;
    const r = rig((event) => {
      // The door report: its countdown written now, and the reply that says it started.
      if (event.kind === "frame") return [COUNTDOWN, send(1500)];
      // The core sends the reply again once the commit is back.
      if (event.kind === "commit" && event.outcome.kind === "recovered") {
        recovered = true;
        return [send(1500, 2)];
      }
      return [];
    });
    withDurable(r);
    r.writer.failing = true;
    r.loop.enqueue(frame(1));
    drain(r);
    expect(r.sent).toEqual([]);
    expect(sendFailures(r)).toEqual([[sendRef(1), "notDurable"]]);
    expect(r.seen.flatMap((e) => (e.kind === "commit" ? [e.outcome.kind] : []))).toEqual([
      "failed",
    ]);

    // Still failing: still nothing leaves.
    r.loop.enqueue({ kind: "tick" });
    drain(r);
    expect(r.sent).toEqual([]);

    r.writer.failing = false;
    r.loop.enqueue({ kind: "tick" });
    drain(r);
    expect(recovered).toBe(true);
    expect(r.writer.committed.flat()).toContainEqual(COUNTDOWN);
    expect(r.sent).toEqual([{ bytes: new Uint8Array([0xee, 1500 & 0xff]), ref: sendRef(2) }]);
  });

  test("a command's answer waits while its commit fails, and is given once after a flush succeeds", () => {
    const request = requestId(7);
    const r = rig((event) =>
      event.kind === "command"
        ? [
            writeNow(4096),
            { kind: "respond", request, reply: { ok: true, result: { kind: "status" } } as never },
          ]
        : [],
    );
    r.writer.failing = true;
    r.loop.enqueue({
      kind: "command",
      conn: connId(0),
      request,
      actor: "dimi",
      command: { kind: "status" },
    });
    drain(r);
    expect(r.answered).toEqual([]);
    r.loop.enqueue({ kind: "tick" });
    drain(r);
    expect(r.answered).toEqual([]);
    r.writer.failing = false;
    r.loop.enqueue({ kind: "tick" });
    drain(r);
    expect(r.answered).toEqual([request]);
    r.loop.enqueue({ kind: "tick" });
    drain(r);
    expect(r.answered).toEqual([request]);
  });

  test("while a commit fails, sends that need nothing uncommitted still go (every key keeps sending below its point)", () => {
    const r = rig((event) => {
      if (event.kind === "frame" && event.bytes[0] === 1) return [COUNTDOWN];
      if (event.kind === "frame" && event.bytes[0] === 2) return [send(1600)];
      return [];
    });
    withDurable(r);
    r.writer.failing = true;
    r.loop.enqueue(frame(1));
    drain(r);
    r.loop.enqueue(frame(2));
    drain(r);
    expect(r.writer.staged).toContainEqual(COUNTDOWN);
    expect(r.sent.map((s) => s.ref)).toEqual([sendRef(1)]);
    expect(sendFailures(r)).toEqual([]);
  });
});

describe("the send gate on the real loop (section 4)", () => {
  test("a send whose counter is at or above its key's committed resume point is refused, with sendFailed", () => {
    // A module with a bug: it uses 2,048 and 3,000 before 4,096 is committed.
    const r = rig((event) =>
      event.kind === "frame" ? [send(2048, 1), send(3000, 2), send(2047, 3)] : [],
    );
    withDurable(r);
    r.loop.enqueue(frame(1));
    drain(r);
    expect(r.sent.map((s) => s.ref)).toEqual([sendRef(3)]);
    expect(sendFailures(r)).toEqual([
      [sendRef(1), "notDurable"],
      [sendRef(2), "notDurable"],
    ]);
  });

  test("a key with no committed resume point sends nothing", () => {
    const r = rig((event) => (event.kind === "frame" ? [send(5)] : []));
    r.loop.enqueue(frame(1));
    drain(r);
    expect(r.sent).toEqual([]);
    expect(sendFailures(r)).toEqual([[sendRef(1), "notDurable"]]);
  });
});

describe("failures the loop turns into inputs or reports (sections 4 and 10)", () => {
  test("a link that refuses a packet: sendFailed with the link's code", () => {
    const r = rig((event) => (event.kind === "frame" ? [send(1700)] : []));
    withDurable(r);
    r.linkFails = "closed";
    r.loop.enqueue(frame(1));
    drain(r);
    expect(sendFailures(r)).toEqual([[sendRef(1), "closed"]]);
  });

  test("a close, an advertisement and the writer's upkeep that fail are reported, and the turn goes on", () => {
    const r = rig((event) =>
      event.kind === "frame"
        ? [
            { kind: "close", link: LINK, reason: "done" },
            { kind: "advertise", identity: new Uint8Array(8), port: 8443 },
          ]
        : [],
    );
    r.writer.maintainFails = true;
    r.loop.enqueue(frame(1));
    drain(r);
    expect(r.reported.map((e) => e.message)).toEqual([
      "already closed",
      "no multicast",
      "checkpoint failed",
    ]);
  });

  test("a fault in the core: the state stays, and the fault is the next turn's first input, for the core to record", () => {
    const r = rig((event) =>
      event.kind === "frame" && event.bytes[0] === 1
        ? coreFault("frame", "core/test", "a bug", { counter: 9 })
        : [],
    );
    r.loop.enqueue(frame(1));
    r.loop.enqueue(frame(2));
    const turn = r.loop.turn();
    expect(turn.faults.map((f) => f.message)).toEqual(["a bug"]);
    expect(r.loop.state).toBe(STATE);
    expect(r.reported.map((e) => e.message)).toEqual(["a bug"]);
    // The loop numbers nothing itself: the record is the audit module's, with the next number.
    expect(r.writer.staged).toEqual([]);
    expect(r.writer.committed).toEqual([]);
    r.loop.turn();
    expect(r.seen.slice(2)).toEqual([
      {
        kind: "inputRejected",
        rejection: {
          source: "core",
          event: "frame",
          origin: "core/test",
          message: "a bug",
          detail: { counter: 9 },
        },
      },
    ]);
  });

  test("a fault on the handed-back fault is reported only: no loop of faults", () => {
    const r = rig(() => coreFault("tick", "core/test", "always"));
    r.loop.enqueue({ kind: "tick" });
    r.loop.turn();
    r.loop.turn();
    expect(r.loop.waiting).toBe(0);
    expect(r.reported).toHaveLength(2);
  });

  test(`more than ${MAX_FAULTS_PER_HOUR} faults within an hour stop the hub`, () => {
    const r = rig((event) =>
      event.kind === "tick" ? coreFault("tick", "core/test", "again") : [],
    );
    for (let i = 0; i <= MAX_FAULTS_PER_HOUR; i++) {
      r.now += 1_000_000;
      r.loop.enqueue({ kind: "tick" });
      r.loop.turn();
    }
    expect(r.fatal.map((e) => e.message)).toEqual([
      `more than ${MAX_FAULTS_PER_HOUR} core faults within an hour`,
    ]);
    r.loop.enqueue({ kind: "tick" });
    expect(r.loop.waiting).toBe(0);
  });

  test("random bytes that fail stop the hub before the step", () => {
    const r = rig(() => []);
    r.randomFails = true;
    r.loop.enqueue(frame(1));
    r.loop.turn();
    expect(r.fatal.map((e) => e.message)).toEqual(["no entropy"]);
    expect(r.seen).toEqual([]);
    r.loop.enqueue(frame(2));
    expect(r.loop.waiting).toBe(0);
  });

  test(`one turn takes at most ${MAX_INPUTS_PER_TURN} inputs, in arrival order`, () => {
    const r = rig(() => []);
    for (let i = 0; i < MAX_INPUTS_PER_TURN + 6; i++) r.loop.enqueue(frame(i));
    expect(r.loop.turn().inputs).toBe(MAX_INPUTS_PER_TURN);
    expect(r.loop.waiting).toBe(6);
    r.loop.turn();
    expect(r.seen.map((e) => (e.kind === "frame" ? e.bytes[0] : -1))).toEqual(
      Array.from({ length: MAX_INPUTS_PER_TURN + 6 }, (_, i) => i),
    );
  });
});

describe("jobs in pieces (m2-design.md section 3, the loop's contract)", () => {
  const UPLOAD = { conn: connId(7), job: 1 };
  const STAGE: FileWork = { kind: "stageUpdate", upload: UPLOAD };
  const EXPORT: FileWork = {
    kind: "export",
    conn: connId(7),
    history: true,
    key: new Uint8Array(32),
    epoch: 1,
  };
  const STAGED: FileOutcome = { kind: "updateStaged", version: "1.2.0" };
  const START = (n: number): HubEvent => ({
    kind: "frame",
    link: LINK,
    bytes: new Uint8Array([0xf0, n]),
  });

  /** A job of `count` pieces, each logged as `name<n>`, ending with `outcome`. */
  function job(
    name: string,
    count: number,
    log: string[],
    outcome: FileOutcome = STAGED,
  ): JobPieces & { aborted: number } {
    let done = 0;
    return {
      aborted: 0,
      next() {
        done += 1;
        log.push(`${name}${done}`);
        return done < count ? { done: false } : { done: true, outcome };
      },
      abort() {
        this.aborted += 1;
        log.push(`${name} aborted`);
      },
    };
  }

  /** A rig whose core starts job `n` on input `START(n)`, with the file jobs given. */
  function jobs(
    started: (n: number) => ReturnType<NonNullable<LoopPorts["files"]>["perform"]>,
    ended: { job: number; outcome: FileOutcome | undefined }[],
    works: readonly FileWork[] = [STAGE, EXPORT],
  ): Rig {
    return rig(
      (event) => {
        if (event.kind !== "frame" || event.bytes[0] !== 0xf0) return [];
        const n = event.bytes[1] ?? 0;
        return [{ kind: "fileJob", job: jobId(n), work: works[(n - 1) % works.length] ?? STAGE }];
      },
      {
        perform: (n) => started(n),
        ended: (n, _work, outcome) => ended.push({ job: n, outcome }),
      },
    );
  }

  const readies = (r: Rig) =>
    r.seen.flatMap((e) =>
      e.kind === "fileReady" ? [[Number(e.job), e.outcome.kind] as const] : [],
    );

  test("an input that comes while a job runs is the next turn's, not the job's end's", () => {
    const log: string[] = [];
    const ended: { job: number; outcome: FileOutcome | undefined }[] = [];
    const r = jobs(() => ({ kind: "pieces", pieces: job("a", 5, log) }), ended);
    r.loop.enqueue(START(1));
    r.loop.turn();
    // The job started after the turn's input, and its first piece ran in that turn.
    expect(log).toEqual(["a1"]);
    expect(r.loop.openJobs).toBe(1);
    const soons = r.soons;
    r.loop.enqueue(frame(9));
    r.loop.turn();
    // The door report (any input) was taken in the very next turn, before the job's next piece.
    expect(r.seen.at(-1)).toEqual(frame(9));
    expect(log).toEqual(["a1", "a2"]);
    // While a job is open the loop asks for another turn, inputs or not.
    expect(r.soons).toBeGreaterThan(soons);
    r.loop.turn();
    r.loop.turn();
    expect(readies(r)).toEqual([]);
    r.loop.turn();
    expect(log).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(r.loop.openJobs).toBe(0);
    // `done` is the job's `fileReady`, the next turn's input; its end frees its upload.
    r.loop.turn();
    expect(readies(r)).toEqual([[1, "updateStaged"]]);
    expect(ended).toEqual([{ job: 1, outcome: STAGED }]);
  });

  test("one piece of each open job a turn, in the order they started; never two of one job in a turn", () => {
    const log: string[] = [];
    const ended: { job: number; outcome: FileOutcome | undefined }[] = [];
    const names = ["a", "b"];
    const r = jobs((n) => ({ kind: "pieces", pieces: job(names[n - 1] ?? "?", 3, log) }), ended);
    r.loop.enqueue(START(1));
    r.loop.turn();
    r.loop.enqueue(START(2));
    r.loop.turn();
    r.loop.turn();
    r.loop.turn();
    expect(log).toEqual(["a1", "a2", "b1", "a3", "b2", "b3"]);
    r.loop.turn();
    expect(readies(r)).toEqual([
      [1, "updateStaged"],
      [2, "updateStaged"],
    ]);
  });

  test("a stop aborts every open job: no fileReady, no more pieces, the upload freed", () => {
    const log: string[] = [];
    const ended: { job: number; outcome: FileOutcome | undefined }[] = [];
    const pieces = job("a", 100, log);
    const r = jobs(() => ({ kind: "pieces", pieces }), ended);
    r.loop.enqueue(START(1));
    r.loop.turn();
    r.loop.turn();
    // The clean stop's order (main.ts): a last turn, then the loop stops.
    r.loop.turn();
    r.loop.stop();
    expect(pieces.aborted).toBe(1);
    expect(r.loop.openJobs).toBe(0);
    r.loop.turn();
    expect(log).toEqual(["a1", "a2", "a3", "a aborted"]);
    expect(readies(r)).toEqual([]);
    expect(ended).toEqual([{ job: 1, outcome: undefined }]);
  });

  test("a job that throws, at its start or in a piece, or that fails, ends as a failed job and frees its upload", () => {
    const log: string[] = [];
    const ended: { job: number; outcome: FileOutcome | undefined }[] = [];
    const failed: FileOutcome = { kind: "failed", reason: "full", message: "the disk is full" };
    // What a library does to a job: a throw (JSON's, standing in for any).
    const breaks = (): never => JSON.parse("{") as never;
    const r = jobs((n) => {
      if (n === 1) return breaks();
      if (n === 2)
        return {
          kind: "pieces",
          pieces: {
            next: () => breaks(),
            abort: () => undefined,
          },
        };
      if (n === 3) return { kind: "pieces", pieces: job("c", 2, log, failed) };
      return { kind: "ready", outcome: failed };
    }, ended);
    for (const n of [1, 2, 3, 4]) r.loop.enqueue(START(n));
    r.loop.turn();
    r.loop.turn();
    r.loop.turn();
    // Started in order; 1 and 4 end at their start, 2 at its first piece in the same turn.
    expect(readies(r)).toEqual([
      [1, "failed"],
      [4, "failed"],
      [2, "failed"],
      [3, "failed"],
    ]);
    expect(ended.map((e) => [e.job, e.outcome?.kind])).toEqual([
      [1, "failed"],
      [4, "failed"],
      [2, "failed"],
      [3, "failed"],
    ]);
    // A throw is reported, and the hub goes on: neither is fatal.
    expect(r.reported.map((e) => e.message.split(":")[0])).toEqual([
      "start file job 1",
      "continue file job 2",
    ]);
    expect(r.fatal).toEqual([]);
    expect(r.loop.openJobs).toBe(0);
  });
});

describe("each turn's own time (section 3's limit per turn)", () => {
  test("a turn says how long it took by the stopwatch; the longest is kept until read, then starts again", () => {
    let nowMs = 100;
    const costs = [3, 12, 5];
    const r = rig(
      () => {
        nowMs += costs.shift() ?? 0;
        return [];
      },
      undefined,
      () => nowMs,
    );
    const durations: number[] = [];
    for (let n = 1; n <= 3; n++) {
      r.loop.enqueue(frame(n));
      durations.push(r.loop.turn().durationMs);
    }
    expect(durations).toEqual([3, 12, 5]);
    expect(r.loop.takeLongestTurnMs()).toBe(12);
    // Read once: the count starts again.
    expect(r.loop.takeLongestTurnMs()).toBe(0);
    r.loop.enqueue(frame(4));
    r.loop.turn();
    expect(r.loop.takeLongestTurnMs()).toBe(0);
  });

  test("without a stopwatch every turn takes 0 ms, as under lockstep", () => {
    const r = rig(() => []);
    r.loop.enqueue(frame(1));
    expect(r.loop.turn().durationMs).toBe(0);
    expect(r.loop.takeLongestTurnMs()).toBe(0);
  });
});

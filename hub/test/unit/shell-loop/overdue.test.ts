/**
 * The loop's guard against a deadline left at or before its time (`shell/loop.ts`, step 6): a core
 * that never clears a deadline, driven through the real `HubLoop` with a test clock and a stand-in
 * for the one system timer. Exactly one turn for the stuck deadline per `HubRules.loop.
 * overdueRetryMs`, one record of it, every other input and every deadline still ahead taken at
 * once, and back to normal the moment it is cleared. Without a stuck deadline, the timer is armed
 * exactly as before. The writer's flush deadline is guarded the same way.
 */
import { nodeSha256 } from "@hsn/protocol";
import { describe, expect, test } from "bun:test";
import { ok, type Result } from "neverthrow";
import type { HubError } from "../../../src/core/model/errors.ts";
import type { HubEvent, Input } from "../../../src/core/model/events.ts";
import { linkId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import type { Timer } from "../../../src/core/model/timers.ts";
import type { Core } from "../../../src/core/step.ts";
import type { CommitInfo, StorageError } from "../../../src/ports/writer.ts";
import { HubLoop, type LoopWriter } from "../../../src/shell/loop.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";

const SECOND = 1_000_000;
const FLOOR = DEFAULT_RULES.loop.overdueRetryMs * 1000;
/** The frame that makes the stand-in core clear its stuck deadline. */
const CLEAR = 0xff;

/** What the stand-in core keeps: a stuck deadline, and one ahead that runs when due. */
interface Slice {
  readonly stuck: Mono | undefined;
  readonly ahead: Mono | undefined;
}

const STUCK_KEY = { module: "alarm", kind: "alarmEnd" } as const;
const AHEAD_KEY = { module: "sirens", kind: "reportNowWindow" } as const;

function sliceOf(state: HubState): Slice {
  return state as unknown as Slice;
}

/** A core whose `alarm` never clears its deadline until a frame starting 0xff comes. */
function stuckCore(steps: { readonly at: number; readonly kind: HubEvent["kind"] }[]): Core {
  const deadlines = (state: HubState): readonly Timer[] => {
    const { stuck, ahead } = sliceOf(state);
    return [
      ...(stuck === undefined ? [] : [{ at: stuck, key: STUCK_KEY }]),
      ...(ahead === undefined ? [] : [{ at: ahead, key: AHEAD_KEY }]),
    ];
  };
  return {
    emptyState: () => ({ stuck: undefined, ahead: undefined }) as unknown as HubState,
    deadlines,
    nextDeadline: (state) => {
      const all = deadlines(state).map((t) => t.at);
      return all.length === 0 ? undefined : mono(Math.min(...all));
    },
    step: (state: HubState, input: Input) => {
      const { event, now } = input;
      steps.push({ at: now.mono, kind: event.kind });
      const slice = sliceOf(state);
      const cleared = event.kind === "frame" && event.bytes[0] === CLEAR;
      const next: Slice = {
        // The fault: a due deadline left as it is.
        stuck: cleared ? undefined : slice.stuck,
        // A well-behaved one: taken away when it has run.
        ahead: slice.ahead !== undefined && slice.ahead <= now.mono ? undefined : slice.ahead,
      };
      return ok({ state: next as unknown as HubState, effects: [], wake: undefined });
    },
  };
}

/** A writer with nothing to flush, or one whose deadline is always now (`stuckDue`). */
class QuietWriter implements LoopWriter {
  stuckDue = false;
  stage(): void {
    // Nothing is staged by the stand-in core.
  }
  setCadence(): void {
    // No countdown.
  }
  durable(): number | undefined {
    return undefined;
  }
  due(now: Mono): Mono | undefined {
    return this.stuckDue ? now : undefined;
  }
  flushIfDue(): Result<(CommitInfo & { readonly committed: boolean }) | undefined, StorageError> {
    return ok(undefined);
  }
  flush(): Result<CommitInfo & { readonly committed: boolean }, StorageError> {
    return ok({ items: 0, durationMs: 0, committed: false });
  }
  takeOutcome(): undefined {
    return undefined;
  }
  maintain(): Result<void, StorageError> {
    return ok(undefined);
  }
}

/**
 * The real loop, a test clock, and the shell's one timer standing in: `run(to)` takes every input
 * waiting at once (as `soon` does), and a `tick` when the armed timer comes, as `wakeAt` does.
 */
class Rig {
  now = 0;
  armed: Mono | undefined;
  readonly arms: (Mono | undefined)[] = [];
  readonly steps: { readonly at: number; readonly kind: HubEvent["kind"] }[] = [];
  readonly reported: HubError[] = [];
  readonly ticksAt: number[] = [];
  readonly writer = new QuietWriter();
  readonly loop: HubLoop;

  constructor(initial: Slice) {
    const core = stuckCore(this.steps);
    this.loop = new HubLoop(
      core,
      {
        cipher: VectorCipher.fromVectors(),
        rules: DEFAULT_RULES,
        calendar: UNBUILT_CALENDAR,
        sha256: nodeSha256,
      },
      {
        clock: {
          now: () => ({ mono: mono(this.now), wall: 1_800_000_000_000, wallTrusted: true }),
        },
        random: { bytes: (length) => ok(new Uint8Array(length)) },
        links: { listen: () => undefined, send: () => ok(undefined), close: () => ok(undefined) },
        control: { respond: () => undefined, publish: () => undefined },
        writer: this.writer,
        advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
        wakeAt: (at) => {
          this.armed = at;
          this.arms.push(at);
        },
        soon: () => undefined,
        report: (error) => this.reported.push(error),
        fatal: (error) => this.reported.push(error),
      },
      initial as unknown as HubState,
    );
  }

  /** An input at the present time, taken at once. */
  input(event: HubEvent): void {
    this.loop.enqueue(event);
    this.#drain();
  }

  /** Time passes to `to`: every armed timer that comes on the way runs its turn. */
  run(to: number): void {
    for (let rounds = 0; rounds < 10_000; rounds++) {
      this.#drain();
      const armed = this.armed;
      if (armed === undefined || armed > to) break;
      this.now = Math.max(this.now, armed);
      this.armed = undefined;
      this.ticksAt.push(this.now);
      this.loop.enqueue({ kind: "tick" });
    }
    this.#drain();
    this.now = to;
  }

  /** Every waiting input, in turns, bounded: inputs never keep making inputs here. */
  #drain(): void {
    for (let turns = 0; this.loop.waiting > 0 && turns < 100; turns++) this.loop.turn();
    expect(this.loop.waiting).toBe(0);
  }
}

function rig(initial: Slice): Rig {
  return new Rig(initial);
}

const frame = (first: number): HubEvent => ({
  kind: "frame",
  link: linkId(1),
  bytes: new Uint8Array([first, 0, 0]),
});

describe("a deadline left at or before its time", () => {
  test("gets one turn per floor, not one at once for ever, and one record", () => {
    const r = rig({ stuck: mono(1_000), ahead: undefined });
    r.now = 2_000;
    r.input({ kind: "tick" });
    r.run(10 * SECOND);
    // One turn for it a floor apart: never sooner, never more.
    expect(r.ticksAt).toEqual(Array.from({ length: 9 }, (_, i) => 2_000 + (i + 1) * FLOOR));
    expect(r.steps.filter((s) => s.kind === "tick")).toHaveLength(10);
    // One record: the core's fault record, critical, naming the module and the timer.
    const recorded = r.steps.filter((s) => s.kind === "inputRejected");
    expect(recorded).toHaveLength(1);
    expect(r.loop.overdue).toEqual([
      { owner: "alarm", timer: JSON.stringify(STUCK_KEY), at: mono(1_000), by: mono(2_000) },
    ]);
    expect(r.reported).toHaveLength(1);
    expect(r.reported[0]?.message).toContain('alarm {"module":"alarm","kind":"alarmEnd"}');
  });

  test("the record is a core fault the audit module records as critical, with what is stuck", () => {
    const steps: { at: number; kind: HubEvent["kind"] }[] = [];
    const inputs: HubEvent[] = [];
    const core = stuckCore(steps);
    const step = core.step;
    const seen: Core = {
      ...core,
      step: (state, input, deps) => {
        inputs.push(input.event);
        return step(state, input, deps);
      },
    };
    const loop = new HubLoop(
      seen,
      {
        cipher: VectorCipher.fromVectors(),
        rules: DEFAULT_RULES,
        calendar: UNBUILT_CALENDAR,
        sha256: nodeSha256,
      },
      {
        clock: { now: () => ({ mono: mono(5_000), wall: 1, wallTrusted: true }) },
        random: { bytes: (length) => ok(new Uint8Array(length)) },
        links: { listen: () => undefined, send: () => ok(undefined), close: () => ok(undefined) },
        control: { respond: () => undefined, publish: () => undefined },
        writer: new QuietWriter(),
        advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
        wakeAt: () => undefined,
        soon: () => undefined,
        report: () => undefined,
        fatal: () => undefined,
      },
      { stuck: mono(5_000), ahead: undefined } as unknown as HubState,
    );
    loop.enqueue({ kind: "tick" });
    loop.turn();
    loop.turn();
    expect(inputs[1]).toEqual({
      kind: "inputRejected",
      rejection: {
        source: "core",
        event: "tick",
        origin: "core/alarm",
        message:
          'a deadline was left at or before its time: alarm {"module":"alarm","kind":"alarmEnd"}; ' +
          `turns for it at most every ${String(DEFAULT_RULES.loop.overdueRetryMs)} ms until it moves`,
        detail: {
          owner: "alarm",
          timer: JSON.stringify(STUCK_KEY),
          at: 5_000,
          by: 5_000,
          stuck: 1,
        },
      },
    });
  });

  test("every other input is taken at once in between, and the floor's turns keep their times", () => {
    const r = rig({ stuck: mono(1_000), ahead: undefined });
    r.now = 2_000;
    r.input({ kind: "tick" });
    r.run(SECOND / 2);
    r.input(frame(1));
    r.run(SECOND / 2 + 1_000);
    r.input(frame(2));
    r.run(3 * SECOND);
    const frames = r.steps.filter((s) => s.kind === "frame").map((s) => s.at);
    expect(frames).toEqual([SECOND / 2, SECOND / 2 + 1_000]);
    expect(r.ticksAt).toEqual([2_000 + FLOOR, 2_000 + 2 * FLOOR]);
    expect(r.steps.filter((s) => s.kind === "inputRejected")).toHaveLength(1);
  });

  test("a deadline still ahead runs at its time, never held back by the floor", () => {
    const ahead = mono(300_000);
    const r = rig({ stuck: mono(1_000), ahead });
    r.now = 2_000;
    r.input({ kind: "tick" });
    expect(r.armed).toBe(ahead);
    r.run(2 * SECOND);
    expect(r.ticksAt).toEqual([300_000, 2_000 + FLOOR]);
  });

  test("back to normal at the first turn that leaves none; a new occurrence is recorded again", () => {
    const r = rig({ stuck: mono(1_000), ahead: undefined });
    r.now = 2_000;
    r.input({ kind: "tick" });
    r.run(1_500_000);
    r.input(frame(CLEAR));
    expect(r.armed).toBeUndefined();
    const ticks = r.ticksAt.length;
    r.run(10 * SECOND);
    expect(r.ticksAt).toHaveLength(ticks);
    expect(r.loop.overdue).toHaveLength(1);
  });

  test("without a stuck deadline the timer is armed exactly as before: nextWake", () => {
    const r = rig({ stuck: undefined, ahead: mono(700_000) });
    r.input({ kind: "tick" });
    expect(r.arms).toEqual([mono(700_000)]);
    expect(r.loop.nextWake()).toBe(mono(700_000));
    r.run(SECOND);
    expect(r.ticksAt).toEqual([700_000]);
    expect(r.arms.at(-1)).toBeUndefined();
    expect(r.loop.overdue).toEqual([]);
    expect(r.reported).toEqual([]);
  });

  test("the writer's flush deadline left at now is guarded the same way", () => {
    const r = rig({ stuck: undefined, ahead: undefined });
    r.writer.stuckDue = true;
    r.now = 10_000;
    r.input({ kind: "tick" });
    r.run(3 * SECOND);
    expect(r.ticksAt).toEqual([10_000 + FLOOR, 10_000 + 2 * FLOOR]);
    expect(r.loop.overdue[0]).toEqual({
      owner: "writer",
      timer: "due",
      at: mono(10_000),
      by: mono(10_000),
    });
    expect(r.steps.filter((s) => s.kind === "inputRejected")).toHaveLength(1);
  });
});

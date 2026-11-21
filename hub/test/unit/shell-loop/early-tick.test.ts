/**
 * The loop's guard (`shell/loop.ts`, step 6) and a writer deadline that comes due during a turn.
 * The tick armed for the writer's flush can come a fraction of a millisecond early (hosted M4,
 * runs 44915295655 and 44915297850: 0.29 to 0.41 ms): step 3 finds the flush not yet due, and by
 * step 6 it is. That is not a stuck deadline: the timer is armed for it, the next turn flushes at
 * its time, and nothing is recorded. A writer due when step 3 asked and still due after is stuck,
 * as before (`overdue.test.ts`).
 *
 * The clock moves on 100 µs at each reading, as real time does while a turn runs.
 */
import { nodeSha256 } from "@hsn/protocol";
import { describe, expect, test } from "bun:test";
import { ok, type Result } from "neverthrow";
import type { HubError } from "../../../src/core/model/errors.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import type { Core } from "../../../src/core/step.ts";
import type { CommitInfo, StorageError } from "../../../src/ports/writer.ts";
import { HubLoop, type LoopWriter } from "../../../src/shell/loop.ts";
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";

/** The writer's routine flush deadline, in µs. */
const DUE = 1_000_000;
const STEP_US = 100;

type Commit = (CommitInfo & { readonly committed: boolean }) | undefined;

/** A writer with one batch due at `DUE`: flushed when asked at or after it, or never (`stuck`). */
class DueWriter implements LoopWriter {
  readonly flushedAt: number[] = [];
  #pending = true;
  constructor(readonly stuck = false) {}
  stage(): void {
    // The stand-in core stages nothing.
  }
  setCadence(): void {
    // No countdown.
  }
  durable(): number | undefined {
    return undefined;
  }
  due(): Mono | undefined {
    return this.#pending ? mono(DUE) : undefined;
  }
  flushIfDue(now: Mono): Result<Commit, StorageError> {
    if (!this.#pending || now < DUE) return ok(undefined);
    this.flushedAt.push(now);
    if (!this.stuck) this.#pending = false;
    return ok({ items: 1, durationMs: 0, committed: true });
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

/** A core with no deadlines of its own. */
const QUIET_CORE = {
  emptyState: () => ({}) as HubState,
  deadlines: () => [],
  nextDeadline: () => undefined,
  step: (state: HubState) => ok({ state, effects: [], wake: undefined }),
} as unknown as Core;

function loopFrom(startUs: number, writer: DueWriter) {
  const clock = { now: startUs };
  const arms: (Mono | undefined)[] = [];
  const reported: HubError[] = [];
  const loop = new HubLoop(
    QUIET_CORE,
    {
      cipher: VectorCipher.fromVectors(),
      rules: DEFAULT_RULES,
      calendar: UNBUILT_CALENDAR,
      sha256: nodeSha256,
    },
    {
      clock: {
        now: () => {
          clock.now += STEP_US;
          return { mono: mono(clock.now), wall: 1_800_000_000_000, wallTrusted: true };
        },
      },
      random: { bytes: (length) => ok(new Uint8Array(length)) },
      links: { listen: () => undefined, send: () => ok(undefined), close: () => ok(undefined) },
      control: { respond: () => undefined, publish: () => undefined },
      writer,
      advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
      wakeAt: (at) => arms.push(at),
      soon: () => undefined,
      report: (error) => reported.push(error),
      fatal: (error) => reported.push(error),
    },
    {} as HubState,
  );
  /** A tick's turn, with the clock at `atUs` when it starts. */
  const tick = (atUs: number): void => {
    clock.now = Math.max(clock.now, atUs);
    loop.enqueue({ kind: "tick" });
    loop.turn();
  };
  return { loop, arms, reported, tick, clock };
}

describe("a writer deadline that comes due during a turn", () => {
  test("a tick 0.3 ms early: no fault, the timer armed for the deadline, the flush at its time on the next turn", () => {
    const writer = new DueWriter();
    const r = loopFrom(0, writer);
    r.tick(DUE - 300);
    // Not due when step 3 asked; due by step 6: not stuck, nothing recorded or reported.
    expect(writer.flushedAt).toEqual([]);
    expect(r.loop.overdue).toEqual([]);
    expect(r.reported).toEqual([]);
    expect(r.loop.waiting).toBe(0);
    // The timer is armed for the deadline itself, not a retry a floor later.
    expect(r.arms.at(-1)).toBe(mono(DUE));
    // Its tick: the flush, at its time.
    r.tick(DUE);
    expect(writer.flushedAt).toHaveLength(1);
    expect(writer.flushedAt[0]).toBeGreaterThanOrEqual(DUE);
    expect(writer.flushedAt[0]).toBeLessThan(DUE + 1000);
    expect(r.loop.overdue).toEqual([]);
    expect(r.reported).toEqual([]);
    expect(r.arms.at(-1)).toBeUndefined();
  });

  test("a writer due when step 3 asks is flushed, and nothing is recorded", () => {
    const writer = new DueWriter();
    const r = loopFrom(0, writer);
    r.tick(DUE + 50);
    expect(writer.flushedAt).toHaveLength(1);
    expect(r.loop.overdue).toEqual([]);
    expect(r.reported).toEqual([]);
  });

  test("a writer due when step 3 asked and still due after is stuck, recorded once, as before", () => {
    const writer = new DueWriter(true);
    const r = loopFrom(0, writer);
    r.tick(DUE + 50);
    expect(r.loop.overdue).toHaveLength(1);
    expect(r.loop.overdue[0]).toMatchObject({ owner: "writer", timer: "due", at: mono(DUE) });
    expect(r.reported).toHaveLength(1);
    expect(r.reported[0]?.message).toContain(
      "a deadline was left at or before its time: writer due",
    );
    // Its next turn comes a floor later, not at once.
    const retry = r.arms.at(-1) ?? mono(0);
    expect(retry).toBeGreaterThanOrEqual(
      r.clock.now + DEFAULT_RULES.loop.overdueRetryMs * 1000 - 1000,
    );
  });
});

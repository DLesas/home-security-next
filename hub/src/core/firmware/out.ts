/**
 * What firmware's rules build a step from: the slice, the messages and effects so far, and its
 * timers as data (hub-design.md section 2, "Timers"), as upkeep's `Steps` does.
 */
import { err, ok, type Result } from "neverthrow";
import type { AppErrorV2 } from "@hsn/protocol/app";
import type { Effect } from "../model/effects.ts";
import { coreFault, type CoreFault } from "../model/errors.ts";
import type { Context, Handled } from "../model/handler.ts";
import { JOB_RANGES, jobId, type JobId } from "../model/ids.ts";
import type { AnswerTo, Internal } from "../model/messages.ts";
import type { Mono } from "../model/time.ts";
import type { TimerKeyOf } from "../model/timers.ts";
import type { FirmwareSlice } from "./state.ts";

export type Out = Internal | Effect;
export type Step = Result<Handled<"firmware">, CoreFault>;
export type FirmwareTimerKey = TimerKeyOf<"firmware">;

export const ORIGIN = "core/firmware";

export function fault(ctx: Context, message: string): CoreFault {
  return coreFault(ctx.event, ORIGIN, message);
}

/** Two timer keys name the same timer: the same kind, for the same device or rollout. */
function sameTimer(a: FirmwareTimerKey, b: FirmwareTimerKey): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "soakEnd" && b.kind === "soakEnd") return a.rollout === b.rollout;
  if (a.kind !== "soakEnd" && b.kind !== "soakEnd") return a.device === b.device;
  return false;
}

/** Collects one step's output in order; a record that cannot take a number fails the step. */
export class Steps {
  #slice: FirmwareSlice;
  readonly #out: Out[] = [];
  #failed: CoreFault | undefined;

  constructor(slice: FirmwareSlice) {
    this.#slice = slice;
  }

  get slice(): FirmwareSlice {
    return this.#slice;
  }

  set(slice: FirmwareSlice): void {
    this.#slice = slice;
  }

  push(...out: readonly Out[]): void {
    this.#out.push(...out);
  }

  /** A record or other message that may fail to take a sequence number. */
  pushResult(made: Result<Out, CoreFault>): void {
    if (made.isErr()) this.#failed ??= made.error;
    else this.#out.push(made.value);
  }

  fail(error: CoreFault): void {
    this.#failed ??= error;
  }

  /** A new job number, in firmware's own range (`JOB_RANGES.firmware`), wrapping within it. */
  job(): JobId {
    const range = JOB_RANGES.firmware;
    const n = this.#slice.nextJob;
    const job = jobId(n >= range.first && n <= range.last ? n : range.first);
    this.#slice = { ...this.#slice, nextJob: job === range.last ? range.first : job + 1 };
    return job;
  }

  answer(answerTo: AnswerTo, body: unknown): void {
    this.#out.push({ kind: "opAnswer", answerTo, outcome: { ok: true, body } });
  }

  refuse(answerTo: AnswerTo, error: AppErrorV2): void {
    this.#out.push({
      kind: "opAnswer",
      answerTo,
      outcome: { ok: false, error },
    });
  }

  /** Sets this timer to `at`, replacing one with the same key. */
  timer(key: FirmwareTimerKey, at: Mono): void {
    const timers = this.#slice.timers.filter((t) => !sameTimer(t.key, key));
    this.#slice = { ...this.#slice, timers: [...timers, { at, key }] };
  }

  clear(key: FirmwareTimerKey): void {
    if (!this.has(key)) return;
    this.#slice = {
      ...this.#slice,
      timers: this.#slice.timers.filter((t) => !sameTimer(t.key, key)),
    };
  }

  has(key: FirmwareTimerKey): boolean {
    return this.#slice.timers.some((t) => sameTimer(t.key, key));
  }

  timerAt(key: FirmwareTimerKey): Mono | undefined {
    return this.#slice.timers.find((t) => sameTimer(t.key, key))?.at;
  }

  done(): Step {
    return this.#failed === undefined
      ? ok({ slice: this.#slice, out: this.#out })
      : err(this.#failed);
  }
}

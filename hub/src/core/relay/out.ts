/**
 * What the relay module's rules build a step from: the slice, the messages and effects so far,
 * and its timers as data (hub-design.md section 2, "Timers"), as firmware's `Steps` does.
 */
import { err, ok, type Result } from "neverthrow";
import type { AppErrorV2 } from "@hsn/protocol/app";
import type { Effect } from "../model/effects.ts";
import { coreFault, type CoreFault } from "../model/errors.ts";
import type { Context, Handled } from "../model/handler.ts";
import type { AnswerTo, Internal } from "../model/messages.ts";
import type { Mono } from "../model/time.ts";
import type { TimerKeyOf } from "../model/timers.ts";
import type { RelaySlice } from "./state.ts";

export type Out = Internal | Effect;
export type Step = Result<Handled<"relay">, CoreFault>;
export type RelayTimerKey = TimerKeyOf<"relay">;

export const ORIGIN = "core/relay";

export function fault(ctx: Context, message: string): CoreFault {
  return coreFault(ctx.event, ORIGIN, message);
}

/** Two timer keys name the same timer: the same kind, and for `pushRetry` the same row. */
function sameTimer(a: RelayTimerKey, b: RelayTimerKey): boolean {
  if (a.kind === "pushRetry" && b.kind === "pushRetry") return a.id === b.id;
  return a.kind === b.kind;
}

/** Collects one step's output in order; a record that cannot take a number fails the step. */
export class Steps {
  #slice: RelaySlice;
  readonly #out: Out[] = [];
  #failed: CoreFault | undefined;

  constructor(slice: RelaySlice) {
    this.#slice = slice;
  }

  get slice(): RelaySlice {
    return this.#slice;
  }

  set(slice: RelaySlice): void {
    this.#slice = slice;
  }

  /** Changes the slice by a function of it. */
  update(change: (slice: RelaySlice) => RelaySlice): void {
    this.#slice = change(this.#slice);
  }

  push(...out: readonly Out[]): void {
    this.#out.push(...out);
  }

  /** A record or other message that may fail to take a sequence number. */
  pushResult(made: Result<Out, CoreFault>): void {
    if (made.isErr()) this.#failed ??= made.error;
    else this.#out.push(made.value);
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
  timer(key: RelayTimerKey, at: Mono): void {
    const timers = this.#slice.timers.filter((t) => !sameTimer(t.key, key));
    this.#slice = { ...this.#slice, timers: [...timers, { at, key }] };
  }

  clear(key: RelayTimerKey): void {
    if (!this.has(key)) return;
    this.#slice = {
      ...this.#slice,
      timers: this.#slice.timers.filter((t) => !sameTimer(t.key, key)),
    };
  }

  /** Clears every timer of one kind (every `pushRetry`, for instance). */
  clearKind(kind: RelayTimerKey["kind"]): void {
    if (!this.#slice.timers.some((t) => t.key.kind === kind)) return;
    this.#slice = {
      ...this.#slice,
      timers: this.#slice.timers.filter((t) => t.key.kind !== kind),
    };
  }

  timerAt(key: RelayTimerKey): Mono | undefined {
    return this.#slice.timers.find((t) => sameTimer(t.key, key))?.at;
  }

  has(key: RelayTimerKey): boolean {
    return this.#slice.timers.some((t) => sameTimer(t.key, key));
  }

  done(): Step {
    return this.#failed === undefined
      ? ok({ slice: this.#slice, out: this.#out })
      : err(this.#failed);
  }
}

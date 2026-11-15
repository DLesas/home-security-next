/**
 * What upkeep's rules build a step from: the slice, the messages and effects so far, and its
 * timers as data (hub-design.md section 2, "Timers").
 */
import { err, ok, type Result } from "neverthrow";
import type { AppError } from "@hsn/protocol/app";
import type { Effect } from "../model/effects.ts";
import { coreFault, type CoreFault } from "../model/errors.ts";
import type { FileFailure, FileOutcome } from "../model/events.ts";
import type { Context, Handled } from "../model/handler.ts";
import { jobId, type JobId } from "../model/ids.ts";
import type { AnswerTo, Internal } from "../model/messages.ts";
import type { UploadRef } from "../model/effects.ts";
import { type Mono, monoAfterMs } from "../model/time.ts";
import type { TimerKeyOf } from "../model/timers.ts";
import type { UpkeepSlice } from "./state.ts";

export type Out = Internal | Effect;
export type Step = Result<Handled<"upkeep">, CoreFault>;
export type UpkeepTimerKind = TimerKeyOf<"upkeep">["kind"];

export const ORIGIN = "core/upkeep";

/** A step that changes nothing. */
export function unchanged(slice: UpkeepSlice): Step {
  return ok({ slice, out: [] });
}

export function fault(ctx: Context, message: string): CoreFault {
  return coreFault(ctx.event, ORIGIN, message);
}

/** Collects one step's output in order; a record that cannot take a number fails the step. */
export class Steps {
  #slice: UpkeepSlice;
  readonly #out: Out[] = [];
  #failed: CoreFault | undefined;

  constructor(slice: UpkeepSlice) {
    this.#slice = slice;
  }

  get slice(): UpkeepSlice {
    return this.#slice;
  }

  set(slice: UpkeepSlice): void {
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

  /** A new job number. */
  job(): JobId {
    const job = jobId(this.#slice.nextJob);
    this.#slice = { ...this.#slice, nextJob: this.#slice.nextJob + 1 };
    return job;
  }

  answer(answerTo: AnswerTo, body: unknown): void {
    this.#out.push({ kind: "opAnswer", answerTo, outcome: { ok: true, body } });
  }

  refuse(answerTo: AnswerTo, error: AppError): void {
    this.#out.push({ kind: "opAnswer", answerTo, outcome: { ok: false, error } });
  }

  /** Sets the module's timer of this kind to `at`, replacing any. */
  timer(key: TimerKeyOf<"upkeep">, at: Mono): void {
    const timers = this.#slice.timers.filter((t) => t.key.kind !== key.kind);
    this.#slice = { ...this.#slice, timers: [...timers, { at, key }] };
  }

  /** The timer of this kind `ms` after now, replacing any. */
  timerAfter(ctx: Context, kind: UpkeepTimerKind, ms: number): void {
    this.timer({ module: "upkeep", kind }, monoAfterMs(ctx.now.mono, Math.max(0, ms)));
  }

  clear(kind: UpkeepTimerKind): void {
    this.#slice = { ...this.#slice, timers: this.#slice.timers.filter((t) => t.key.kind !== kind) };
  }

  has(kind: UpkeepTimerKind): boolean {
    return this.#slice.timers.some((t) => t.key.kind === kind);
  }

  done(): Step {
    return this.#failed === undefined
      ? ok({ slice: this.#slice, out: this.#out })
      : err(this.#failed);
  }
}

/** `invalid {field, reason}`. */
export function invalid(
  field: string,
  reason: Extract<AppError, { readonly code: "invalid" }>["detail"]["reason"],
): AppError {
  return { code: "invalid", detail: { field, reason } };
}

/** `busy {because}`. */
export function busy(
  because: Extract<AppError, { readonly code: "busy" }>["detail"]["because"],
): AppError {
  return { code: "busy", detail: { because } };
}

export const UNAVAILABLE: AppError = { code: "unavailable", detail: {} };

type InvalidReason = Extract<AppError, { readonly code: "invalid" }>["detail"]["reason"];

/**
 * What a request whose file job did not come to its outcome is answered (section 5's table): a
 * missing upload `notFound {what: "upload", id}`, a bad file `invalid {field: "job", reason}` as
 * `invalidFor` names it, anything else `unavailable`.
 */
export function fileRefusal(
  outcome: FileOutcome,
  upload: UploadRef,
  invalidFor: Partial<Record<FileFailure, InvalidReason>>,
): AppError {
  if (outcome.kind !== "failed") return UNAVAILABLE;
  if (outcome.reason === "noUpload") {
    return { code: "notFound", detail: { what: "upload", id: upload.job } };
  }
  const reason = invalidFor[outcome.reason];
  return reason === undefined ? UNAVAILABLE : invalid("job", reason);
}

/** The upload a request names, on an app's or `hsn`'s connection; a schedule names none. */
export function uploadOf(answerTo: AnswerTo, job: number): UploadRef | undefined {
  return answerTo.kind === "schedule" ? undefined : { conn: answerTo.conn, job };
}

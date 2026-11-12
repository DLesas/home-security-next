/**
 * The sender's counter with resume points (section 4). Pure logic: the caller stores the
 * resume point and must save it before sending with the counter that asked for it.
 */
import { MAX_U32 } from "../bytes.ts";
import { isValidCounter } from "../packet/header.ts";
import { fail, ok, type Result } from "../result.ts";

/** How many counters each saved resume point covers. */
export const ResumeStep = { Sensor: 64, SirenOrGateway: 1024, Hub: 1024 } as const;
export type ResumeStep = (typeof ResumeStep)[keyof typeof ResumeStep];

/** How far a restored hub moves every sending counter forward (O16). */
export const RESTORE_COUNTER_JUMP = 2 ** 24;

export interface SendCounter {
  readonly step: ResumeStep;
  /** The counter the next packet will use. */
  readonly next: number;
  /** The value last saved; after a power loss, sending continues from here. */
  readonly resumePoint: number;
}

/** The state at pairing: counters start at 1 and the saved resume point is one step (section 4). */
export function newSendCounter(step: ResumeStep): SendCounter {
  return { step, next: 1, resumePoint: step };
}

/** The state after a power loss or restart: continue from the saved resume point. */
export function resumeSendCounter(step: ResumeStep, resumePoint: number): SendCounter {
  if (!isValidCounter(resumePoint)) throw new RangeError("resume point must be a valid counter");
  return { step, next: resumePoint, resumePoint };
}

/**
 * The hub's state after restoring a backup: the backup's resume point moved forward by 2²⁴, so
 * no counter used since the backup is used again.
 */
export function restoreSendCounter(
  step: ResumeStep,
  backedUpResumePoint: number,
): Result<SendCounter> {
  if (!isValidCounter(backedUpResumePoint)) {
    throw new RangeError("resume point must be a valid counter");
  }
  const resumePoint = backedUpResumePoint + RESTORE_COUNTER_JUMP;
  if (resumePoint > MAX_U32) return fail("counterExhausted");
  return ok(resumeSendCounter(step, resumePoint));
}

export interface TakenCounter {
  /** The counter to send with. */
  readonly counter: number;
  /** The state to keep for the next packet. */
  readonly state: SendCounter;
  /** When set, save this as the resume point before sending. */
  readonly saveResumePoint: number | undefined;
}

/**
 * Takes the next counter. Before a counter that is a multiple of the step, asks the caller to
 * save counter + step. Stops for good when that resume point would pass 2³² − 1 (section 4).
 */
export function takeSendCounter(state: SendCounter): Result<TakenCounter> {
  const { step, next: counter, resumePoint } = state;
  if (!isValidCounter(counter)) return fail("counterExhausted");
  if (counter % step !== 0) {
    return ok({
      counter,
      state: { step, next: counter + 1, resumePoint },
      saveResumePoint: undefined,
    });
  }
  const newResumePoint = counter + step;
  if (newResumePoint > MAX_U32) return fail("counterExhausted");
  return ok({
    counter,
    state: { step, next: counter + 1, resumePoint: newResumePoint },
    saveResumePoint: newResumePoint,
  });
}

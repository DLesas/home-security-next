/**
 * A file job's worker side (D145; the loop's side is `job.ts`): the job's own pieces, the same
 * class the loop would run, called one after another on the worker's thread until it ends, so the
 * work per piece and every outcome and refusal are what they were on the loop. Before every piece
 * the worker looks at the loop's word (`control.ts`): a stop ends the job (`abort`, which removes
 * what it wrote), and so does a cancel, whose outcome the loop makes itself. Then it marks itself
 * ended, wakes a stop that waits for it, and posts the outcome, its one message. It never touches
 * `hub.db`.
 */
import type { FileOutcome } from "../../core/model/events.ts";
import { JOB_CANCEL, JOB_STOP, type JobControl } from "./control.ts";

/** What a stop ends a job with. */
export const STOPPING = "the hub is stopping";

/**
 * What a cancel ends a job with, on the worker. Never the outcome the core sees: the loop's side
 * makes a cancelled job's outcome itself, with its kind's message (`job.ts`, `cancel`), whatever
 * the worker ended with.
 */
export const CANCELLING = "cancelled";

/** A job in pieces, as the loop would run it. */
export interface WorkerPieces {
  next(): FileOutcome | undefined;
  /** Ends the job now, what it wrote removed. */
  abort(message: string): FileOutcome;
}

/** The worker's one message: the outcome, once the job has ended. */
export interface WorkerReply {
  readonly kind: "ended";
  readonly outcome: FileOutcome;
}

/** Runs `job` to its end on this thread, then marks `control` and posts the outcome. */
export function serveJob(
  port: { postMessage(reply: WorkerReply): void },
  control: JobControl,
  job: WorkerPieces,
): void {
  let outcome: FileOutcome | undefined;
  while (outcome === undefined) {
    const word = Atomics.load(control, 0);
    outcome =
      word === JOB_STOP
        ? job.abort(STOPPING)
        : word === JOB_CANCEL
          ? job.abort(CANCELLING)
          : job.next();
  }
  Atomics.store(control, 1, 1);
  Atomics.notify(control, 1);
  port.postMessage({ kind: "ended", outcome });
}

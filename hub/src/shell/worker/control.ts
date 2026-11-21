/**
 * The word a file job's loop side and its worker share (`job.ts`, `serve.ts`): two shared 32-bit
 * words, `[0]` what the loop asks (`JOB_RUN`, `JOB_CANCEL`, `JOB_STOP`), `[1]` 1 once the worker
 * has ended, what it wrote removed if it failed or was ended. The loop writes the first, the
 * worker the second.
 */

/** Go on. */
export const JOB_RUN = 0;
/** The core no longer wants the job: end it as a cancel, before the next piece. */
export const JOB_CANCEL = 1;
/** The hub is stopping: end it now. */
export const JOB_STOP = 2;

export type JobControl = Int32Array<SharedArrayBuffer>;

export function jobControl(): JobControl {
  return new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
}

/**
 * Staging's worker side (the product owner's ruling of 2026-11-20: staging a hub update runs in a
 * worker thread, off the loop, because on Windows one file create or close can wait for hundreds
 * of milliseconds, which on the loop is a door report's wait). The release is staged by `Staging`
 * (`stage.ts`), unchanged, a bounded piece after another on the worker's own thread, so the work
 * per piece and every outcome and refusal are what they were on the loop.
 *
 * Between pieces the worker looks at the word the loop sets (`StagingControl`): a cancel (the core
 * no longer wants this staging, `wanted`) or a stop ends it through `Staging`, which removes its
 * folder. Then it marks itself ended, wakes a stop that waits for it, and posts the outcome. It
 * never touches `hub.db`, and nothing it does reaches the core but that one outcome.
 */
import { Staging, type StageInputs } from "./stage.ts";
import { JOB_CANCEL, JOB_RUN, JOB_STOP, type JobControl, jobControl } from "../worker/control.ts";
import { serveJob, type WorkerReply } from "../worker/serve.ts";

/** The loop's word to the worker, `control[0]`: go on, the core no longer wants it, or a stop. */
export const STAGING_RUN = JOB_RUN;
export const STAGING_CANCEL = JOB_CANCEL;
export const STAGING_STOP = JOB_STOP;

/** A cancel's outcome message, as `Staging` ends a staging the core no longer wants. */
export const STAGING_CANCELLED = "staging was cancelled";

/** The word the loop and the worker share (`worker/control.ts`). */
export type StagingControl = JobControl;

export function stagingControl(): StagingControl {
  return jobControl();
}

/** What the worker is started with: staging's inputs but `wanted`, which is the control word. */
export interface StagingWorkerData {
  readonly inputs: Omit<StageInputs, "wanted">;
  readonly control: StagingControl;
}

/** The worker's one message: the outcome, once staging has ended. */
export type StagingReply = WorkerReply;

/**
 * Stages to the end on this thread, then marks the control word and posts the outcome
 * (`worker/serve.ts`): a cancel, looked at before every piece, ends it as `Staging` ends one the
 * core no longer wants ("staging was cancelled", its folder removed).
 */
export function serveStaging(
  port: { postMessage(reply: StagingReply): void },
  data: StagingWorkerData,
): void {
  serveJob(port, data.control, new Staging(data.inputs), STAGING_CANCELLED);
}

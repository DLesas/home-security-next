/**
 * Staging's worker side (the product owner's ruling of 2026-11-20: staging a hub update runs in a
 * worker thread, off the loop, because on Windows one file create or close can wait for hundreds
 * of milliseconds, which on the loop is a door report's wait). The release is staged by `Staging`
 * (`stage.ts`), unchanged, a bounded piece after another on the worker's own thread, so the work
 * per piece and every outcome and refusal are what they were on the loop.
 *
 * Between pieces the worker looks at the word the loop sets (`worker/control.ts`): a cancel (the
 * core no longer wants this staging, `wanted`) or a stop ends it through `Staging`, which removes
 * its folder. Then it marks itself ended, wakes a stop that waits for it, and posts the outcome. It
 * never touches `hub.db`, and nothing it does reaches the core but that one outcome.
 */
import type { KindData, WorkerData } from "../worker/kinds.ts";
import { serveJob, type WorkerReply } from "../worker/serve.ts";
import { Staging } from "./stage.ts";

/**
 * Stages to the end on this thread, then marks the control word and posts the outcome
 * (`worker/serve.ts`): a cancel, looked at before every piece, ends it through `Staging`, which
 * removes its folder; the outcome the core sees is the loop's own (`stage-job.ts`, `CANCELLED`).
 */
export function serveStaging(
  port: { postMessage(reply: WorkerReply): void },
  data: WorkerData<KindData<"stageUpdate">>,
): void {
  serveJob(port, data.control, new Staging(data.inputs));
}

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
import type { FileOutcome } from "../../core/model/events.ts";
import { Staging, type StageInputs } from "./stage.ts";

/** The loop's word to the worker, `control[0]`: go on, the core no longer wants it, or a stop. */
export const STAGING_RUN = 0;
export const STAGING_CANCEL = 1;
export const STAGING_STOP = 2;

/**
 * Two shared 32-bit words: `[0]` what the loop asks (`STAGING_RUN`, `STAGING_CANCEL`,
 * `STAGING_STOP`), `[1]` 1 once the worker has ended, its folder removed if it failed or was
 * ended. The loop writes the first, the worker the second.
 */
export type StagingControl = Int32Array<SharedArrayBuffer>;

export function stagingControl(): StagingControl {
  return new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
}

/** What the worker is started with: staging's inputs but `wanted`, which is the control word. */
export interface StagingWorkerData {
  readonly inputs: Omit<StageInputs, "wanted">;
  readonly control: StagingControl;
}

/** The worker's one message: the outcome, once staging has ended. */
export interface StagingReply {
  readonly kind: "ended";
  readonly outcome: FileOutcome;
}

/** Stages to the end on this thread, then marks the control word and posts the outcome. */
export function serveStaging(
  port: { postMessage(reply: StagingReply): void },
  data: StagingWorkerData,
): void {
  const { control } = data;
  const job = new Staging({
    ...data.inputs,
    // Looked at before every piece (`Staging.next`): a cancel ends it as before, "cancelled".
    wanted: () => Atomics.load(control, 0) !== STAGING_CANCEL,
  });
  let outcome: FileOutcome | undefined;
  while (outcome === undefined)
    outcome =
      Atomics.load(control, 0) === STAGING_STOP ? job.abort("the hub is stopping") : job.next();
  Atomics.store(control, 1, 1);
  Atomics.notify(control, 1);
  port.postMessage({ kind: "ended", outcome });
}

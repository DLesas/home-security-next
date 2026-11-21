/**
 * Staging an update as the loop's job, with the staging itself on a worker thread (the product
 * owner's ruling of 2026-11-20, D145): a file job on its worker (`shell/worker/job.ts`, which says
 * what the loop and the worker each do, a cancel, a stop and a worker that fails; the worker's
 * side is `stage-serve.ts`). What is staging's own:
 *
 * - **What a failed or given-up worker leaves:** the `.staging-*` folders beside the hub's
 *   `staged/` versions, removed off the loop; a stop that waits out its bound leaves them to the
 *   next staging's first pass (`stage.ts`, `#hashPiece`).
 * - **What an unwanted outcome left in place:** the version the worker had put in `staged/`
 *   before it was told of the cancel, removed before the job ends "staging was cancelled".
 * - **One staging at a time** (its gate): two would share the `.staging-*` folders, and each
 *   staging's first pass removes every one of them.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";
import { installPaths } from "../../../launcher/src/layout.ts";
import type { startStagingThread } from "../safe/staging-thread.ts";
import { gateBusy, WorkerJob, type WorkerJobOptions } from "../worker/job.ts";
import type { StageInputs } from "./stage.ts";
import { STAGING_CANCELLED, type StagingWorkerData } from "./stage-serve.ts";

export { CANCEL_WAIT_MS, QUEUE_WAIT_MS, STOP_WAIT_MS } from "../worker/job.ts";

export const CANCELLED = STAGING_CANCELLED;

/** Staging's gate: its jobs one at a time. */
const GATE = "stageUpdate";

export interface StagingJobOptions extends Omit<WorkerJobOptions, "start"> {
  /** Starts the worker: the real one but in a test. */
  readonly start?: typeof startStagingThread;
}

/** Whether a staging is running or not yet over (its thread, its removals): for the tests. */
export function stagingBusy(): boolean {
  return gateBusy(GATE);
}

/** The `.staging-*` folders in `prefix`'s `staged/`, found off the loop. */
function stagingFolders(prefix: string): Promise<readonly string[]> {
  const staged = installPaths(prefix).staged;
  return ResultAsync.fromPromise(readdir(staged), () => undefined).match(
    (names) => names.filter((name) => name.startsWith(".staging-")).map((n) => join(staged, n)),
    () => [],
  );
}

/** One release being staged on the worker thread, as the loop's job in pieces. */
export class StagingJob extends WorkerJob {
  constructor(inputs: StageInputs, options: StagingJobOptions = {}) {
    const { start, ...rest } = options;
    // Everything but `wanted`, a function, which the worker sees as the control word.
    const { path, prefix, runningVersion, platform, keys, wanted } = inputs;
    super(
      {
        name: "staging",
        gate: GATE,
        data: { kind: "stageUpdate", inputs: { path, prefix, runningVersion, platform, keys } },
        ...(wanted === undefined ? {} : { wanted }),
        cancelled: CANCELLED,
        leftovers: () => (prefix === undefined ? undefined : stagingFolders(prefix)),
        placed: (outcome) =>
          outcome.kind === "updateStaged" && prefix !== undefined
            ? [join(installPaths(prefix).staged, outcome.version)]
            : [],
      },
      {
        ...rest,
        ...(start === undefined
          ? {}
          : { start: (data, events) => start(data as unknown as StagingWorkerData, events) }),
      },
    );
  }
}

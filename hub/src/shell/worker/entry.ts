/**
 * The one worker entry of the hub's file jobs (D145), embedded in the compiled program
 * (`packaging/shared/build-program.ts`, `hubWorkers`): it serves the job its data names. One entry
 * for every kind, so the program carries one embedded worker and `jobEntry` finds it by one path;
 * each kind's module is small, so a worker loading them all costs its start little.
 */
import { parentPort, workerData } from "node:worker_threads";
import { serveStaging, type StagingWorkerData } from "../update/stage-serve.ts";

/** The data a job's worker is started with: its kind, and that kind's own. */
export type WorkerJobData = StagingWorkerData & { readonly kind: "stageUpdate" };

/** Whether `data` names an update's staging. */
function isStaging(data: unknown): data is WorkerJobData {
  return typeof data === "object" && data !== null && "kind" in data && data.kind === "stageUpdate";
}

// A kind it does not know posts nothing: the job ends failed, the worker having stopped first.
const data: unknown = workerData;
if (parentPort !== null && isStaging(data)) serveStaging(parentPort, data);

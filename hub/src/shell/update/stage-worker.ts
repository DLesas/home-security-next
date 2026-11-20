/**
 * The staging worker's entry (`stage-serve.ts`), started by `shell/safe/staging-thread.ts`. Every
 * build of the hub embeds it (`hub/packaging/shared/build-program.ts`).
 */
import { parentPort, workerData } from "node:worker_threads";
import { serveStaging, type StagingWorkerData } from "./stage-serve.ts";

if (parentPort !== null) serveStaging(parentPort, workerData as StagingWorkerData);

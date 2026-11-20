/**
 * A staging worker whose thread is held for 1.5 s before it stages as the real one does: a stand-in
 * for a worker stuck in a slow file call, on every system (`stage-job.test.ts`).
 */
import { parentPort, workerData } from "node:worker_threads";
import { serveStaging, type StagingWorkerData } from "../../../../src/shell/update/stage-serve.ts";

Bun.sleepSync(1500);
if (parentPort !== null) serveStaging(parentPort, workerData as StagingWorkerData);

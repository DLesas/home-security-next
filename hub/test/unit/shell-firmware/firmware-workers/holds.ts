/**
 * A firmware staging worker whose thread is held for 1.5 s before it stages as the real one does:
 * a stand-in for a worker stuck in a slow file call, on every system (`stage-job.test.ts`).
 */
import { parentPort, workerData } from "node:worker_threads";
import { serveFirmwareStaging } from "../../../../src/shell/firmware/stage-serve.ts";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

Bun.sleepSync(1500);
if (parentPort !== null)
  serveFirmwareStaging(parentPort, workerData as WorkerData<KindData<"stageFirmware">>);

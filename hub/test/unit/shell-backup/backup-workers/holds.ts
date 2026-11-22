/**
 * A backup worker whose thread is held for 1.5 s before it writes as the real one does: a
 * stand-in for a worker stuck in a slow file call, on every system (`write-job.test.ts`).
 */
import { parentPort, workerData } from "node:worker_threads";
import { serveBackup } from "../../../../src/shell/backup/write-serve.ts";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

Bun.sleepSync(1500);
if (parentPort !== null) serveBackup(parentPort, workerData as WorkerData<KindData<"writeBackup">>);

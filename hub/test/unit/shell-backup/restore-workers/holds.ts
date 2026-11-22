/**
 * A restore worker whose thread is held for 1.5 s before it builds as the real one does: a
 * stand-in for a worker stuck in a slow file call, on every system (`restore-job.test.ts`).
 */
import { parentPort, workerData } from "node:worker_threads";
import { serveRestore } from "../../../../src/shell/backup/restore-serve.ts";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

Bun.sleepSync(1500);
if (parentPort !== null)
  serveRestore(parentPort, workerData as WorkerData<KindData<"applyRestore">>);

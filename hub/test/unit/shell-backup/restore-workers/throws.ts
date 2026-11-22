/**
 * A restore worker that makes every file a restore makes, `hub.db.restore` too (as after its
 * rename), then throws: a parse of what is not JSON (`restore-job.test.ts`).
 */
import { writeFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
import { join } from "node:path";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

const { inputs } = workerData as WorkerData<KindData<"applyRestore">>;
// By their own names, not the product's list: a test of that list must not be made from it.
for (const name of [
  "hub.db.restore",
  "hub.db.restore.new",
  "hub.db.restore.new-wal",
  "hub.db.restore.new-shm",
  "hub.db.restore.new.plain",
])
  writeFileSync(join(inputs.dataDir, name), "half");
JSON.parse("not the restore");

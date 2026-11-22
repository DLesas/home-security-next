/**
 * A restore worker that makes every file a restore makes, `hub.db.restore` too (as after its
 * rename), then throws: a parse of what is not JSON (`restore-job.test.ts`).
 */
import { writeFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
import { restoreFiles } from "../../../../src/shell/backup/restore.ts";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

const { inputs } = workerData as WorkerData<KindData<"applyRestore">>;
for (const path of restoreFiles(inputs.dataDir)) writeFileSync(path, "half");
JSON.parse("not the restore");

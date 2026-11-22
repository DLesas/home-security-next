/** A backup worker that writes its temporary file, then throws: a parse of what is not JSON (`write-job.test.ts`). */
import { writeFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
import { backupTemporary } from "../../../../src/shell/backup/write.ts";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

const { read, work } = workerData as WorkerData<KindData<"writeBackup">>;
writeFileSync(backupTemporary(work.folder, read) ?? "", "half");
JSON.parse("not the backup");

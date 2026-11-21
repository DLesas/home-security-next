/** A firmware staging worker that writes its temporary file, then throws: a parse of what is not JSON (`stage-job.test.ts`). */
import { mkdirSync, writeFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
import { stagingFile } from "../../../../src/shell/firmware/stage.ts";
import { storeFolder } from "../../../../src/shell/firmware/store.ts";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

const { inputs } = workerData as WorkerData<KindData<"stageFirmware">>;
mkdirSync(storeFolder(inputs.dataDir), { recursive: true });
writeFileSync(stagingFile(inputs.dataDir, inputs.job), "half");
JSON.parse("not the image");

/** A staging worker that writes into its folder, then throws: a parse of what is not JSON (`stage-job.test.ts`). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";
import { installPaths } from "../../../../launcher/src/layout.ts";
import type { StagingWorkerData } from "../../../../src/shell/update/stage-serve.ts";

const { inputs } = workerData as StagingWorkerData;
const folder = join(installPaths(inputs.prefix ?? "").staged, ".staging-9.0.0", "web");
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, "f0.js"), "half");
JSON.parse("not the release");

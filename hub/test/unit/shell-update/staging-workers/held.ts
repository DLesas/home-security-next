/**
 * A staging worker that stages as the real one does, but whose read of the program tree's launcher
 * file holds its thread until the test lets it go, by making `<launcher file>.go` (at most 60 s).
 * Staging reads that file at the end of its second pass (`Staging`'s `#prepareRemoval`), every
 * file copied: the same place as the FIFO's stuck `open()` (`stage-job.test.ts`), on every
 * system. While held the thread sees no flag, as in a file call. `readHead` is wrapped as
 * `backup/files.ts` is loaded on this thread; nothing in the product is changed for it.
 */
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { StagingWorkerData } from "../../../../src/shell/update/stage-serve.ts";

const HELD = `
export function readHead(path: string, length: number) {
  if (path.endsWith("launcher.json")) {
    const { existsSync } = require("node:fs");
    const end = performance.now() + 60_000;
    while (!existsSync(path + ".go") && performance.now() < end) Bun.sleepSync(5);
  }
  return readHeadAsItIs(path, length);
}
`;

Bun.plugin({
  name: "held at the launcher file",
  setup(build) {
    build.onLoad({ filter: /[\\/]backup[\\/]files\.ts$/u }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      // Not held if staging no longer reads it so: an exit the test sees, not a staging unheld.
      if (!source.includes("export function readHead(")) process.exit(9);
      return {
        loader: "ts",
        contents: source.replace("export function readHead(", "function readHeadAsItIs(") + HELD,
      };
    });
  },
});

const { serveStaging } = await import("../../../../src/shell/update/stage-serve.ts");
if (parentPort !== null) serveStaging(parentPort, workerData as StagingWorkerData);

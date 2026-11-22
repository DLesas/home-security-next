/**
 * A restore worker that builds as the real one does, but whose first piece of opening the file
 * holds its thread until the test lets it go, by making `go` in the data folder (at most 60 s):
 * the scratch plaintext file made, nothing in it yet, on every system (`restore-job.test.ts`).
 * While held the thread sees no word from the loop, as in a file call. `restore.ts` is changed as
 * it is loaded on this thread; nothing in the product is changed for it.
 */
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

const HELD = `
function heldUntilGo(dataDir: string): void {
  const { existsSync } = require("node:fs");
  const { join } = require("node:path");
  const end = performance.now() + 60_000;
  while (!existsSync(join(dataDir, "go")) && performance.now() < end) Bun.sleepSync(5);
}
`;
const DECRYPT = "  #decrypt(): FileOutcome | undefined {\n";

Bun.plugin({
  name: "held at the first piece of opening",
  setup(build) {
    build.onLoad({ filter: /[\\/]backup[\\/]restore\.ts$/u }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      // Not held if the restore no longer opens so: an exit the test sees, not a restore unheld.
      if (!source.includes(DECRYPT)) process.exit(9);
      return {
        loader: "ts",
        contents:
          source.replace(DECRYPT, `${DECRYPT}    heldUntilGo(this.#inputs.dataDir);\n`) + HELD,
      };
    });
  },
});

const { serveRestore } = await import("../../../../src/shell/backup/restore-serve.ts");
if (parentPort !== null)
  serveRestore(parentPort, workerData as WorkerData<KindData<"applyRestore">>);

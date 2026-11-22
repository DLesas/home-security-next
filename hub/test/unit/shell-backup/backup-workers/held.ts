/**
 * A backup worker that writes as the real one does, but whose sync of each sealed piece holds its
 * thread until the test lets it go, by making `go` beside the backup folder (at most 60 s): the
 * temporary file made and its first piece written, on every system (`write-job.test.ts`). While
 * held the thread sees no word from the loop, as in a file call. `write.ts` is changed as it is
 * loaded on this thread; nothing in the product is changed for it.
 */
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

const HELD = `
function heldUntilGo(folder: string): void {
  const { existsSync } = require("node:fs");
  const { join } = require("node:path");
  const end = performance.now() + 60_000;
  while (!existsSync(join(folder, "..", "go")) && performance.now() < end) Bun.sleepSync(5);
}
`;
const SYNC = "    fdatasyncSync(fd);\n";

Bun.plugin({
  name: "held at a sealed piece's sync",
  setup(build) {
    build.onLoad({ filter: /[\\/]backup[\\/]write\.ts$/u }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      // Not held if the backup no longer syncs so: an exit the test sees, not a backup unheld.
      if (!source.includes(SYNC)) process.exit(9);
      return {
        loader: "ts",
        contents: source.replace(SYNC, `    heldUntilGo(this.#work.folder);\n${SYNC}`) + HELD,
      };
    });
  },
});

const { serveBackup } = await import("../../../../src/shell/backup/write-serve.ts");
if (parentPort !== null) serveBackup(parentPort, workerData as WorkerData<KindData<"writeBackup">>);

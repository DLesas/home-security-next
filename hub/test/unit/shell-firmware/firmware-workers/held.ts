/**
 * A firmware staging worker that stages as the real one does, but whose sync of the temporary file
 * holds its thread until the test lets it go, by making `go` in the data folder (at most 60 s),
 * having made `held` there first, which the test waits for: the
 * payload copied, the file whole but not yet synced, on every system (`stage-job.test.ts`). While
 * held the thread sees no word from the loop, as in a file call. `syncOpen` is wrapped as
 * `safe/firmware-io.ts` is loaded on this thread; nothing in the product is changed for it.
 */
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { KindData, WorkerData } from "../../../../src/shell/worker/kinds.ts";

const HELD = `
export function syncOpen(fd: number, what: string) {
  const { existsSync } = require("node:fs");
  const { join } = require("node:path");
  // \`what\` is the temporary file, \`<data folder>/firmware/.staging-<job>\`.
  const go = join(what, "..", "..", "go");
  // The test waits for this before it stops the job: the worker is held, not on its way.
  require("node:fs").writeFileSync(join(what, "..", "..", "held"), "");
  const end = performance.now() + 60_000;
  while (!existsSync(go) && performance.now() < end) Bun.sleepSync(5);
  return syncOpenAsItIs(fd, what);
}
`;

Bun.plugin({
  name: "held at the temporary file's sync",
  setup(build) {
    build.onLoad({ filter: /[\\/]safe[\\/]firmware-io\.ts$/u }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      // Not held if staging no longer syncs so: an exit the test sees, not a staging unheld.
      if (!source.includes("export function syncOpen(")) process.exit(9);
      return {
        loader: "ts",
        contents: source.replace("export function syncOpen(", "function syncOpenAsItIs(") + HELD,
      };
    });
  },
});

const { serveFirmwareStaging } = await import("../../../../src/shell/firmware/stage-serve.ts");
if (parentPort !== null)
  serveFirmwareStaging(parentPort, workerData as WorkerData<KindData<"stageFirmware">>);

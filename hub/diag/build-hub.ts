/** Diagnostic only: compiles `lag-hub.ts` as the hub's program is, with its embedded workers. */
import { join } from "node:path";
import { compileExecutable } from "../packaging/shared/compile.ts";
import { hostTarget, hubWorkers } from "../packaging/shared/build-program.ts";

const HUB = join(import.meta.dir, "..");
const target = hostTarget();
if (target === undefined) throw new Error("no target");
const out = process.argv[2] ?? join(HUB, "..", "lag-hub");
const failed = compileExecutable(target, join(HUB, "diag", "lag-hub.ts"), out, join(HUB, ".."), {
  root: HUB,
  entries: hubWorkers(target),
});
if (failed !== undefined) {
  console.error(failed);
  process.exit(1);
}
console.log(`built ${out}`);

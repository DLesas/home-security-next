/** Diagnostic only: compiles `lag-hub.ts` as `ef015e4`'s program was (its one Windows worker). */
import { join } from "node:path";
import { compileExecutable } from "../packaging/shared/compile.ts";

const HUB = join(import.meta.dir, "..");
const system = process.platform === "win32" ? "windows" : process.platform;
const target = `bun-${system}-${process.arch}`;
const out = process.argv[2] ?? join(HUB, "..", "lag-hub");
const worker =
  system === "windows"
    ? { root: HUB, entry: join(HUB, "src", "shell", "safe", "worker-windows-serial.ts") }
    : undefined;
const failed = compileExecutable(target, join(HUB, "diag", "lag-hub.ts"), out, join(HUB, ".."), worker);
if (failed !== undefined) {
  console.error(failed);
  process.exit(1);
}
console.log(`built ${out}`);

/**
 * `hsn` as the second account sees it (`windows-hub.test.ts`): the CLI's own `runCli`, as
 * `hub/cli/hsn.ts` runs it, with what it prints and its exit code written to a file, since a
 * process started as another account has no pipes back to the test.
 *
 *   bun windows-hsn-as.ts <result file> <hsn's arguments>…
 *   bun windows-hsn-as.ts <result file> --read <file>      (0 when the file can be read)
 */
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { runCli } from "../../../cli/main.ts";

const [resultFile = "", ...args] = process.argv.slice(2);
const out: string[] = [];
const err: string[] = [];
/** `--read <file>`: whether this account can read a file (the hub's database), not `hsn`. */
const reading = args[0] === "--read" ? (args[1] ?? "") : undefined;
const readable =
  reading === undefined
    ? undefined
    : await Bun.file(reading)
        .arrayBuffer()
        .then(
          () => true,
          (thrown: unknown) => {
            err.push(String(thrown));
            return false;
          },
        );
const code =
  reading !== undefined
    ? readable === true
      ? 0
      : 1
    : await runCli(args, {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        env: process.env,
        stdin: () => Promise.resolve(""),
        nowMs: () => Date.now(),
        onInterrupt: () => undefined,
        ask: () => Promise.resolve(""),
      });
writeFileSync(resultFile, JSON.stringify({ code, user: userInfo().username, out, err, readable }));

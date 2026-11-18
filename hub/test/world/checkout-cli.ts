/** Windows checkout CLI for tests whose hub runs as the runner at a temporary socket. */
import { runCli } from "../../cli/main.ts";
import { ownSid } from "../unit/shell-control/windows-folders.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  hubAccount: ownSid(),
  env: process.env,
  out: (line) => {
    process.stdout.write(line + "\n");
  },
  err: (line) => {
    process.stderr.write(line + "\n");
  },
  nowMs: Date.now,
  stdin: () => Bun.stdin.text(),
  ask: () => Promise.resolve(""),
  onInterrupt: (end) => {
    process.once("SIGINT", end);
  },
});

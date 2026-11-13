#!/usr/bin/env bun
/**
 * The `hsn` command (hub-design.md section 9), run with Bun. Everything is in `main.ts`; this file
 * wires it to the process; hub/package.json names it as the `hsn` command.
 */
import { runCli } from "./main.ts";

const code = await runCli(process.argv.slice(2), {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
  env: process.env,
  stdin: () => Bun.stdin.text(),
  nowMs: () => Date.now(),
  onInterrupt: (end) => {
    process.once("SIGINT", end);
  },
});
process.exitCode = code;

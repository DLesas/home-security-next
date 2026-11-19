#!/usr/bin/env bun
/**
 * `bun tools/ble-bench/src/bridge/main.ts [--port N] [--smoke]`: the
 * bench in real time (`bench.ts`) for the simulators and the desk page. Standard output carries one
 * JSON line per event (`BenchLine`); standard input takes one command per line (`BenchCommand`),
 * e.g. `{"cmd":"hold","board":"siren","ms":5000}`. It listens on 127.0.0.1 only. tools/ble-bench/README.md
 * and app/e2e-native/checklist.md say how a simulator reaches it.
 */
import { type BenchLine, readCommand, startBench } from "../bench.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const say = (line: BenchLine): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const port = Number(arg("--port") ?? "8787");
if (process.argv.includes("--security") || !Number.isInteger(port) || port < 0 || port > 65535) {
  say({ kind: "problem", message: "usage: main.ts [--port N] [--smoke] (Security 2)" });
  process.exit(2);
}

const started = await startBench({ port, smoke: process.argv.includes("--smoke") }, say);
if (!started.ok) {
  say({ kind: "problem", message: started.fault });
  process.exit(1);
}
const bench = started.value;

let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += chunk.toString();
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    const command = readCommand(line);
    if (command === undefined) {
      say({ kind: "problem", message: "not a command" });
      continue;
    }
    if (command.cmd === "quit") {
      bench.stop();
      process.exit(0);
    }
    bench.command(command);
  }
});
const stop = (): void => {
  bench.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

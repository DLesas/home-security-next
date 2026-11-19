#!/usr/bin/env bun
/**
 * The simulators' harness (m3-design.md section 9, "On the simulator and the emulator, by the
 * written checklist"): a real hub on a temporary data folder, its apps' listener at this Mac's
 * home-network address, and the Bluetooth bench (`tools/ble-bench`: three scripted boards and the
 * bridge on 127.0.0.1:8787) in this process. It prints one JSON line per event, the bench's lines
 * among them, and takes commands on standard input, one per line:
 *
 *   link ios | link android   a one-time link code for a new person, opened through the bound
 *                             `HSN_P4_DEVICE` command; the code itself is never printed
 *   {"cmd": …}                a bench command (`tools/ble-bench/src/bench.ts`): hold (5000 ms
 *                             opens a board's pairing window, 15000 resets it), power, offer,
 *                             faults, state
 *   quit
 *
 * `bun app/e2e-native/harness.ts [--smoke]`. Everything it started is
 * stopped on quit, on SIGINT and SIGTERM: the hub (SIGTERM, then SIGKILL after 10 s), the bench,
 * and the data folder. No key, link secret or session byte is printed.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { type BenchLine, readCommand, startBench } from "../../tools/ble-bench/src/bench.ts";
import { parseJson } from "../../tools/ble-bench/src/safe/json.ts";

const REPO = join(import.meta.dirname, "..", "..");
const HUB_MAIN = join(REPO, "hub", "test", "world", "hub-entry.ts");
const STOP_MS = 10_000;
const port = Number(process.env.HSN_P4_BRIDGE_PORT ?? 8787);
const deviceCommand = process.env.HSN_P4_DEVICE;

type HarnessLine =
  | BenchLine
  | {
      readonly kind: "hub";
      readonly lanUrl: string | undefined;
      readonly devicePort: number;
      readonly dataDir: string;
    }
  | { readonly kind: "linkOpened"; readonly platform: "ios" | "android"; readonly opened: boolean };

function say(line: HarnessLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function homeAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((info) => !info.internal && info.family === "IPv4")
    .map((info) => info.address)
    .toSorted()[0];
}

function control(dataDir: string, command: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(dataDir, "control.sock"));
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end >= 0) {
        socket.end();
        resolve(text.slice(0, end));
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify({ id: 1, actor: "e2e-native", command })}\n`);
  });
}

/** A link code as a deep link, opened in the booted simulator; only whether it opened is said. */
async function openLink(dataDir: string, platform: "ios" | "android"): Promise<void> {
  if (deviceCommand === undefined) {
    say({ kind: "linkOpened", platform, opened: false });
    return;
  }
  const reply = await control(dataDir, {
    kind: "op",
    op: "link.create",
    body: { kind: { newPerson: { name: "Simulator" } }, form: "qr" },
  });
  const json = parseJson(reply);
  const parsed = (json.ok ? json.value : {}) as {
    reply?: { result?: { body?: { qr?: unknown } } };
  };
  const qr = parsed.reply?.result?.body?.qr;
  if (typeof qr !== "string") {
    say({ kind: "linkOpened", platform, opened: false });
    return;
  }
  const run = spawnSync(deviceCommand, ["open", "invalid.hsn.app", qr], { stdio: "ignore" });
  say({ kind: "linkOpened", platform, opened: run.status === 0 });
}

if (process.argv.includes("--security")) {
  say({ kind: "problem", message: "usage: harness.ts [--smoke] (Security 2)" });
  process.exit(2);
}

const dataDir = mkdtempSync("/tmp/hsn-native-");
const ports = { device: await freePort(), lan: await freePort(), console: await freePort() };
const hub: ChildProcess = spawn(
  "bun",
  [
    HUB_MAIN,
    "--data",
    dataDir,
    "--port",
    String(ports.device),
    "--no-usb-watch",
    "--app-ports",
    `${String(ports.lan)},${String(ports.console)}`,
  ],
  { stdio: ["ignore", "ignore", process.env.HSN_NATIVE_HUB_LOG === "1" ? "inherit" : "ignore"] },
);
for (let i = 0; i < 300 && !existsSync(join(dataDir, "control.sock")); i++) {
  await new Promise((r) => setTimeout(r, 50));
}
const lan = homeAddress();
say({
  kind: "hub",
  lanUrl: lan === undefined ? undefined : `https://${lan}:${String(ports.lan)}`,
  devicePort: ports.device,
  dataDir,
});

const started = await startBench({ port, smoke: process.argv.includes("--smoke") }, say);
if (!started.ok) say({ kind: "problem", message: started.fault });

let stopping = false;
async function quit(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (started.ok) started.value.stop();
  const exited = new Promise((resolve) => hub.once("exit", resolve));
  hub.kill("SIGTERM");
  const timer = setTimeout(() => hub.kill("SIGKILL"), STOP_MS);
  await exited;
  clearTimeout(timer);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void quit());
process.on("SIGTERM", () => void quit());

let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += chunk.toString();
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines.map((l) => l.trim())) {
    if (line === "") continue;
    if (line === "quit") void quit();
    else if (line === "link ios" || line === "link android")
      void openLink(dataDir, line === "link ios" ? "ios" : "android");
    else {
      const command = readCommand(line);
      if (command === undefined || !started.ok) say({ kind: "problem", message: "not a command" });
      else started.value.command(command);
    }
  }
});
process.stdin.on("end", () => void quit());

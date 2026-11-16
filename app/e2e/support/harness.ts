/**
 * The harness of the browser tests (m2-design.md section 10, "The app"): a real hub process
 * (`hub/test/world/hub-entry.ts`, the hub's own entry) on a temporary data folder, serving the exported web build itself on
 * its two app listeners (section 5): the console's, `http://127.0.0.1:<port>` with the channel at
 * `ws://127.0.0.1:<port>/app`, and the apps', HTTPS with the hub's own certificate on every
 * address. In a source tree the hub serves `app/dist` (`programPaths` in
 * `hub/src/shell/app-wiring.ts`), so `bun run app:export` comes first.
 *
 * With `boards`, the scripted boards of `bench.ts` run beside it, in Bun, each on a
 * pseudo-terminal the hub is given with `--serial`, and the siren's Wi-Fi on the hub's `/device`
 * WebSocket. The hub is asked things over its control socket as `hsn` asks them (HD 9).
 *
 * Everything started here is stopped by `close`, and by the process's exit if a test never gets
 * there: the hub (SIGTERM, then SIGKILL after 10 s), the bench, and the data folder. Data folders
 * are `/tmp/hsn-e2e-*`, short, so the control socket's path stays under 104 bytes (HD 9). No
 * console token, key or link secret is printed or kept beyond the call that needs it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchCommand, BenchLine, BenchState } from "./bench.ts";

const APP = join(import.meta.dirname, "..", "..");
const REPO = join(APP, "..");
const DIST = join(APP, "dist");
/** The hub's own entry with the clock taken as synchronised (`hub/test/world/hub-entry.ts`). */
const HUB_MAIN = join(REPO, "hub", "test", "world", "hub-entry.ts");
const BENCH = join(import.meta.dirname, "bench.ts");
/** How long a clean stop may take before the hub is killed. */
const STOP_MS = 10_000;

/** A reply line of the control socket (`hub/src/control-protocol/envelope.ts`), as far as read. */
export interface ControlReply {
  readonly id: number;
  readonly reply:
    | { readonly ok: true; readonly result: { readonly kind: string } & Record<string, unknown> }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
}

/** One record of `hsn log --json` (`hub/src/control-protocol/records.ts`), as far as read. */
export interface LogRecord {
  readonly kind: string;
  readonly row: Readonly<Record<string, unknown>> & { readonly kind?: string };
}

export interface Bench {
  readonly ports: { readonly gateway: string; readonly sensor: string; readonly siren: string };
  /** Every line the bench has said, in order. */
  readonly lines: readonly BenchLine[];
  /** A board is plugged into the hub computer now: its port appears. */
  plug(board: "gateway" | "sensor" | "siren"): void;
  /** The sensor's door opens or closes now. */
  door(open: boolean): void;
  /** What the boards have done so far. */
  state(): Promise<BenchState>;
}

export interface Harness {
  /** The console listener's address: `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The apps' listener at a home-network address of this computer, if it has one. */
  readonly lanUrl: string | undefined;
  readonly dataDir: string;
  /** One control request, as `hsn` sends it (HD 9), and its reply line. */
  control(command: object): Promise<unknown>;
  /** A new one-time console address, as `hsn open` gets it (section 5, "The console"). */
  consoleAddress(): Promise<string>;
  /** The hub's records of a kind, as `hsn log --kind <kind> --json` reads them. */
  records(logKind: string): Promise<readonly LogRecord[]>;
  /** Stops the hub as SIGTERM does (a clean stop); its exit code. */
  stop(): Promise<number | null>;
  close(): Promise<void>;
}

/** A harness with the scripted boards beside the hub. */
export interface BoardsHarness extends Harness {
  readonly bench: Bench;
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

/** A home-network address of this computer, as the hub's certificate names it (`homeAddresses`). */
function homeAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((info) => !info.internal && info.family === "IPv4")
    .map((info) => info.address)
    .toSorted()[0];
}

const running = new Set<ChildProcess>();
const folders = new Set<string>();
// Whatever a test did not stop: killed, and its folders removed, when the test process ends.
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function temporaryFolder(prefix: string): string {
  // Short, so the control socket's path stays under 104 bytes (HD 9).
  const folder = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", prefix));
  folders.add(folder);
  return folder;
}

function removeFolder(folder: string): void {
  rmSync(folder, { recursive: true, force: true });
  folders.delete(folder);
}

function track(child: ChildProcess): ChildProcess {
  running.add(child);
  child.once("exit", () => running.delete(child));
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals): Promise<number | null> {
  const done = exited(child);
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
  const code = await done;
  clearTimeout(timer);
  return code;
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return check();
}

async function startBench(
  devicePort: number,
  usbDir: string,
): Promise<{ bench: Bench; child: ChildProcess } | undefined> {
  const child = track(
    spawn("bun", [BENCH], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, HSN_E2E_DEVICE_PORT: String(devicePort), HSN_E2E_USB_DIR: usbDir },
    }),
  );
  const lines: BenchLine[] = [];
  const waiting = new Map<number, (state: BenchState) => void>();
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim() === "") continue;
      const line = JSON.parse(part) as BenchLine;
      if (line.kind === "state") {
        waiting.get(line.id)?.(line.state);
        waiting.delete(line.id);
      } else lines.push(line);
    }
  });
  const send = (command: BenchCommand) => child.stdin?.write(`${JSON.stringify(command)}\n`);
  await until(() => lines.some((l) => l.kind === "ports"), 10_000);
  const ports = lines.find((l) => l.kind === "ports");
  if (ports?.kind !== "ports") {
    child.kill("SIGKILL");
    return undefined;
  }
  let asked = 0;
  return {
    child,
    bench: {
      ports: { gateway: ports.gateway, sensor: ports.sensor, siren: ports.siren },
      lines,
      plug: (board) => send({ cmd: "plug", board }),
      door: (open) => send({ cmd: "door", open }),
      state: () =>
        new Promise((resolve) => {
          asked += 1;
          waiting.set(asked, resolve);
          send({ cmd: "state", id: asked });
        }),
    },
  };
}

async function startHub(
  dataDir: string,
  ports: { readonly device: number; readonly lan: number; readonly console: number },
  serial: readonly string[],
): Promise<ChildProcess | undefined> {
  const hub = track(
    spawn(
      "bun",
      [
        HUB_MAIN,
        "--data",
        dataDir,
        "--port",
        String(ports.device),
        // With boards, the hub watches their ports' folder and opens a port when it appears.
        ...(serial.length === 0 ? ["--no-usb-watch"] : []),
        "--app-ports",
        `${String(ports.lan)},${String(ports.console)}`,
        ...serial.flatMap((path) => ["--serial", path]),
      ],
      { stdio: ["ignore", "ignore", process.env.HSN_E2E_HUB_LOG === "1" ? "inherit" : "ignore"] },
    ),
  );
  const socket = join(dataDir, "control.sock");
  await until(() => existsSync(socket) || hub.exitCode !== null, 15_000);
  if (!existsSync(socket)) {
    await stopChild(hub, "SIGKILL");
    return undefined;
  }
  return hub;
}

/** The hub alone. */
export async function startHarness(): Promise<Harness> {
  return (await start(false)).harness;
}

/** The hub with the scripted boards, on pseudo-terminals. */
export async function startBoardsHarness(): Promise<BoardsHarness> {
  const { harness, bench } = await start(true);
  if (bench === undefined) throw new Error("the bench did not start");
  return { ...harness, bench };
}

async function start(boards: boolean): Promise<{ harness: Harness; bench: Bench | undefined }> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("no web build: run `bun run app:export` first");
  }
  const dataDir = temporaryFolder("hsn-e2e-");
  const usbDir = boards ? temporaryFolder("hsn-e2e-usb-") : undefined;
  const ports = { device: await freePort(), lan: await freePort(), console: await freePort() };
  const started = usbDir === undefined ? undefined : await startBench(ports.device, usbDir);
  const serial =
    started === undefined
      ? []
      : [started.bench.ports.gateway, started.bench.ports.sensor, started.bench.ports.siren];
  const hub = boards && started === undefined ? undefined : await startHub(dataDir, ports, serial);
  if (hub === undefined) {
    if (started !== undefined) await stopChild(started.child, "SIGKILL");
    removeFolder(dataDir);
    if (usbDir !== undefined) removeFolder(usbDir);
    throw new Error(
      boards && started === undefined
        ? "the bench did not start"
        : "the hub did not open its control socket",
    );
  }
  let requests = 0;
  const control = (command: object) =>
    new Promise<unknown>((resolve, reject) => {
      const socket = connect(join(dataDir, "control.sock"));
      let text = "";
      requests += 1;
      socket.on("data", (chunk) => {
        text += chunk.toString();
        const end = text.indexOf("\n");
        if (end >= 0) {
          socket.end();
          resolve(JSON.parse(text.slice(0, end)) as unknown);
        }
      });
      socket.on("error", reject);
      socket.write(`${JSON.stringify({ id: requests, actor: "e2e", command })}\n`);
    });
  const lanHost = homeAddress();
  let stopped: Promise<number | null> | undefined;
  const stop = () => (stopped ??= stopChild(hub, "SIGTERM"));
  const harness: Harness = {
    url: `http://127.0.0.1:${String(ports.console)}`,
    lanUrl: lanHost === undefined ? undefined : `https://${lanHost}:${String(ports.lan)}`,
    dataDir,
    control,
    consoleAddress: async () => {
      const line = (await control({ kind: "consoleToken" })) as ControlReply;
      if (!line.reply.ok || line.reply.result.kind !== "consoleToken") {
        throw new Error("the hub gave no console token");
      }
      return String(line.reply.result.url);
    },
    records: async (logKind) => {
      const line = (await control({ kind: "log", logKind, follow: false })) as ControlReply;
      if (!line.reply.ok) throw new Error(`hsn log: ${line.reply.error.message}`);
      return line.reply.result.records as readonly LogRecord[];
    },
    stop,
    close: async () => {
      await stop();
      if (started !== undefined) {
        started.child.stdin?.end();
        await stopChild(started.child, "SIGTERM");
      }
      removeFolder(dataDir);
      if (usbDir !== undefined) removeFolder(usbDir);
    },
  };
  return { harness, bench: started?.bench };
}

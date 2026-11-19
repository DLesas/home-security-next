/**
 * The real hub for the app's tests (the coordinator's second pass): `hub/src/shell/main.ts` as a
 * process on a temporary data folder, its two app listeners on free ports, reached as a browser
 * reaches them. Every process started here is killed when the test file ends, whatever happens
 * (`stopAllHubs` in `afterAll`, and the runner's exit), and its folder removed.
 *
 * `consoleCode()` is what `hsn open` does: a one-time console token over the control socket.
 */
import { spawnTestHub, stopTestHub } from "../../../hub/test/world/processes.ts";
import { freePort, Output, startWithPortRetry } from "../../../hub/test/world/test-ports.ts";
import { shortTempFolder } from "../../../hub/test/world/temp-folder.ts";
import { type Subprocess } from "bun";
import { existsSync, rmSync } from "node:fs";
import { connect as connectSocket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { webSocketConnect, type Connect } from "../../src/hub/wire";

// The hub's own entry with its clock taken as synchronised (a Linux machine trusts its clock only
// when the system says so, and refuses exports otherwise): the shared test entry.
const MAIN = join(import.meta.dir, "..", "..", "..", "hub", "test", "world", "hub-entry.ts");
const live = new Set<Subprocess>();
const folders = new Set<string>();

process.on("exit", () => {
  for (const hub of live) hub.kill(9);
});

/** This computer's first IPv4 address on a network, for the home network's listener, if any. */
export function homeAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return undefined;
}

/** A WebSocket as a browser on `origin` opens it: its `Origin` header, the hub's own certificate accepted. */
export function connectFrom(origin: string): Connect {
  const ws = origin.replace(/^http/u, "ws");
  return webSocketConnect(ws, (url) => {
    // Bun's WebSocket takes headers and TLS options in place of the protocols argument.
    const options = { headers: { Origin: origin }, tls: { rejectUnauthorized: false } };
    return new WebSocket(url, options as unknown as string[]);
  });
}

export interface RealHub {
  readonly dataDir: string;
  readonly consolePort: number;
  readonly devicePort: number;
  readonly lanPort: number;
  readonly consoleOrigin: string;
  /** `https://<this computer's address>:<lan port>`, or undefined with no network address. */
  readonly lanOrigin: string | undefined;
  /** One control request (HD 9), and its reply line. */
  control(command: object): Promise<unknown>;
  /** `hsn open`'s console token: the address it would open, on this hub's console port. */
  consoleCode(): Promise<string>;
  /** Stops the process (SIGTERM, then SIGKILL after 5 s) and waits for it. */
  stop(): Promise<void>;
  /** Starts it again on the same folder and ports: a new boot. */
  start(): Promise<void>;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectSocket(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

/** Starts an app test hub and gives each subsequent start the same ports. */
export async function startRealHub(prepare?: (dataDir: string) => void): Promise<RealHub> {
  // Short, so the control socket's path stays under 104 bytes (HD 9).
  const dataDir = shortTempFolder("hsn-a7-");
  folders.add(dataDir);
  prepare?.(dataDir);
  let ports:
    { readonly console: number; readonly lan: number; readonly device: number } | undefined;
  const home = homeAddress();
  let child: Subprocess | undefined;
  const sock = join(dataDir, "control.sock");

  const control = (command: object) =>
    new Promise<unknown>((resolve, reject) => {
      const socket = connectSocket(sock);
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
        const end = text.indexOf("\n");
        if (end >= 0) {
          socket.end();
          resolve(JSON.parse(text.slice(0, end)) as unknown);
        }
      });
      socket.on("error", reject);
      socket.write(`${JSON.stringify({ id: 1, actor: "a7-test", command })}\n`);
    });

  const hub: RealHub = {
    dataDir,
    get consolePort() {
      return ports?.console ?? 0;
    },
    get devicePort() {
      return ports?.device ?? 0;
    },
    get lanPort() {
      return ports?.lan ?? 0;
    },
    get consoleOrigin() {
      return `http://127.0.0.1:${String(hub.consolePort)}`;
    },
    get lanOrigin() {
      return home === undefined ? undefined : `https://${home}:${String(hub.lanPort)}`;
    },
    control,
    consoleCode: async () => {
      const answer = (await control({ kind: "consoleToken" })) as {
        reply?: { ok?: boolean; result?: { url?: string } };
      };
      const url = answer.reply?.result?.url ?? "";
      // The token's address names the usual console port; this hub's is a free one.
      return url.replace(
        /^http:\/\/127\.0\.0\.1:\d+/u,
        `http://127.0.0.1:${String(hub.consolePort)}`,
      );
    },
    start: async () => {
      const { proc, chosen } = await startWithPortRetry(
        async () => {
          const chosen = ports ?? {
            console: await freePort(),
            lan: await freePort(),
            device: prepare === undefined ? 0 : await freePort(),
          };
          const proc = spawnTestHub(
            [
              MAIN,
              "--data",
              dataDir,
              "--port",
              String(chosen.device),
              "--no-usb-watch",
              "--app-ports",
              `${String(chosen.lan)},${String(chosen.console)}`,
            ],
            "pipe",
          );
          live.add(proc);
          void proc.exited.then(() => live.delete(proc));
          return {
            proc,
            chosen,
            out: new Output(proc.stderr, process.env.HSN_A7_HUB_LOG === "1"),
            ports: [chosen.console, chosen.lan, chosen.device],
            ready: () => existsSync(sock) && portOpen(chosen.console),
          };
        },
        {
          label: "the real hub did not open its control socket and console listener",
          pickAgain: ports === undefined,
          timeoutMs: 15_000,
          pollMs: 50,
        },
      );
      child = proc;
      ports = chosen;
    },
    stop: async () => {
      const running = child;
      child = undefined;
      if (running === undefined) return;
      stopTestHub(running);
      const ended = await Promise.race([
        running.exited.then(() => true),
        Bun.sleep(5000).then(() => false),
      ]);
      if (!ended) running.kill(9);
      await running.exited;
    },
  };
  await hub.start();
  return hub;
}

/** Ends every real hub still running and removes their folders: each test file's `afterAll`. */
export async function stopAllHubs(): Promise<void> {
  const running = [...live];
  for (const hub of running) hub.kill(9);
  await Promise.all(running.map((hub) => hub.exited));
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  folders.clear();
}

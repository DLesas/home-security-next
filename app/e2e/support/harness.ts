/**
 * Step 0's harness for the browser tests (m2-design.md section 10): a real hub process on a
 * temporary data folder, reached on its control socket, and the exported web build served with
 * the design's headers (section 5, "Defences on every HTTP and WebSocket request"). The hub does
 * not serve the web app until owner A2's listeners exist; until then this server stands in for
 * them, with the same content security policy, built from the build's `csp.json` as the hub's
 * listeners build it, and is replaced by the hub's own listener in step 2.
 */
import { contentSecurityPolicy, CSP_FILE, webCspFile } from "@hsn/protocol/app";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const APP = join(import.meta.dirname, "..", "..");
const REPO = join(APP, "..");
const DIST = join(APP, "dist");
const HUB_MAIN = join(REPO, "hub", "src", "shell", "main.ts");

/** The content security policy of section 5, from the build's hashes (`web/csp.json`). */
function policyOfBuild(): string {
  const file = join(DIST, CSP_FILE);
  if (!existsSync(file)) throw new Error(`no ${CSP_FILE}: run \`bun run app:export\` first`);
  return contentSecurityPolicy(webCspFile.parse(JSON.parse(readFileSync(file, "utf8"))));
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

export interface Harness {
  readonly url: string;
  readonly dataDir: string;
  /** One control request, as `hsn` sends it (HD 9), and its reply line. */
  control(command: object): Promise<unknown>;
  close(): Promise<void>;
}

function serve(): Promise<{ server: Server; url: string }> {
  if (!existsSync(join(DIST, "index.html"))) {
    return Promise.reject(new Error("no web build: run `bun run --cwd app export:web` first"));
  }
  const policy = policyOfBuild();
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/"));
    const file = join(DIST, path);
    const found = file.startsWith(DIST) && existsSync(file) && extname(file) !== "";
    const body = readFileSync(found ? file : join(DIST, "index.html"));
    response.writeHead(200, {
      "content-type": TYPES[extname(found ? file : "x.html")] ?? "application/octet-stream",
      "content-security-policy": policy,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function startHub(dataDir: string): Promise<ChildProcess> {
  const hub = spawn("bun", [HUB_MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch"], {
    stdio: "ignore",
  });
  const socket = join(dataDir, "control.sock");
  for (let i = 0; i < 200 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(socket)) {
    hub.kill("SIGKILL");
    throw new Error("the hub did not open its control socket");
  }
  return hub;
}

export async function startHarness(): Promise<Harness> {
  // Short, so the control socket's path stays under 104 bytes (HD 9).
  const dataDir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "hsn-e2e-"));
  const hub = await startHub(dataDir);
  const { server, url } = await serve();
  return {
    url,
    dataDir,
    control: (command) =>
      new Promise((resolve, reject) => {
        const socket = connect(join(dataDir, "control.sock"));
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
        socket.write(`${JSON.stringify({ id: 1, actor: "e2e", command })}\n`);
      }),
    close: async () => {
      await new Promise((r) => server.close(r));
      const exited = new Promise((r) => hub.once("exit", r));
      hub.kill("SIGTERM");
      await exited;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

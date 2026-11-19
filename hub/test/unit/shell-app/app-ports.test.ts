/**
 * The app listeners on ports other than 8444 and 8445 (`--app-ports`, or ports the system chose):
 * every address the hub hands out must lead to the listeners that are really there (the console's
 * one-time address, a link address, a QR code's `p`), and a link through each must succeed.
 *
 * The listeners open first and the facts the core is given carry their real ports, the console's
 * too (`hubFacts.consolePort`), so each address leads to its listener as written.
 */
import { shortTempFolder } from "../../world/temp-folder.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  APP_PATHS,
  linkPrologue,
  NOISE_PATTERNS,
  parseConsoleFragment,
  parseLinkFragment,
  parseLinkQr,
  appIdentityBytes,
  secretLookup,
  secretPsk,
  sessionPrologue,
  startHandshake,
  type StaticKey,
  type TransportSession,
  x25519StaticKey,
} from "@hsn/protocol/app";
import { sha256 } from "@noble/hashes/sha2.js";
import { exchange } from "../../../cli/client.ts";
import { factsInput, startupInputs } from "../../../src/shell/app/facts.ts";
import { homeAddresses } from "../../../src/shell/hub-facts.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";
import { openHub, stopHubs } from "./support.ts";

const MAIN = join(import.meta.dir, "..", "..", "..", "src", "shell", "main.ts");
const root = shortTempFolder("hsn-a2-ports-");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterAll(async () => {
  stopHubs();
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
});

function must<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string },
): T {
  expect(result.ok ? "ok" : result.error).toBe("ok");
  return (result as { readonly value: T }).value;
}

const json = (value: unknown) => encoder.encode(JSON.stringify(value));
const parse = (bytes: Uint8Array) => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** A WebSocket whose binary messages are read in order. */
class Socket {
  readonly #inbox: Uint8Array[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  private constructor(ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string")
        this.#inbox.push(new Uint8Array(event.data as ArrayBuffer));
      this.#wake?.();
    };
    ws.onclose = () => {
      this.#closed = true;
      this.#wake?.();
    };
    this.ws = ws;
  }

  readonly ws: WebSocket;

  /** Opens `url` with the origin of its own scheme, host and port, as the page it came from. */
  static open(url: string): Promise<Socket> {
    const parsed = new URL(url);
    const origin = `${parsed.protocol === "wss:" ? "https" : "http"}://${parsed.host}`;
    const ws = new WebSocket(url, {
      headers: { Origin: origin },
      tls: { rejectUnauthorized: false },
    } as unknown as string[]);
    const socket = new Socket(ws);
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        resolve(socket);
      };
      ws.onerror = () => {
        reject(new Error(`${url} did not open`));
      };
    });
  }

  send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  async next(ms = 5000): Promise<Uint8Array> {
    const deadline = Date.now() + ms;
    for (;;) {
      const message = this.#inbox.shift();
      if (message !== undefined) return message;
      if (this.#closed || Date.now() > deadline) {
        expect("a message from the hub").toBe("none came");
        return new Uint8Array(0);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

const keyOf = (seed: number): StaticKey => must(x25519StaticKey(sha256(Uint8Array.of(seed, 0x9a))));

/** A link through `url`'s listener (its own host and port): the hub's key from message 2. */
async function linkAt(
  url: string,
  secret: Uint8Array,
  key: StaticKey,
  request: unknown,
): Promise<Uint8Array> {
  const socket = await Socket.open(url);
  const hs = must(
    startHandshake({
      pattern: NOISE_PATTERNS.link,
      initiator: true,
      prologue: linkPrologue("link"),
      staticKey: key,
      psk: secretPsk(sha256, secret),
    }),
  );
  socket.send(
    must(await hs.writeMessage(json({ proto: [1, 1], find: secretLookup(sha256, secret) }))),
  );
  must(await hs.readMessage(await socket.next()));
  socket.send(must(await hs.writeMessage(json(request))));
  const result = parse(must(must(hs.split()).decrypt(await socket.next())));
  expect(typeof result.client).toBe("number");
  return hs.remoteStatic() ?? new Uint8Array(32);
}

/** An IK session on `url`: a request and its reply. */
async function sessionAt(url: string, key: StaticKey, hubKey: Uint8Array) {
  const socket = await Socket.open(url);
  const hs = must(
    startHandshake({
      pattern: NOISE_PATTERNS.session,
      initiator: true,
      prologue: sessionPrologue(appIdentityBytes(sha256, hubKey)),
      staticKey: key,
      remoteStatic: hubKey,
    }),
  );
  socket.send(must(await hs.writeMessage(json({ proto: [1, 1], app: "ports" }))));
  must(await hs.readMessage(await socket.next()));
  const transport: TransportSession = must(hs.split());
  let id = 1;
  let seq = 0;
  return {
    request: async (op: string, body: unknown, change = false) => {
      const asked = id++;
      socket.send(
        must(
          transport.encrypt(
            json({ t: "req", id: asked, ...(change ? { seq: ++seq } : {}), op, body }),
          ),
        ),
      );
      for (;;) {
        const message = parse(must(transport.decrypt(await socket.next())));
        if (message.t === "res" && message.id === asked) return message;
      }
    },
  };
}

/** A hub on two free ports that are not the usual ones, answering on its control socket. */
async function hubOnFreePorts() {
  const dataDir = mkdtempSync(join(root, "d-"));
  const lanPort = await freePort();
  const consolePort = await freePort();
  expect([lanPort, consolePort]).not.toContain(8444);
  spawnTracked(
    [
      "bun",
      MAIN,
      "--data",
      dataDir,
      "--port",
      "0",
      "--no-usb-watch",
      "--app-ports",
      `${lanPort},${consolePort}`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const sock = join(dataDir, "control.sock");
  for (let i = 0; i < 200; i++) {
    if (existsSync(sock)) {
      const status = await exchange(
        sock,
        { id: 1, actor: "ports", command: { kind: "status" } },
        1000,
      );
      if (status.isOk()) break;
    }
    await Bun.sleep(50);
  }
  await Bun.sleep(500);
  const consoleUrl = async () => {
    const asked = await exchange(
      sock,
      { id: 1, actor: "ports", command: { kind: "consoleToken" } },
      5000,
    );
    const reply = asked._unsafeUnwrap().reply.reply;
    return reply.ok && reply.result.kind === "consoleToken" ? reply.result.url : "";
  };
  return { lanPort, consolePort, consoleUrl };
}

/** The console linked with the token's secret on the listener `port`, and its session. */
async function consoleOn(port: number, url: string) {
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16);
  const key = keyOf(1);
  const hubKey = await linkAt(`ws://127.0.0.1:${port}${APP_PATHS.link}`, secret, key, {
    name: "The hub computer",
    kind: "web",
  });
  return sessionAt(`ws://127.0.0.1:${port}${APP_PATHS.session}`, key, hubKey);
}

const home = homeAddresses().find((a) => !a.includes(":"));

describe("the facts the shell builds", () => {
  test("name the port the apps' listener really opened, also one the system chose", () => {
    const side = openHub();
    expect(side.lanPort).not.toBe(8444);
    const [facts] = startupInputs(["192.168.1.20"], new Uint8Array(32), "UTC", side.lanPort);
    expect(facts).toMatchObject({ kind: "hubFacts", appsPort: side.lanPort });
    expect(factsInput([], new Uint8Array(32), 39_001).appsPort).toBe(39_001);
  });
});

describe("a real hub on ports that are not the usual ones", () => {
  test("its listeners are on the ports asked for: the console links there, and a person links on the home network's", async () => {
    const hub = await hubOnFreePorts();
    const url = await hub.consoleUrl();
    const console = await consoleOn(hub.consolePort, url);
    expect((await console.request("snapshot", {})).ok).toBe(true);
    if (home === undefined) return;
    const made = await console.request(
      "link.create",
      { kind: { newPerson: { name: "Ida" } }, form: "url" },
      true,
    );
    const address = (made.body as { url?: string }).url ?? "";
    const fragment = parseLinkFragment(address.slice(address.indexOf("#") + 1));
    expect(fragment).toBeDefined();
    // Through the listener that is really there.
    await linkAt(
      `wss://${home}:${hub.lanPort}${APP_PATHS.link}`,
      fragment?.secret ?? new Uint8Array(16),
      keyOf(2),
      {
        name: "Ida's laptop",
        kind: "web",
      },
    );
  }, 30_000);

  test("the console's one-time address names its real port, and a link through it succeeds", async () => {
    const hub = await hubOnFreePorts();
    const url = await hub.consoleUrl();
    expect(new URL(url).port).toBe(String(hub.consolePort));
    const console = await consoleOn(Number(new URL(url).port), url);
    expect((await console.request("snapshot", {})).ok).toBe(true);
  }, 30_000);

  test("a link address and a QR code name the apps' real port, and a link through each succeeds", async () => {
    const hub = await hubOnFreePorts();
    const console = await consoleOn(hub.consolePort, await hub.consoleUrl());
    expect(home).toBeDefined();
    const byUrl = await console.request(
      "link.create",
      { kind: { newPerson: { name: "Jo" } }, form: "url" },
      true,
    );
    const address = new URL((byUrl.body as { url?: string }).url ?? "http://x");
    expect(address.port).toBe(String(hub.lanPort));
    const fragment = parseLinkFragment(address.hash.slice(1));
    await linkAt(
      `wss://${address.host}${APP_PATHS.link}`,
      fragment?.secret ?? new Uint8Array(16),
      keyOf(3),
      {
        name: "Jo's laptop",
        kind: "web",
      },
    );
    const byQr = await console.request(
      "link.create",
      { kind: { newPerson: { name: "Kai" } }, form: "qr" },
      true,
    );
    const qr = parseLinkQr((byQr.body as { qr?: string }).qr ?? "");
    expect(qr?.port).toBe(hub.lanPort);
    await linkAt(
      `wss://${qr?.addresses[0] ?? ""}:${qr?.port ?? 0}${APP_PATHS.link}`,
      qr?.secret ?? new Uint8Array(16),
      keyOf(4),
      {
        name: "Kai's phone",
        kind: "phone",
      },
    );
  }, 30_000);
});

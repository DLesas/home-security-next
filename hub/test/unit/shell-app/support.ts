/**
 * What the shell-app tests share (m2-design.md section 10, "Shell tests"): a hub side made of the
 * real session layer and listeners on loopback with a scripted core (it records the events and
 * answers `HubHello`'s questions), real sockets, and a scripted client that speaks Noise with the
 * protocol package's own state machine. Every server a test opens is stopped in `afterEach`.
 */
import { expect } from "bun:test";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  APP_PATH,
  type EphemeralKeyPair,
  type Handshake,
  linkPrologue,
  NOISE_PATTERNS,
  secretLookup,
  secretPsk,
  sessionPrologue,
  startHandshake,
  type StaticKey,
  type TransportSession,
  x25519StaticKey,
} from "@hsn/protocol/app";
import { appIdentityBytes } from "@hsn/protocol/app";
import { sha256 } from "@noble/hashes/sha2.js";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { type ClientId, clientId, type ConnId, personId } from "../../../src/core/model/ids.ts";
import { ClientKind, type ClientRow } from "../../../src/core/model/rows.ts";
import {
  AppChannel,
  type ChannelLimits,
  ConnIds,
  HANDSHAKE_PATHS,
  type HandshakeKind,
  type Timers,
} from "../../../src/shell/app/channel.ts";
import type { ClientRefused } from "../../../src/shell/app/refusals.ts";
import { makeCertificate, type TlsMaterial } from "../../../src/shell/app/certificate.ts";
import { MemoryClientKeys } from "../../../src/shell/app/client-keys.ts";
import { MemoryLinkSecrets } from "../../../src/shell/app/link-secrets.ts";
import { AppListeners } from "../../../src/shell/app/listeners.ts";
import { StaticFiles } from "../../../src/shell/app/static-files.ts";
import type { UploadStore } from "../../../src/shell/app/uploads.ts";
import type { HubError } from "../../../src/core/model/errors.ts";
import { noteKey, noteValue } from "../setup/support/leak-guard.ts";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/** The value of a Noise result the test expects to succeed; the test fails otherwise. */
export function must<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string },
): T {
  expect(result.ok ? "ok" : result.error).toBe("ok");
  return (result as { readonly value: T }).value;
}

export function parse(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

/** An X25519 key with its private half, noted for the leak guard. */
export function staticKey(seed: number): {
  readonly key: StaticKey;
  readonly privateKey: Uint8Array;
} {
  const privateKey = sha256(Uint8Array.of(seed, 0x5a));
  noteKey(privateKey);
  return { key: must(x25519StaticKey(privateKey)), privateKey };
}

export function clientRow(
  id: number,
  key: Uint8Array,
  kind: ClientKind = ClientKind.Web,
): ClientRow {
  return {
    id: clientId(id),
    personId: kind === ClientKind.Console ? null : personId(2),
    staticKey: key,
    kind,
    name: `client ${id}`,
    linkedByClient: null,
    createdMs: 1,
    removedMs: null,
    lastSeq: 0,
    lastSeenMs: null,
    backupKeyEpoch: null,
  };
}

/** A web build: `index.html`, one script, and its `csp.json`. */
export async function webBuild(folder: string): Promise<void> {
  await Bun.write(`${folder}/index.html`, "<!doctype html><title>hsn</title>");
  await Bun.write(`${folder}/_expo/static/js/web/entry-1.js`, "console.log(1)");
  await Bun.write(
    `${folder}/csp.json`,
    JSON.stringify({
      styles: ["'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"],
      scripts: [],
    }),
  );
}

/** Timers a test moves by hand, for the 24-hour lifetime. */
export class ManualTimers implements Timers {
  now = 0;
  #pending: { at: number; run: () => void; live: boolean }[] = [];

  after(ms: number, run: () => void): () => void {
    const entry = { at: this.now + ms, run, live: true };
    this.#pending.push(entry);
    return () => {
      entry.live = false;
    };
  }

  /** Moves the clock forward and runs every timer that falls due, in order. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = this.#pending
        .filter((e) => e.live && e.at <= until)
        .toSorted((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      this.now = due.at;
      due.run();
    }
    this.now = until;
    this.#pending = this.#pending.filter((e) => e.live);
  }
}

export interface HubSide {
  readonly channel: AppChannel;
  readonly listeners: AppListeners;
  readonly events: HubEvent[];
  readonly reports: HubError[];
  /** Every `clientRefused` the channel sent, as the core would get it. */
  readonly refusals: ClientRefused[];
  readonly keys: MemoryClientKeys;
  readonly secrets: MemoryLinkSecrets;
  readonly hub: { readonly key: StaticKey; readonly identity: Uint8Array };
  readonly tls: TlsMaterial;
  readonly lanPort: number;
  readonly consolePort: number;
  /** Waits until an event matches, or fails after `ms`. */
  waitFor<K extends HubEvent["kind"]>(
    kind: K,
    match?: (event: Extract<HubEvent, { readonly kind: K }>) => boolean,
    ms?: number,
  ): Promise<Extract<HubEvent, { readonly kind: K }>>;
  of<K extends HubEvent["kind"]>(kind: K): Extract<HubEvent, { readonly kind: K }>[];
  stop(): void;
}

export interface HubOptions {
  readonly clients?: readonly ClientRow[];
  readonly limits?: Partial<ChannelLimits>;
  readonly timers?: Timers;
  readonly now?: () => number;
  readonly webRoot?: string;
  readonly uploads?: UploadStore;
  readonly ephemeral?: () => EphemeralKeyPair;
  readonly downloadEnded?: (conn: ConnId, job: number) => void;
  readonly hubKey?: { readonly key: StaticKey; readonly privateKey: Uint8Array };
  readonly hello?: (
    client: ClientId,
  ) => { boot: number; rev: number; person: number | null } | undefined;
  readonly hubVersion?: string;
  readonly policy?: string;
}

const opened: HubSide[] = [];

/** Stops every hub side a test opened. */
export function stopHubs(): void {
  for (const side of opened.splice(0)) side.stop();
}

export const TEST_POLICY = "default-src 'self'; frame-ancestors 'none'";

export function openHub(options: HubOptions = {}): HubSide {
  const hubKey = options.hubKey ?? staticKey(1);
  const identity = appIdentityBytes(sha256, hubKey.key.publicKey);
  const keys = new MemoryClientKeys(options.clients ?? []);
  const secrets = new MemoryLinkSecrets();
  const events: HubEvent[] = [];
  const reports: HubError[] = [];
  const refusals: ClientRefused[] = [];
  const waiters: (() => void)[] = [];
  const channel = new AppChannel({
    staticKey: hubKey.key,
    identity,
    hubVersion: options.hubVersion ?? "0.1.0",
    clientKeys: keys,
    linkSecrets: secrets,
    core: {
      hello:
        options.hello ??
        ((client) => ({ boot: 3, rev: 41, person: client === clientId(9) ? null : 2 })),
      rev: () => 41,
    },
    emit: (event) => {
      noteValue(event);
      events.push(event);
      for (const wake of waiters.splice(0)) wake();
    },
    connIds: new ConnIds(),
    hubStatus: () => ({
      lastCommitMs: 5,
      stagedItems: 2,
      databaseBytes: 4096,
      historyShortened: false,
      missingAfterRestartMs: null,
    }),
    ...(options.uploads === undefined ? {} : { uploads: options.uploads }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
    ...(options.downloadEnded === undefined ? {} : { downloadEnded: options.downloadEnded }),
    report: (error) => {
      noteValue(error);
      reports.push(error);
    },
    refused: (input) => {
      noteValue(input);
      refusals.push(input);
    },
    wasRemoved: (key) => keys.wasRemoved(key),
  });
  const tls = makeCertificate(
    { dns: ["localhost"], ips: ["127.0.0.1", "::1"] },
    Date.now(),
    crypto.getRandomValues(new Uint8Array(16)),
  )._unsafeUnwrap();
  noteKey(tls.privateKey);
  const listeners = AppListeners.open({
    channel,
    files: new StaticFiles(options.webRoot ?? "/nonexistent-web-root"),
    policy: options.policy ?? TEST_POLICY,
    lan: {
      port: 0,
      hostname: "127.0.0.1",
      tls,
      names: { dns: ["localhost"], ips: ["127.0.0.1", "::1"] },
    },
    console: { port: 0 },
  })._unsafeUnwrap();
  const of = <K extends HubEvent["kind"]>(kind: K) =>
    events.filter((e): e is Extract<HubEvent, { readonly kind: K }> => e.kind === kind);
  async function waitFor<K extends HubEvent["kind"]>(
    kind: K,
    match: (event: Extract<HubEvent, { readonly kind: K }>) => boolean = () => true,
    ms = 3000,
  ): Promise<Extract<HubEvent, { readonly kind: K }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = of(kind).find(match);
      if (found !== undefined) return found;
      const left = deadline - Date.now();
      if (left <= 0) {
        expect(`no ${kind} event within ${ms} ms`).toBe("");
        return of(kind)[0] as Extract<HubEvent, { readonly kind: K }>;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  const side: HubSide = {
    channel,
    listeners,
    events,
    reports,
    refusals,
    keys,
    secrets,
    hub: { key: hubKey.key, identity },
    tls,
    lanPort: listeners.lanPort ?? 0,
    consolePort: listeners.consolePort ?? 0,
    of,
    waitFor,
    stop: () => {
      channel.stop();
      listeners.stop();
    },
  };
  opened.push(side);
  return side;
}

// ----- The client side -----

export interface Closed {
  readonly code: number;
  readonly reason: string;
}

/** A WebSocket client that keeps every binary message and how the socket closed. */
export class WsClient {
  readonly #ws: WebSocket;
  readonly #inbox: Uint8Array[] = [];
  #wake: (() => void) | undefined;
  closedWith: Closed | undefined;
  readonly closed: Promise<Closed>;
  texts = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") this.texts++;
      else this.#inbox.push(new Uint8Array(event.data as ArrayBuffer));
      this.#wake?.();
    };
    this.closed = new Promise((resolve) => {
      ws.onclose = (event: CloseEvent) => {
        this.closedWith = { code: event.code, reason: event.reason };
        this.#wake?.();
        resolve(this.closedWith);
      };
    });
  }

  static open(
    side: HubSide,
    listener: "lan" | "console",
    origin?: string,
    handshake: HandshakeKind = "session",
  ): Promise<WsClient> {
    const port = listener === "lan" ? side.lanPort : side.consolePort;
    const scheme = listener === "lan" ? "wss" : "ws";
    const url = `${scheme}://127.0.0.1:${port}${HANDSHAKE_PATHS[handshake]}`;
    const own = `${listener === "lan" ? "https" : "http"}://127.0.0.1:${port}`;
    const ws = new WebSocket(url, {
      headers: { Origin: origin ?? own },
      tls: { rejectUnauthorized: false },
    } as unknown as string[]);
    const client = new WsClient(ws);
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        resolve(client);
      };
      ws.onerror = () => {
        reject(new Error("the WebSocket did not open"));
      };
    });
  }

  send(bytes: Uint8Array): void {
    this.#ws.send(bytes);
  }

  sendText(text: string): void {
    this.#ws.send(text);
  }

  close(): void {
    this.#ws.close();
  }

  /** The next binary message, or undefined when the socket closed or `ms` passed first. */
  async next(ms = 3000): Promise<Uint8Array | undefined> {
    const deadline = Date.now() + ms;
    for (;;) {
      const message = this.#inbox.shift();
      if (message !== undefined) return message;
      if (this.closedWith !== undefined) return undefined;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /** Waits until the socket closes, or `ms`. */
  async waitClosed(ms = 3000): Promise<Closed | undefined> {
    return Promise.race([
      this.closed,
      new Promise<undefined>((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, ms);
      }),
    ]);
  }
}

/** One side of IK, the client's: message 1, then message 2 read and split. */
export class IkClient {
  readonly hs: Handshake;
  transport: TransportSession | undefined;

  constructor(side: HubSide, key: StaticKey, ephemeral?: EphemeralKeyPair) {
    const started = startHandshake({
      pattern: NOISE_PATTERNS.session,
      initiator: true,
      prologue: sessionPrologue(side.hub.identity),
      staticKey: key,
      remoteStatic: side.hub.key.publicKey,
      ...(ephemeral === undefined ? {} : { ephemeral }),
    });
    this.hs = must(started);
  }

  async message1(hello: unknown = { proto: [1, 1], app: "1.0.0" }): Promise<Uint8Array> {
    return must(await this.hs.writeMessage(json(hello)));
  }

  async message2(message: Uint8Array): Promise<unknown> {
    const read = must(await this.hs.readMessage(message));
    this.transport = must(this.hs.split());
    return parse(read);
  }

  seal(value: unknown): Uint8Array {
    expect(this.transport).toBeDefined();
    return must(this.transport?.encrypt(json(value)) ?? { ok: false, error: "no transport" });
  }

  open(message: Uint8Array): unknown {
    expect(this.transport).toBeDefined();
    return parse(must(this.transport?.decrypt(message) ?? { ok: false, error: "no transport" }));
  }
}

/**
 * A whole session on a real socket: message 1, `HubHello`, then a first request (`pong`), so the
 * hub admits it. Resolves with the socket and the client's Noise state.
 */
export async function session(
  side: HubSide,
  key: StaticKey,
  listener: "lan" | "console" = "lan",
  id = 1,
): Promise<{ ws: WsClient; ik: IkClient; hello: unknown }> {
  const ws = await WsClient.open(side, listener);
  const ik = new IkClient(side, key);
  ws.send(await ik.message1());
  const m2 = await ws.next();
  expect(m2).toBeDefined();
  const hello = await ik.message2(m2 ?? new Uint8Array(0));
  ws.send(ik.seal({ t: "req", id, op: "pong", body: {} }));
  return { ws, ik, hello };
}

/** One side of XXpsk3, the new client's, with a 128-bit secret. */
export class LinkClient {
  readonly hs: Handshake;
  transport: TransportSession | undefined;
  readonly lookup: string;
  readonly psk: Uint8Array;

  constructor(purpose: "link" | "restore", secret: Uint8Array, key: StaticKey) {
    this.psk = secretPsk(sha256, secret);
    this.lookup = secretLookup(sha256, secret);
    const started = startHandshake({
      pattern: NOISE_PATTERNS.link,
      initiator: true,
      prologue: linkPrologue(purpose),
      staticKey: key,
      psk: this.psk,
    });
    this.hs = must(started);
  }

  async write(value: unknown): Promise<Uint8Array> {
    const written = must(await this.hs.writeMessage(json(value)));
    if (this.hs.complete) this.transport = must(this.hs.split());
    return written;
  }

  async read(message: Uint8Array): Promise<unknown> {
    return parse(must(await this.hs.readMessage(message)));
  }

  seal(value: unknown): Uint8Array {
    expect(this.transport).toBeDefined();
    return must(this.transport?.encrypt(json(value)) ?? { ok: false, error: "no transport" });
  }

  open(message: Uint8Array): unknown {
    expect(this.transport).toBeDefined();
    return parse(must(this.transport?.decrypt(message) ?? { ok: false, error: "no transport" }));
  }
}

/** One raw HTTP/1.1 request on a socket of its own: the status line's code and the headers. */
export function rawRequest(
  port: number,
  tls: boolean,
  lines: readonly string[],
  host = "127.0.0.1",
  whole = false,
): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}> {
  return new Promise((resolve, reject) => {
    const socket = tls
      ? tlsConnect({ host, port, rejectUnauthorized: false })
      : netConnect({ host, port });
    let text = "";
    socket.on(tls ? "secureConnect" : "connect", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    const finish = (): boolean => {
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return false;
      const [statusLine = "", ...headerLines] = text.slice(0, end).split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const at = line.indexOf(":");
        headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      socket.destroy();
      resolve({ status: Number(statusLine.split(" ")[1]), headers, text });
      return true;
    };
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (!whole) finish();
    });
    socket.on("close", () => {
      if (!finish()) resolve({ status: 0, headers: {}, text });
    });
    socket.on("error", reject);
  });
}

/** An upgrade request's lines for `/app`. */
export function upgradeLines(host: string, origin: string | undefined): readonly string[] {
  return [
    `GET ${APP_PATH} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...(origin === undefined ? [] : [`Origin: ${origin}`]),
  ];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { personId };

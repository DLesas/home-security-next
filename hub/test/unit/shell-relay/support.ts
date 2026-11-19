/**
 * What the relay client's tests share (docs/m4-design.md sections 4 and 11): B2's real relay on
 * loopback, started and stopped on one port so a hub can lose it and find it again; B3's real push
 * service with its stand-ins for Apple and Google; a hub's relay client with timers the test moves
 * (`ManualTimers`) and a jitter it chooses; a phone that speaks through the relay's `/v1/phone/…`
 * path; and a log of everything the hub's side said, for the leak checks. Every relay a test
 * starts is stopped by `stopAll`.
 */
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { formatIdentity, type Handshake, type StaticKey, x25519StaticKey } from "@hsn/protocol/app";
import {
  encodeRelayWelcome,
  type HubToRelayFrame,
  provedIdentity,
  type RelayToHubFrame,
  type RosterTarget,
  type RelayWelcome,
  startRelayResponder,
} from "@hsn/protocol/relay";
import { err, ok, type Result } from "neverthrow";
import type { HubEvent } from "../../../src/core/model/events.ts";
import type { HubError } from "../../../src/core/model/errors.ts";
import type { FileWork } from "../../../src/core/model/effects.ts";
import type { JobId } from "../../../src/core/model/ids.ts";
import { ConnIds, type Timers } from "../../../src/shell/app/channel.ts";
import { UploadStore } from "../../../src/shell/app/uploads.ts";
import type { JobStarted } from "../../../src/shell/loop.ts";
import { randomBytes } from "../../../src/shell/safe/crypto.ts";
import type {
  RelaySocketEvents,
  RelaySocketFactory,
} from "../../../src/shell/safe/relay-socket.ts";
import { RelayClient } from "../../../src/shell/relay/client.ts";
import { MemoryPushKeys } from "../../../src/shell/relay/push-keys.ts";
import type { ReleaseOptions } from "../../../src/shell/relay/releases.ts";
import type { StreamChannel } from "../../../src/shell/relay/streams.ts";
import { noteKey, noteValue } from "../setup/support/leak-guard.ts";
import type { PushSender } from "../../../../relay/src/push/sender.ts";
import type { ReleaseAnswers } from "../../../../relay/src/releases/service.ts";
import { Pseudonyms } from "../../../../relay/src/shell/pseudonym.ts";
import { Relay } from "../../../../relay/src/shell/relay.ts";
import { listen, type RelayListener } from "../../../../relay/src/shell/server.ts";
import { openStore, type RelayStore } from "../../../../relay/src/shell/storage/store.ts";
import { ManualClock, memoryLog, RecordingSender } from "../../../../relay/test/helpers.ts";

/** Timers a test moves by hand, in order of when they fall due; `pending` counts those live. */
export class ManualTimers implements Timers {
  now = 0;
  #pending: { at: number; run: () => void; live: boolean; id: number }[] = [];
  #id = 0;

  after(ms: number, run: () => void): () => void {
    const entry = { at: this.now + ms, run, live: true, id: this.#id++ };
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
        .toSorted((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      due.live = false;
      this.now = Math.max(this.now, due.at);
      due.run();
    }
    this.now = until;
    this.#pending = this.#pending.filter((e) => e.live);
  }

  /** Timers armed and not yet run or cancelled. */
  get pending(): number {
    return this.#pending.filter((e) => e.live).length;
  }
}

/** The value of a result that must be ok; the test fails with its error otherwise. */
export function need<T>(result: Result<T, { readonly message: string }>): T {
  if (result.isErr()) expect(result.error.message).toBe("no error");
  return result._unsafeUnwrap();
}

/** A draw of exactly 0.5 for the jitter: the step itself (`Backoff.next`). */
export const NO_JITTER = Uint8Array.of(0x80, 0, 0, 0);

export function tempFolder(): string {
  return mkdtempSync(join(tmpdir(), "hsn-relay-client-"));
}

/** Waits until `ready()` holds, letting sockets and promises run; fails after `ms`. */
export async function until(ready: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) {
      expect(`${what} within ${String(ms)} ms`).toBe("met");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Lets pending socket events and promises run a while. */
export async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- B2's relay, on a port that stays the same across a stop -----

export interface RelayRunOptions {
  readonly clock?: ManualClock;
  readonly sender?: PushSender;
  readonly releases?: ReleaseAnswers;
  readonly refused?: ReadonlySet<string>;
  readonly roles?: RelayWelcome["roles"];
  /** The store, when a test wraps the real one (a roster that is not stored). */
  readonly store?: (real: RelayStore) => RelayStore;
}

/** One relay: a SQLite file in its folder, a port kept across `stop` and `start`. */
export class RelayRun {
  readonly clock: ManualClock;
  readonly log = memoryLog();
  readonly push: RecordingSender = new RecordingSender();
  relay: Relay | undefined;
  #listener: RelayListener | undefined;
  #store: RelayStore | undefined;
  port = 0;

  constructor(
    readonly folder: string,
    readonly options: RelayRunOptions = {},
  ) {
    this.clock = options.clock ?? new ManualClock(Date.UTC(2026, 10, 18, 12));
  }

  get url(): string {
    return `ws://127.0.0.1:${String(this.port)}`;
  }

  start(): this {
    const real = need(openStore(join(this.folder, "relay.db")));
    const store = this.options.store?.(real) ?? real;
    const pseudonyms = need(Pseudonyms.start(this.clock));
    const relay = Relay.start({
      clock: this.clock,
      log: this.log,
      store,
      push: this.options.sender ?? this.push,
      version: "0.1.0",
      roles: this.options.roles ?? ["relay", "releases"],
      pseudonyms,
      ...(this.options.releases === undefined ? {} : { releases: this.options.releases }),
      ...(this.options.refused === undefined ? {} : { refused: this.options.refused }),
    });
    const started = need(relay);
    const listener = need(listen(started, { hostname: "127.0.0.1", port: this.port }));
    this.relay = started;
    this.#listener = listener;
    this.#store = store;
    this.port = listener.port;
    return this;
  }

  /** Stops it: every hub link closes 1001, as the relay's own stop does, and the port is free. */
  async stop(): Promise<void> {
    this.relay?.stop();
    await this.#listener?.stop();
    this.#store?.close();
    this.relay = undefined;
    this.#listener = undefined;
    this.#store = undefined;
  }

  get joined(): number {
    return this.relay?.counts.joined ?? 0;
  }

  /** The targets the relay stored for a hub. */
  targets(identity: string): readonly RosterTarget[] {
    const store = this.#store;
    if (store === undefined) return [];
    return need(store.targets(identity));
  }
}

const runs: RelayRun[] = [];
const folders: string[] = [];
const clients: RelayClient[] = [];

/** A relay in a new folder, started. */
export function startRelayRun(options: RelayRunOptions = {}): RelayRun {
  const folder = tempFolder();
  folders.push(folder);
  const run = new RelayRun(folder, options).start();
  runs.push(run);
  return run;
}

/** Stops every relay and client the tests started, and removes their folders. */
export async function stopAll(): Promise<void> {
  for (const client of clients.splice(0)) client.stop();
  for (const run of runs.splice(0)) await run.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
}

// ----- The hub's relay client -----

export interface ClientOptions {
  readonly key: StaticKey;
  readonly channel?: StreamChannel;
  readonly pushKeys?: MemoryPushKeys;
  readonly connect?: RelaySocketFactory;
  /** The four bytes of each jitter draw; `NO_JITTER` when not given. */
  readonly jitter?: Uint8Array;
  readonly uploads?: UploadStore;
  readonly stage?: (job: JobId, work: FileWork) => JobStarted;
  readonly wanted?: ReleaseOptions["wanted"];
  readonly firmware?: () => string | undefined;
  readonly platform?: "darwin-arm64" | "linux-arm64" | "linux-x64" | "windows-x64";
}

/** A channel that refuses nothing and records what it is given, when a test needs no sessions. */
export function nullChannel(): StreamChannel {
  const ids = new ConnIds();
  return {
    admit: (address, handshake) => ({
      refused: false,
      address,
      handshake: handshake ?? "session",
      used: false,
    }),
    cancel: () => undefined,
    open: () => ids.next(),
    receive: () => undefined,
    closed: () => undefined,
  };
}

export interface ClientSide {
  readonly client: RelayClient;
  readonly timers: ManualTimers;
  readonly events: HubEvent[];
  readonly reports: HubError[];
  readonly pushKeys: MemoryPushKeys;
  readonly uploads: UploadStore;
  readonly wakes: { count: number };
  of<K extends HubEvent["kind"]>(kind: K): Extract<HubEvent, { readonly kind: K }>[];
  /** The `relayLink` events so far, as `state:reason`. */
  links(): string[];
}

/** A relay client with timers the test moves, every event and report kept and noted for leaks. */
export function makeClient(options: ClientOptions): ClientSide {
  const timers = new ManualTimers();
  const events: HubEvent[] = [];
  const reports: HubError[] = [];
  const wakes = { count: 0 };
  const pushKeys = options.pushKeys ?? new MemoryPushKeys();
  const folder = tempFolder();
  folders.push(folder);
  const uploads = options.uploads ?? new UploadStore(folder);
  need(uploads.clearAll());
  const jitter = options.jitter ?? NO_JITTER;
  const client = new RelayClient({
    staticKey: options.key,
    hubVersion: "0.1.0",
    channel: options.channel ?? nullChannel(),
    pushKeys,
    emit: (event) => {
      noteValue(event);
      events.push(event);
    },
    report: (error) => {
      noteValue(error);
      reports.push(error);
    },
    timers,
    now: () => timers.now,
    random: (length) => (length === 4 ? ok(jitter.slice()) : randomBytes(length, "test")),
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    releases: {
      platform: options.platform ?? "linux-arm64",
      running: "0.1.0",
      firmware: options.firmware ?? (() => undefined),
      uploads,
      conn: new ConnIds().next(),
      wanted: options.wanted ?? (() => true),
      stage:
        options.stage ??
        (() => ({ kind: "ready", outcome: { kind: "failed", reason: "io", message: "no stage" } })),
      wake: () => {
        wakes.count += 1;
      },
    },
  });
  clients.push(client);
  const of = <K extends HubEvent["kind"]>(kind: K) =>
    events.filter((e): e is Extract<HubEvent, { readonly kind: K }> => e.kind === kind);
  return {
    client,
    timers,
    events,
    reports,
    pushKeys,
    uploads,
    wakes,
    of,
    links: () => of("relayLink").map((e) => (e.state === "up" ? "up" : `down:${e.reason ?? "?"}`)),
  };
}

/** A hub identity's text, for a static key. */
export function identityOf(key: StaticKey, sha: (b: Uint8Array) => Uint8Array): string {
  return formatIdentity(sha(key.publicKey).slice(0, 16));
}

// ----- A phone, through the relay -----

/** A phone's WebSocket to `<relay>/v1/phone/<identity>/<path>`: binary messages kept, its close. */
export class RelayPhone {
  readonly #ws: WebSocket;
  readonly #inbox: Uint8Array[] = [];
  closedWith: number | undefined;
  opened = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.opened = true;
    };
    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) this.#inbox.push(new Uint8Array(event.data));
    };
    ws.onclose = (event: CloseEvent) => {
      this.closedWith = event.code;
    };
  }

  static async open(
    relayUrl: string,
    identity: string,
    path: "session" | "link" | "restore",
  ): Promise<RelayPhone> {
    const phone = new RelayPhone(new WebSocket(`${relayUrl}/v1/phone/${identity}/${path}`));
    await until(() => phone.opened || phone.closedWith !== undefined, "the phone's socket");
    return phone;
  }

  send(bytes: Uint8Array): void {
    this.#ws.send(bytes);
  }

  close(code = 1000): void {
    this.#ws.close(code);
  }

  /** The next message, or undefined when the socket closed or `ms` passed. */
  async next(ms = 3000): Promise<Uint8Array | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const message = this.#inbox.shift();
      if (message !== undefined) return message;
      if (this.closedWith !== undefined || Date.now() > end) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async closed(ms = 3000): Promise<number | undefined> {
    await until(() => this.closedWith !== undefined, "the phone's socket to close", ms);
    return this.closedWith;
  }
}

/** An X25519 static key made for the test from `seed`, its private half noted for the leak guard. */
export function staticKeyOf(seed: number): StaticKey {
  const bytes = testKey(sha256(Uint8Array.of(seed, 0x77)));
  const key = x25519StaticKey(bytes);
  if (!key.ok) expect(key.error as string).toBe("a key");
  return key.ok ? key.value : { publicKey: new Uint8Array(32), dh: () => Promise.resolve(bytes) };
}

/** A test key, noted for the leak guard. */
export function testKey(bytes: Uint8Array): Uint8Array {
  noteKey(bytes);
  return bytes;
}

/** A socket factory that refuses every attempt at once, as a relay that is not there does. */
export const NOWHERE: RelaySocketFactory = (_url, events) => {
  queueMicrotask(() => {
    events.closed(1006);
  });
  return ok({
    sendText: () => err({ kind: "link", origin: "test", message: "closed" }),
    sendBinary: () => err({ kind: "link", origin: "test", message: "closed" }),
    close: () => undefined,
  });
};

// ----- A scripted relay in memory, for what B2's relay will not do on cue -----

/**
 * One link to a scripted relay: the responder's side of XN with `@hsn/protocol`'s own code, then
 * whatever the test says. It answers `ping` with `pong` unless told not to, keeps every text frame
 * the hub sent, and closes with any code the test names.
 */
export class ScriptedLink {
  readonly frames: HubToRelayFrame[] = [];
  readonly binaries: Uint8Array[] = [];
  pong = true;
  joined = false;
  closedByHub: number | undefined;
  #events: RelaySocketEvents;
  #handshake: Handshake | undefined;
  #step = 0;
  #ended = false;

  constructor(
    events: RelaySocketEvents,
    readonly script: ScriptedRelay,
  ) {
    this.#events = events;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** The relay closes the link with `code`. */
  close(code: number): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#events.closed(code);
  }

  /** A text frame from the relay. */
  send(frame: RelayToHubFrame): void {
    if (!this.#ended) this.#events.text(JSON.stringify(frame));
  }

  /** Raw text from the relay, valid or not. */
  sendRaw(text: string): void {
    if (!this.#ended) this.#events.text(text);
  }

  sendBinary(bytes: Uint8Array): void {
    if (!this.#ended) this.#events.binary(bytes);
  }

  /** The frames of kind `t` the hub sent. */
  sent<T extends HubToRelayFrame["t"]>(t: T): Extract<HubToRelayFrame, { t: T }>[] {
    return this.frames.filter((f): f is Extract<HubToRelayFrame, { t: T }> => f.t === t);
  }

  open(): void {
    if (!this.#ended) this.#events.open();
  }

  async fromHub(data: string | Uint8Array): Promise<void> {
    if (this.#ended) return;
    if (typeof data === "string") {
      const frame = JSON.parse(data) as HubToRelayFrame;
      this.frames.push(frame);
      if (frame.t === "ping" && this.pong) this.send({ t: "pong", n: frame.n });
      return;
    }
    if (this.joined) {
      this.binaries.push(data);
      return;
    }
    if (this.#step === 0) {
      this.#step = 1;
      const started = startRelayResponder("hub");
      if (!started.ok) return;
      this.#handshake = started.value;
      const hello = await this.#handshake.readMessage(data);
      if (!hello.ok || this.script.silent) return;
      const welcome = encodeRelayWelcome({
        proto: 1,
        relay: "0.1.0",
        roles: ["relay", "releases"],
        limits: this.script.limits,
      });
      if (!welcome.ok) return;
      const message2 = await this.#handshake.writeMessage(welcome.value);
      if (message2.ok) this.sendBinary(message2.value);
      return;
    }
    const handshake = this.#handshake;
    if (handshake === undefined) return;
    const join = await handshake.readMessage(data);
    if (!join.ok) return;
    const identity = provedIdentity(handshake);
    this.joined = true;
    this.send({ t: "joined", identity: identity ?? "" });
  }
}

/** A relay in memory: every link the hub opens, scripted by the test. */
export class ScriptedRelay {
  readonly links: ScriptedLink[] = [];
  /** No message 2: the handshake never finishes. */
  silent = false;
  /** Refuse the TCP connection: every attempt closes 1006 at once. */
  down = false;
  limits: RelayWelcome["limits"] = {
    maxRosterBytes: 131_072,
    maxPushItemsPerFrame: 32,
    maxReleasePieceBytes: 262_144,
    maxRestartWithinMs: 600_000,
  };

  get last(): ScriptedLink | undefined {
    return this.links.at(-1);
  }

  readonly connect: RelaySocketFactory = (_url, events) => {
    if (this.down) return NOWHERE(_url, events);
    const link = new ScriptedLink(events, this);
    this.links.push(link);
    queueMicrotask(() => {
      link.open();
    });
    return ok({
      sendText: (text) => {
        if (link.ended) return err({ kind: "link", origin: "test", message: "closed" });
        void link.fromHub(text);
        return ok(undefined);
      },
      sendBinary: (bytes) => {
        if (link.ended) return err({ kind: "link", origin: "test", message: "closed" });
        void link.fromHub(bytes.slice());
        return ok(undefined);
      },
      close: (code) => {
        link.closedByHub = code;
        link.close(code);
      },
    });
  };
}

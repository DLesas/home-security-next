/**
 * What the relay's tests share: a clock the test moves, a log that keeps its lines, a recording
 * `PushSender`, a relay started on loopback against a real SQLite file, and stand-ins for a hub
 * and a phone built on `@hsn/protocol`'s own code (B1's XN, frames and phone paths).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { type StaticKey, x25519StaticKey } from "@hsn/protocol/app";
import {
  decodeRelayWelcome,
  decodeTextFrame,
  encodeRelayHello,
  encodeRelayJoin,
  encodeTextFrame,
  type HubToRelayFrame,
  type PushOutcome,
  RELAY_BINARY_KIND,
  relayBinaryCodec,
  relayIdentity,
  type RelayPushItem,
  type RelayToHubFrame,
  type RelayWelcome,
  type RosterTarget,
  startRelayInitiator,
} from "@hsn/protocol/relay";
import { expect } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { PresenceCore } from "../src/core/presence.ts";
import type { PushSender, PushSendError, PushSendResult } from "../src/push/sender.ts";
import type { ReleaseAnswers } from "../src/releases/service.ts";
import type { RelayClock } from "../src/shell/clock.ts";
import { jsonLineLog, type RelayLog } from "../src/shell/log.ts";
import { Pseudonyms } from "../src/shell/pseudonym.ts";
import { Relay } from "../src/shell/relay.ts";
import { listen, type RelayListener } from "../src/shell/server.ts";
import { openStore, type RelayStore } from "../src/shell/storage/store.ts";

/** The value of a result that must be ok; the test fails on the error otherwise. */
export function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown }
    | { isOk(): boolean; _unsafeUnwrap(): T; _unsafeUnwrapErr(): unknown },
): T {
  if ("ok" in result) {
    if (!result.ok) expect(String(result.error)).toBe("no error");
    return (result as { readonly value: T }).value;
  }
  if (!result.isOk()) expect(JSON.stringify(result._unsafeUnwrapErr())).toBe("no error");
  return result._unsafeUnwrap();
}

export function tempFolder(): string {
  return mkdtempSync(join(tmpdir(), "hsn-relay-test-"));
}

export function cleanup(folder: string): void {
  rmSync(folder, { recursive: true, force: true });
}

/** A clock the test moves by hand; timers run as it passes them, in order. */
export class ManualClock implements RelayClock {
  private timers: { at: number; run: () => void; id: number }[] = [];
  private nextId = 0;
  constructor(public ms: number) {}
  now(): number {
    return this.ms;
  }
  after(ms: number, run: () => void): () => void {
    const id = this.nextId++;
    this.timers.push({ at: this.ms + ms, run, id });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }
  /**
   * Timers run at one instant before the driver calls it a spin: a timer that re-arms itself for
   * a time not after now, without end, fails the test at once instead of hanging the run.
   */
  static readonly MAX_RUNS_AT_ONE_INSTANT = 10_000;

  advance(ms: number): void {
    const end = this.ms + ms;
    let runsHere = 0;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      runsHere = due.at > this.ms ? 1 : runsHere + 1;
      if (runsHere > ManualClock.MAX_RUNS_AT_ONE_INSTANT) {
        expect(`timers due at ${this.ms} ran ${runsHere} times without the clock moving`).toBe(
          "progress",
        );
      }
      this.ms = Math.max(this.ms, due.at);
      due.run();
    }
    this.ms = end;
  }
  /** Moves to an absolute time. */
  to(ms: number): void {
    this.advance(ms - this.ms);
  }
  get pending(): number {
    return this.timers.length;
  }
}

/** A log that keeps every line, for the tests that search it. */
export function memoryLog(): RelayLog & { readonly lines: string[]; text(): string } {
  const lines: string[] = [];
  const log = jsonLineLog(
    (line) => lines.push(line),
    () => 0,
  );
  return {
    write: (level, event, fields, error) => {
      log.write(level, event, fields, error);
    },
    lines,
    text: () => lines.join(""),
  };
}

/** Lines of a log with the event `event`, parsed. */
export function events(log: { lines: string[] }, event: string): Record<string, unknown>[] {
  return log.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === event);
}

/**
 * A `PushSender` that records every item and answers as told: an outcome per item (by default
 * `accepted`), or an error for the whole batch.
 */
export class RecordingSender implements PushSender {
  readonly sent: RelayPushItem[][] = [];
  up = true;
  outcome: (item: RelayPushItem) => PushOutcome = () => "accepted";
  error: PushSendError | undefined;
  /** When set, `send` waits for this before answering. */
  hold: Promise<void> | undefined;

  send(items: readonly RelayPushItem[]): ResultAsync<readonly PushSendResult[], PushSendError> {
    this.sent.push([...items]);
    const error = this.error;
    if (error !== undefined) return errAsync(error);
    const results = items.map((item) => ({ id: item.id, outcome: this.outcome(item) }));
    const hold = this.hold;
    if (hold === undefined) return okAsync(results);
    return ResultAsync.fromSafePromise(hold).map(() => results);
  }

  /** Every item sent, flat. */
  get items(): RelayPushItem[] {
    return this.sent.flat();
  }
}

/** Waits until `ready()` holds, checking as events run (no fixed sleep); fails after `ms`. */
export async function until(
  ready: () => boolean,
  what = "the condition",
  ms = 3000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) expect(`${what} within ${ms} ms`).toBe("met");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Lets pending socket events and promises run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

export interface TestRelay {
  readonly relay: Relay;
  readonly listener: RelayListener;
  readonly url: string;
  readonly clock: ManualClock;
  readonly log: ReturnType<typeof memoryLog>;
  readonly push: RecordingSender;
  readonly store: RelayStore;
  readonly dbPath: string;
  stop(): Promise<void>;
}

export interface TestRelayOptions {
  readonly clock?: ManualClock;
  readonly push?: RecordingSender;
  /** A sender other than a recording one (the real relay link); `push` then records nothing. */
  readonly sender?: PushSender;
  readonly dbPath?: string;
  readonly releases?: ReleaseAnswers;
  readonly trustedProxies?: readonly string[];
  readonly refused?: ReadonlySet<string>;
  readonly roles?: RelayWelcome["roles"];
  readonly presenceCore?: PresenceCore;
}

/** A relay on loopback, port chosen by the system, on a real SQLite file. */
export function startRelay(folder: string, options: TestRelayOptions = {}): TestRelay {
  const clock = options.clock ?? new ManualClock(Date.UTC(2026, 10, 18, 12));
  const log = memoryLog();
  const push = options.push ?? new RecordingSender();
  const dbPath = options.dbPath ?? join(folder, "relay.db");
  const store = must(openStore(dbPath));
  const relay = must(
    Relay.start({
      clock,
      log,
      store,
      push: options.sender ?? push,
      version: "0.1.0",
      roles: options.roles ?? ["relay", "releases"],
      pseudonyms: must(Pseudonyms.start(clock)),
      ...(options.releases === undefined ? {} : { releases: options.releases }),
      ...(options.refused === undefined ? {} : { refused: options.refused }),
      ...(options.presenceCore === undefined ? {} : { presenceCore: options.presenceCore }),
    }),
  );
  const listener = must(
    listen(relay, {
      hostname: "127.0.0.1",
      port: 0,
      ...(options.trustedProxies === undefined ? {} : { trustedProxies: options.trustedProxies }),
    }),
  );
  return {
    relay,
    listener,
    url: `ws://127.0.0.1:${listener.port}`,
    clock,
    log,
    push,
    store,
    dbPath,
    async stop() {
      await listener.stop();
      store.close();
    },
  };
}

/** A hub's static key, made for the test, and its identity. */
export function hubKey(): { readonly key: StaticKey; readonly identity: string } {
  const key = must(x25519StaticKey(new Uint8Array(randomBytes(32))));
  const identity = relayIdentity(key.publicKey);
  if (identity === undefined) expect("an identity").toBe("made");
  return { key, identity: identity ?? "" };
}

/** A WebSocket client that keeps what arrives and how it closed. */
export class Client {
  readonly texts: string[] = [];
  readonly binaries: Uint8Array[] = [];
  closeCode: number | undefined;
  opened = false;
  failed = false;
  readonly socket: WebSocket;

  constructor(url: string, address?: string) {
    this.socket = new WebSocket(url, {
      headers: address === undefined ? {} : { "x-forwarded-for": address },
    } as unknown as string[]);
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => {
      this.opened = true;
    };
    this.socket.onerror = () => {
      this.failed = true;
    };
    this.socket.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === "string") this.texts.push(data);
      else if (data instanceof ArrayBuffer) this.binaries.push(new Uint8Array(data));
    };
    this.socket.onclose = (event: CloseEvent) => {
      this.closeCode = event.code;
    };
  }

  async open(): Promise<void> {
    await until(
      () => this.opened || this.closeCode !== undefined || this.failed,
      "the socket to open",
    );
  }

  async closed(): Promise<number | undefined> {
    await until(() => this.closeCode !== undefined, "the socket to close");
    return this.closeCode;
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data);
  }

  close(code = 1000): void {
    this.socket.close(code);
  }
}

/** A stand-in hub: XN as the initiator with its own key, then frames. */
export class StandInHub {
  readonly client: Client;
  welcome: RelayWelcome | undefined;
  private seen = 0;

  private constructor(
    url: string,
    readonly key: StaticKey,
    readonly identity: string,
    address?: string,
  ) {
    this.client = new Client(`${url}/v1/hub`, address);
  }

  /** Connects and runs the handshake; `joined` is checked unless `expectJoin` is false. */
  static async connect(
    url: string,
    options: {
      key?: { key: StaticKey; identity: string };
      address?: string;
      proto?: [number, number];
    } = {},
  ): Promise<StandInHub> {
    const { key, identity } = options.key ?? hubKey();
    const hub = new StandInHub(url, key, identity, options.address);
    await hub.client.open();
    if (hub.client.closeCode !== undefined || hub.client.failed) return hub;
    const handshake = must(startRelayInitiator("hub", key));
    const hello = must(encodeRelayHello({ proto: options.proto ?? [1, 1], hub: "0.1.0" }));
    hub.client.send(must(await handshake.writeMessage(hello)));
    await until(
      () => hub.client.binaries.length > 0 || hub.client.closeCode !== undefined,
      "message 2",
    );
    const message2 = hub.client.binaries.shift();
    if (message2 === undefined) return hub;
    const payload = must(await handshake.readMessage(message2));
    hub.welcome = must(decodeRelayWelcome(payload));
    hub.client.send(must(await handshake.writeMessage(must(encodeRelayJoin({})))));
    await until(
      () => hub.client.texts.length > 0 || hub.client.closeCode !== undefined,
      "joined or a close",
    );
    return hub;
  }

  /** Every text frame from the relay so far, decoded. */
  frames(): RelayToHubFrame[] {
    return this.client.texts.map((text) => must(decodeTextFrame("relayToHub", text)));
  }

  /** Waits for the next frame of kind `t` not yet taken. */
  async next<T extends RelayToHubFrame["t"]>(t: T): Promise<Extract<RelayToHubFrame, { t: T }>> {
    let found: RelayToHubFrame | undefined;
    await until(() => {
      const all = this.frames();
      for (let i = this.seen; i < all.length; i++) {
        if (all[i]?.t === t) {
          found = all[i];
          this.seen = i + 1;
          return true;
        }
      }
      return false;
    }, `a ${t} frame`);
    return found as Extract<RelayToHubFrame, { t: T }>;
  }

  send(frame: HubToRelayFrame): void {
    this.client.send(must(encodeTextFrame("hubToRelay", frame)));
  }

  /** A kind 1 frame for a stream. */
  sendStream(stream: number, message: Uint8Array): void {
    this.client.send(
      must(relayBinaryCodec.encode({ kind: RELAY_BINARY_KIND.streamData, stream, message })),
    );
  }

  /** Kind 1 messages received for `stream`. */
  streamMessages(stream: number): Uint8Array[] {
    return this.decodedBinaries()
      .filter((f) => f.kind === RELAY_BINARY_KIND.streamData && f.stream === stream)
      .map((f) => (f.kind === RELAY_BINARY_KIND.streamData ? f.message : new Uint8Array()));
  }

  /** Kind 2 pieces received, by request id. */
  pieces(): Map<number, Uint8Array> {
    const out = new Map<number, Uint8Array>();
    for (const f of this.decodedBinaries()) {
      if (f.kind === RELAY_BINARY_KIND.releasePiece) out.set(f.id, f.bytes);
    }
    return out;
  }

  private decodedBinaries() {
    return this.client.binaries.map((b) => must(relayBinaryCodec.decode(b)));
  }

  get joined(): boolean {
    return this.client.texts.some((t) => t.includes('"t":"joined"'));
  }
}

/** A target for a roster, with sealed alerts of the right form (their content is not opened here). */
export function target(n: number): RosterTarget {
  const keyHex = n.toString(16).padStart(16, "0");
  const sealed = (mark: string) => `1.${keyHex}.${mark.repeat(1744).slice(0, 1744)}`;
  return {
    key: keyHex,
    platform: "fcm",
    env: "production",
    token: `token-${n}`,
    unreachable: sealed("U"),
    back: sealed("B"),
  };
}

/** A sealed `h` of the right form for a push item. */
export function sealedH(keyHex: string, mark = "P"): string {
  return `1.${keyHex}.${mark.repeat(1744)}`;
}

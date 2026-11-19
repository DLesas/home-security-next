/**
 * A phone away from home, on the phone's own client code (`app/src/hub/`, which runs under `bun
 * test`): the QR code read by `readCode`, linking by `linkClient`, the session and every request by
 * `Channel`, the phone's key from `keys.native.ts`, its record in `memoryRecordStore`, `seq`
 * reserved by `reserveSeq` (m3-design.md sections 2 to 4). What the phone design has not built yet
 * is made here, from the protocol package's own pieces, and named as such:
 *
 * - **The relay `Connect`** (P2's, not built: `finder.ts` says "the relay comes after (M5)"): a
 *   WebSocket to `<relay>/v1/phone/<identity>/<session|link|restore>` (`phoneStreamUrl`), each
 *   binary message one Noise message (m4-design.md section 3, "Phones"), handed to the channel as
 *   the home `Connect` is.
 * - **Push registration's keys** (P1's extension storage, not built): a push key and key id made
 *   here, sent with `push.register` through the channel.
 * - **The lock screen's Disarm** (the phone design's background JavaScript, not built): `disarm
 *   {target: "mine"}` as `first` of an IK session (`clientHello.first`), one and a half round trips,
 *   built with `@hsn/protocol`'s Noise as the phone's `openSession` is.
 * - **Opening a push** (P1's Swift and Kotlin, not runnable here): `pushOpener`, the protocol
 *   package's opener, with the key this phone registered.
 */
import { randomBytes } from "node:crypto";
import {
  clientHello,
  hubHello,
  NOISE_PATTERNS,
  parseIdentity,
  type PushContent,
  sessionPrologue,
  startHandshake,
} from "@hsn/protocol/app";
import { phoneStreamUrl, pushOpener } from "@hsn/protocol/relay";
import { decodeJson, encodeJson } from "../../../app/src/hub/codec.ts";
import { CLOSE, Inbox, realTimers } from "../../../app/src/hub/wire.ts";
import {
  type AnyOutcome,
  type Channel,
  type ChannelStatus,
  type Connect,
  phoneModules,
  type RecordStore,
  type StoredClient,
  type Wire,
} from "./phone-code.ts";

const APP_VERSION = "2.0.0";

/** Every relay socket a phone here opened, and how each ended: for the tests' own checks. */
export interface RelayWire {
  readonly path: string;
  closedWith: number | undefined;
}

/**
 * The relay `Connect` (P2's, not built): the channel's paths on the relay's phone path, Bun's
 * WebSocket in place of React Native's, one binary message per Noise message, a text message
 * refused as the home `Connect` refuses one.
 */
export function relayConnect(relayUrl: string, identity: string, wires: RelayWire[] = []): Connect {
  return (path, handlers) =>
    new Promise((resolve) => {
      const url = phoneStreamUrl(relayUrl, { identity, path });
      if (url === undefined) {
        resolve(undefined);
        return;
      }
      const record: RelayWire = { path, closedWith: undefined };
      wires.push(record);
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      let opened = false;
      socket.onopen = () => {
        opened = true;
        resolve({
          send: (data) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(data.slice());
          },
          close: (code = CLOSE.normal) => {
            socket.close(code);
          },
        });
      };
      socket.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) handlers.message(new Uint8Array(event.data));
        else socket.close(CLOSE.protocol);
      };
      socket.onclose = (event: CloseEvent) => {
        record.closedWith = event.code;
        if (opened) handlers.closed(event.code);
        else resolve(undefined);
      };
    });
}

/** The push key a phone gives one hub (D126), made here as the extension's storage would hold it. */
export interface PhonePushKey {
  readonly keyId: Uint8Array;
  readonly key: Uint8Array;
}

export class AwayPhone {
  readonly wires: RelayWire[] = [];
  readonly statuses: ChannelStatus["kind"][] = [];
  readonly events: { readonly ev: string; readonly body: unknown }[] = [];
  readonly push: PhonePushKey = {
    keyId: new Uint8Array(randomBytes(8)),
    key: new Uint8Array(randomBytes(32)),
  };
  #channel: Channel | undefined;
  readonly #others: Channel[] = [];
  #status: ChannelStatus = { kind: "loading" };

  private constructor(
    readonly name: string,
    readonly relayUrl: string,
    readonly store: RecordStore,
    readonly record: StoredClient,
    readonly backupKey: { readonly key: string; readonly epoch: number } | undefined,
  ) {}

  get identity(): string {
    return this.record.hub.identity;
  }

  get client(): number {
    return this.record.hub.client;
  }

  /**
   * Links from a link QR code (`link.create {form: "qr"}`) through the relay the code names
   * (`r=`), or `relayUrl` when it names none (the default relay).
   */
  static async link(
    qr: string,
    name: string,
    relayUrl?: string,
    /** Reach the relay at `relayUrl` even when the code names another address for it. */
    override = false,
  ): Promise<AwayPhone | { readonly failed: string }> {
    const app = await phoneModules();
    const read = app.readCode(qr);
    // Never the code itself in a failure: it holds the link's secret.
    if (!read.ok || read.value.kind !== "link")
      return { failed: `the code: ${read.ok ? read.value.kind : read.fault}` };
    const secret = read.value.secret;
    const relay = override ? relayUrl : (secret.reach?.relay ?? relayUrl);
    const identity = secret.kind === "secret" ? secret.identity : undefined;
    if (relay === undefined || identity === undefined) return { failed: "no relay or identity" };
    const wires: RelayWire[] = [];
    const linked = await app.linkClient(
      relayConnect(relay, identity, wires),
      secret,
      { name, kind: "phone" },
      realTimers,
      app.PHONE_PROTO,
      app.keys,
    );
    if (!linked.ok) return { failed: linked.fault };
    const store = app.memoryRecordStore(linked.value.record);
    const phone = new AwayPhone(
      name,
      relay,
      store,
      linked.value.record,
      linked.value.result.backupKey,
    );
    phone.wires.push(...wires);
    return phone;
  }

  /** The relay a code names (`r=`): a hub whose relay is not the default's says so. */
  static async relayOf(qr: string): Promise<string | undefined> {
    const read = (await phoneModules()).readCode(qr);
    return read.ok && read.value.kind === "link" ? read.value.secret.reach?.relay : undefined;
  }

  get status(): ChannelStatus["kind"] {
    return this.#status.kind;
  }

  /** Starts the channel through the relay; true once the session is open. */
  async open(ms = 20_000): Promise<boolean> {
    this.#channel?.stop();
    const app = await phoneModules();
    const channel = new app.Channel({
      connect: relayConnect(this.relayUrl, this.identity, this.wires),
      store: this.store,
      timers: realTimers,
      app: APP_VERSION,
      proto: app.PHONE_PROTO,
      keys: app.keys,
      listener: {
        status: (status) => {
          this.#status = status;
          this.statuses.push(status.kind);
        },
        snapshot: () => undefined,
        event: (event) => {
          this.events.push({ ev: event.ev, body: event.body });
        },
        newEvent: (event) => {
          this.events.push({ ev: event.ev, body: event.body });
        },
      },
    });
    this.#channel = channel;
    void channel.start();
    const end = Date.now() + ms;
    while (this.#status.kind !== "open" && Date.now() < end) await Bun.sleep(20);
    return this.#status.kind === "open";
  }

  /**
   * Another session of this phone, on another path (the home's, say), sharing its record and so
   * its `seq`: as the phone moves between paths (m4-design section 8). True once it is open.
   */
  async openAlso(
    connect: Connect,
    ms = 20_000,
  ): Promise<{ readonly channel: Channel; readonly open: boolean }> {
    const app = await phoneModules();
    const state: { status: ChannelStatus["kind"] } = { status: "loading" };
    const channel = new app.Channel({
      connect,
      store: this.store,
      timers: realTimers,
      app: APP_VERSION,
      proto: app.PHONE_PROTO,
      keys: app.keys,
      listener: {
        status: (next) => {
          state.status = next.kind;
        },
        snapshot: () => undefined,
        event: () => undefined,
      },
    });
    this.#others.push(channel);
    void channel.start();
    const end = Date.now() + ms;
    while (state.status !== "open" && Date.now() < end) await Bun.sleep(20);
    return { channel, open: state.status === "open" };
  }

  /** One request through the session (version 2's operations included). */
  async request(op: string, body: unknown): Promise<AnyOutcome> {
    const channel = this.#channel;
    if (channel === undefined) return { ok: false, local: "offline" };
    return channel.forward(op, body);
  }

  /** `push.register` with this phone's push key (D126). */
  async registerPush(platform: "apns" | "fcm", token: string): Promise<AnyOutcome> {
    return this.request("push.register", {
      platform,
      environment: platform === "apns" ? "development" : "production",
      token,
      keyId: Buffer.from(this.push.keyId).toString("hex"),
      key: Buffer.from(this.push.key).toString("base64url"),
    });
  }

  /** Opens a sealed push with this phone's key, as the extension would; undefined if it cannot. */
  openPush(h: string): PushContent | undefined {
    const opened = pushOpener.open(h, (keyId) =>
      Buffer.from(keyId).equals(Buffer.from(this.push.keyId)) ? this.push.key : undefined,
    );
    return opened.ok ? opened.value : undefined;
  }

  stop(): void {
    this.#channel?.stop();
    this.#channel = undefined;
    for (const other of this.#others.splice(0)) other.stop();
  }

  /**
   * The lock screen's Disarm (not built on the phone): `disarm {target: "mine"}` as `first` of an
   * IK session through `connect`, the path that answers; its reply, or why there was none.
   */
  async disarmFirst(
    paths: readonly Connect[] = [relayConnect(this.relayUrl, this.identity, this.wires)],
  ): Promise<{
    readonly reply?: Record<string, unknown>;
    readonly failed?: string;
    readonly path?: number;
  }> {
    const stored = await this.store.read();
    const record = stored.ok && stored.value !== undefined ? stored.value : this.record;
    const identity = parseIdentity(record.hub.identity);
    if (identity === undefined) return { failed: "identity" };
    const app = await phoneModules();
    const seq = await app.reserveSeq(this.store);
    if (seq === undefined) return { failed: "seq" };
    const first = { t: "req", id: 1, seq, op: "disarm", body: { target: "mine" } } as const;
    const hello = clientHello.parse({ proto: app.PHONE_PROTO, app: APP_VERSION, first });
    const started = startHandshake({
      pattern: NOISE_PATTERNS.session,
      initiator: true,
      prologue: sessionPrologue(identity),
      staticKey: app.keys.staticKeyOf(record.key),
      remoteStatic: record.hub.staticKey,
    });
    if (!started.ok) return { failed: "handshake" };
    const message1 = await started.value.writeMessage(encodeJson(hello));
    if (!message1.ok) return { failed: "message 1" };
    // The first path that answers (home, then the relay, as the phone tries them).
    const inbox = new Inbox(realTimers);
    let wire: Wire | undefined;
    let path = -1;
    for (const [n, connect] of paths.entries()) {
      wire = await connect("session", {
        message: (data) => {
          inbox.push(data);
        },
        closed: (code) => {
          inbox.close(code);
        },
      });
      if (wire !== undefined) {
        path = n;
        break;
      }
    }
    if (wire === undefined) return { failed: "unreachable" };
    wire.send(message1.value);
    const second = await inbox.next(10_000);
    if (second.kind !== "message") {
      wire.close();
      return { failed: `message 2: ${second.kind}` };
    }
    const read = await started.value.readMessage(second.data);
    const helloBack = read.ok ? hubHello.safeParse(decodeJson(read.value)?.value) : undefined;
    const transport = started.value.split();
    if (helloBack?.success !== true || !transport.ok) {
      wire.close();
      return { failed: "hub hello" };
    }
    // The companion message: the first transport message proves the session (m2-design section
    // 5), and only then is `first` acted on; one and a half round trips in all.
    const companion = transport.value.encrypt(
      encodeJson({ t: "req", id: 2, op: "pong", body: {} }),
    );
    if (!companion.ok) {
      wire.close();
      return { failed: "companion" };
    }
    wire.send(companion.value);
    // The reply to `first`, among whatever else the hub sends.
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const next = await inbox.next(Math.max(1, end - Date.now()));
      if (next.kind !== "message") break;
      const opened = transport.value.decrypt(next.data);
      const frame = opened.ok ? decodeJson(opened.value)?.value : undefined;
      if (
        typeof frame === "object" &&
        frame !== null &&
        (frame as { t?: unknown }).t === "res" &&
        (frame as { id?: unknown }).id === 1
      ) {
        wire.close();
        return { reply: frame as Record<string, unknown>, path };
      }
    }
    wire.close();
    return { failed: "no reply to first" };
  }
}

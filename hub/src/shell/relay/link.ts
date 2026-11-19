/**
 * One attempt at the hub's link to its relay, `<relay url>/v1/hub` (docs/m4-design.md sections 3
 * and 4; D125): the socket, the Noise_XN handshake as the initiator with the hub's app static key
 * (`startRelayInitiator("hub", …)`, the same key as the app's IK sessions, QR2), and once the
 * relay's `joined` came, the keepalive and the frames.
 *
 * | Message | Direction | Payload |
 * | --- | --- | --- |
 * | 1 | hub → relay, `e` | `RelayHello {proto: [1, 1], hub}` |
 * | 2 | relay → hub, `e, ee` | `RelayWelcome {proto, relay, roles, limits}` |
 * | 3 | hub → relay, `s, se` | `RelayJoin {}`, answered by the text frame `joined {identity}` |
 *
 * - **In time.** The socket must open, the handshake finish and `joined` come within
 *   `JOIN_WITHIN_MS` (the relay's own 10 s ‡ for message 3 and the 15 s ‡ a `pong` may take), or
 *   the attempt ends as `handshake` (as `connect` when the socket never opened).
 * - **Keepalive at low cost (D112).** One timer at a time: a `ping` 30 s ‡ after the link came up
 *   or the last `pong`, then its `pong` within 15 s ‡, or the link is closed as `noPong`. Nothing
 *   of it reaches the core. `probe()` sends the `ping` at once (a change of the computer's
 *   addresses).
 * - **What ends it, and why** (`RelayDownReason`): the relay's close code (4001 `replaced`, 4426
 *   `version`, 4429 `limited`, 4408 `handshake`, 1001, 4400 and 4403 `closed`, 1006 `connect`), or
 *   the hub's own reason when it closed it (a frame it cannot read, 4400; no `pong`; too slow).
 *   A `limit` frame's `retryAfterMs` is kept for the owner, which waits that long after a 4429.
 * - Every frame the relay sends after `joined` is checked against `relayToHub`'s schema and the
 *   binary codec; anything else closes the link with 4400, as the relay does with the hub's.
 *
 * Nothing secret is logged or put in an error: the static key never leaves `staticKey`.
 */
import type { Handshake, StaticKey } from "@hsn/protocol/app";
import {
  decodeRelayWelcome,
  decodeTextFrame,
  encodeRelayHello,
  encodeRelayJoin,
  encodeTextFrame,
  type HubToRelayFrame,
  RELAY_CLOSE,
  RELAY_LIMITS,
  RELAY_PROTO,
  relayBinaryCodec,
  type RelayBinaryFrame,
  type RelayToHubFrame,
  type RelayWelcome,
  startRelayInitiator,
} from "@hsn/protocol/relay";
import { err, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { RelayDownReason } from "../../core/model/events.ts";
import type { Timers } from "../app/channel.ts";
import type { RelaySocket, RelaySocketFactory } from "../safe/relay-socket.ts";

const ORIGIN = "shell/relay/link";

/** The socket open, the handshake done and `joined` in, within this ‡. */
export const JOIN_WITHIN_MS = RELAY_LIMITS.handshakeMs + RELAY_LIMITS.pongWithinMs;

/** A WebSocket close code the hub uses for its own closes: a normal end. */
export const NORMAL_CLOSE = 1000;
/** The close code of a connection that failed or dropped without a close frame. */
export const ABNORMAL_CLOSE = 1006;

/** How an attempt ended. */
export interface LinkEnd {
  /** The relay's close code, or the code the hub closed with. */
  readonly code: number;
  /** As `relayLink {down}` names it. */
  readonly reason: RelayDownReason;
  /** True when the hub closed it itself (no `pong`, a bad frame, too slow, a stop). */
  readonly byHub: boolean;
  /** The link was joined. */
  readonly wasUp: boolean;
  /** How long it was joined, in milliseconds. */
  readonly upMs: number;
  /** The `retryAfterMs` of the last `limit` frame, if one came. */
  readonly limitRetryAfterMs: number | undefined;
}

/** What one attempt tells the relay client. */
export interface LinkOwner {
  /** `joined` came: the link is up. */
  joined(link: RelayLink, welcome: RelayWelcome): void;
  /** A text frame after `joined` that the link does not handle itself (all but `pong`, `limit`). */
  text(link: RelayLink, frame: RelayToHubFrame): void;
  binary(link: RelayLink, frame: RelayBinaryFrame): void;
  /** The attempt is over; nothing more comes from it. */
  ended(link: RelayLink, end: LinkEnd): void;
}

export interface LinkOptions {
  /** `<relay url>/v1/hub` (`hubLinkUrl`). */
  readonly url: string;
  /** The hub's app static key. */
  readonly staticKey: StaticKey;
  readonly hubVersion: string;
  readonly connect: RelaySocketFactory;
  readonly timers: Timers;
  /** Milliseconds on a monotonic clock. */
  readonly now: () => number;
  readonly owner: LinkOwner;
  readonly report: (error: HubError) => void;
}

type Phase = "connecting" | "hello" | "joining" | "up" | "ended";

/** A code a closed link reports as its reason (section 3, "Close codes on the hub link"). */
export function reasonOfClose(code: number, opened: boolean): RelayDownReason {
  switch (code) {
    case RELAY_CLOSE.replaced:
      return "replaced";
    case RELAY_CLOSE.noSharedVersion:
      return "version";
    case RELAY_CLOSE.overLimit:
      return "limited";
    case RELAY_CLOSE.handshakeTimeout:
      return "handshake";
    case ABNORMAL_CLOSE:
      return "connect";
    default:
      return opened ? "closed" : "connect";
  }
}

export class RelayLink {
  readonly url: string;
  readonly #o: LinkOptions;
  #phase: Phase = "connecting";
  #socket: RelaySocket | undefined;
  #handshake: Handshake | undefined;
  #opened = false;
  #upAt = 0;
  #welcome: RelayWelcome | undefined;
  #timer: (() => void) | undefined;
  #ping = 0;
  #awaitingPong: number | undefined;
  #limitRetryAfterMs: number | undefined;
  /** Set when the hub closes the link itself: the reason it gives. */
  #ownClose: { readonly code: number; readonly reason: RelayDownReason } | undefined;

  constructor(options: LinkOptions) {
    this.#o = options;
    this.url = options.url;
  }

  /** Whether `joined` came and the link has not ended. */
  get up(): boolean {
    return this.#phase === "up";
  }

  /** The relay's welcome, once message 2 was read. */
  get welcome(): RelayWelcome | undefined {
    return this.#welcome;
  }

  /** Opens the socket; the attempt runs from here, and `ended` is told exactly once. */
  start(): void {
    this.#arm(JOIN_WITHIN_MS, () => {
      this.#closeOwn(NORMAL_CLOSE, this.#opened ? "handshake" : "connect");
    });
    const opened = this.#o.connect(this.url, {
      open: () => {
        this.#opened = true;
        void this.#hello();
      },
      text: (text) => {
        this.#text(text);
      },
      binary: (bytes) => {
        void this.#binary(bytes);
      },
      closed: (code) => {
        this.#ended(code);
      },
    });
    if (opened.isErr()) {
      this.#o.report(opened.error);
      // Told after this call returns, as a socket's own close would be.
      queueMicrotask(() => {
        this.#ended(ABNORMAL_CLOSE);
      });
      return;
    }
    this.#socket = opened.value;
  }

  /** Sends one text frame on the joined link; an error when it is not up or the frame is refused. */
  sendText(frame: HubToRelayFrame): Result<void, HubError> {
    if (this.#phase !== "up" || this.#socket === undefined)
      return err({ kind: "link", origin: ORIGIN, message: "the relay link is not up" });
    const text = encodeTextFrame("hubToRelay", frame);
    if (!text.ok)
      return err({
        kind: "codec",
        origin: ORIGIN,
        message: `a ${frame.t} frame the relay would refuse: ${text.error}`,
      });
    return this.sendEncoded(text.value);
  }

  /** Sends text already encoded and checked (`encodeTextFrame`, `splitHubPushItems`). */
  sendEncoded(text: string): Result<void, HubError> {
    if (this.#phase !== "up" || this.#socket === undefined)
      return err({ kind: "link", origin: ORIGIN, message: "the relay link is not up" });
    return this.#socket.sendText(text);
  }

  /** Sends one binary frame on the joined link. */
  sendBinary(frame: RelayBinaryFrame): Result<void, HubError> {
    if (this.#phase !== "up" || this.#socket === undefined)
      return err({ kind: "link", origin: ORIGIN, message: "the relay link is not up" });
    const bytes = relayBinaryCodec.encode(frame);
    if (!bytes.ok)
      return err({ kind: "codec", origin: ORIGIN, message: `a binary frame: ${bytes.error}` });
    return this.#socket.sendBinary(bytes.value);
  }

  /** A `ping` now, unless one is awaited: the computer's addresses changed. */
  probe(): void {
    if (this.#phase === "up" && this.#awaitingPong === undefined) this.#sendPing();
  }

  /** The hub closes the link: a change of relay, or a stop. */
  close(reason: RelayDownReason): void {
    this.#closeOwn(NORMAL_CLOSE, reason);
  }

  // ----- The handshake -----

  async #hello(): Promise<void> {
    if (this.#phase !== "connecting") return;
    const started = startRelayInitiator("hub", this.#o.staticKey);
    const hello = encodeRelayHello({
      proto: [RELAY_PROTO.min, RELAY_PROTO.max],
      hub: this.#o.hubVersion,
    });
    if (!started.ok || !hello.ok) {
      this.#closeOwn(NORMAL_CLOSE, "handshake");
      return;
    }
    this.#handshake = started.value;
    this.#phase = "hello";
    const message1 = await started.value.writeMessage(hello.value);
    if (!this.#still("hello")) return;
    if (!message1.ok || this.#socket?.sendBinary(message1.value).isOk() !== true) {
      this.#closeOwn(NORMAL_CLOSE, "handshake");
    }
  }

  async #binary(bytes: Uint8Array): Promise<void> {
    if (this.#phase === "up") {
      const frame = relayBinaryCodec.decode(bytes);
      if (!frame.ok) {
        this.#closeOwn(RELAY_CLOSE.badFrame, "closed");
        return;
      }
      this.#o.owner.binary(this, frame.value);
      return;
    }
    const handshake = this.#handshake;
    if (this.#phase !== "hello" || handshake === undefined) {
      this.#closeOwn(RELAY_CLOSE.badFrame, "handshake");
      return;
    }
    // Message 2; one message only, so the phase moves before anything is awaited.
    this.#phase = "joining";
    const read = await handshake.readMessage(bytes);
    if (!this.#still("joining")) return;
    const welcome = read.ok ? decodeRelayWelcome(read.value) : undefined;
    if (
      welcome?.ok !== true ||
      welcome.value.proto < RELAY_PROTO.min ||
      welcome.value.proto > RELAY_PROTO.max
    ) {
      this.#closeOwn(RELAY_CLOSE.badFrame, "handshake");
      return;
    }
    this.#welcome = welcome.value;
    const join = encodeRelayJoin({});
    const message3 = join.ok ? await handshake.writeMessage(join.value) : undefined;
    if (!this.#still("joining")) return;
    if (message3?.ok !== true || this.#socket?.sendBinary(message3.value).isOk() !== true) {
      this.#closeOwn(NORMAL_CLOSE, "handshake");
    }
  }

  #text(text: string): void {
    if (this.#phase === "ended") return;
    const frame = decodeTextFrame("relayToHub", text);
    if (!frame.ok) {
      this.#closeOwn(RELAY_CLOSE.badFrame, this.#phase === "up" ? "closed" : "handshake");
      return;
    }
    const value = frame.value;
    if (this.#phase !== "up") {
      // Before `joined`, only `joined` itself, after message 3; a `limit` may precede a refusal.
      if (value.t === "limit") {
        this.#limitRetryAfterMs = value.retryAfterMs;
        return;
      }
      const welcome = this.#welcome;
      if (value.t !== "joined" || welcome === undefined || this.#phase !== "joining") {
        this.#closeOwn(RELAY_CLOSE.badFrame, "handshake");
        return;
      }
      this.#phase = "up";
      this.#upAt = this.#o.now();
      this.#armPing();
      this.#o.owner.joined(this, welcome);
      return;
    }
    switch (value.t) {
      case "pong":
        if (value.n === this.#awaitingPong) {
          this.#awaitingPong = undefined;
          this.#armPing();
        }
        return;
      case "limit":
        this.#limitRetryAfterMs = value.retryAfterMs;
        this.#o.owner.text(this, value);
        return;
      case "joined":
        return;
      default:
        this.#o.owner.text(this, value);
    }
  }

  /** Whether the attempt is still at `phase`, after an `await` during which it may have ended. */
  #still(phase: Phase): boolean {
    return this.#phase === phase;
  }

  // ----- Keepalive -----

  #armPing(): void {
    this.#arm(RELAY_LIMITS.hubPingEveryMs, () => {
      this.#sendPing();
    });
  }

  #sendPing(): void {
    this.#ping = (this.#ping + 1) % 0x1_0000_0000;
    const n = this.#ping;
    // Awaited before it goes: a `pong` may come back before `send` returns.
    this.#awaitingPong = n;
    this.#arm(RELAY_LIMITS.pongWithinMs, () => {
      this.#closeOwn(NORMAL_CLOSE, "noPong");
    });
    if (this.sendText({ t: "ping", n }).isErr()) this.#closeOwn(NORMAL_CLOSE, "connect");
  }

  // ----- The end -----

  #arm(ms: number, run: () => void): void {
    this.#timer?.();
    this.#timer = this.#o.timers.after(ms, run);
  }

  /** The hub closes the link with `code`; it ends now, whatever the socket does after. */
  #closeOwn(code: number, reason: RelayDownReason): void {
    if (this.#phase === "ended") return;
    this.#ownClose = { code, reason };
    this.#socket?.close(code);
    this.#ended(code);
  }

  #ended(code: number): void {
    if (this.#phase === "ended") return;
    const wasUp = this.#phase === "up";
    this.#phase = "ended";
    this.#timer?.();
    this.#timer = undefined;
    const own = this.#ownClose;
    this.#o.owner.ended(this, {
      code: own?.code ?? code,
      reason: own?.reason ?? reasonOfClose(code, this.#opened),
      byHub: own !== undefined,
      wasUp,
      upMs: wasUp ? Math.max(0, this.#o.now() - this.#upAt) : 0,
      limitRetryAfterMs: this.#limitRetryAfterMs,
    });
  }
}

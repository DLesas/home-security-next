/**
 * One hub link, `/v1/hub` (docs/m4-design.md section 3, "How a hub is known: by its key"; D125):
 * the hub proves its app static key in `Noise_XN_25519_ChaChaPoly_SHA256` with the prologue
 * `hsn-relay/1`, then the link carries JSON text frames for control and binary frames for data, in
 * the clear inside TLS. The handshake, its payloads, the shared version and the proved identity
 * are `@hsn/protocol/relay`'s (B1's `startRelayResponder("hub")`, `provedIdentity`); the relay
 * never splits the handshake.
 *
 * | Message | Direction | Payload |
 * | --- | --- | --- |
 * | 1 | hub → relay, `e` | `RelayHello {proto, hub}` |
 * | 2 | relay → hub, `e, ee` | `RelayWelcome {proto, relay, roles, limits}`, or close 4426 |
 * | 3 | hub → relay, `s, se` | `RelayJoin {}`; the relay answers `joined {identity}` |
 *
 * Closes: 4400 for any frame it cannot read (a text message during the handshake, a payload or
 * frame no schema accepts, a binary kind other than 1, an unknown kind); 4408 the handshake not
 * finished within `PROTECTION_LIMITS.unauthenticated.message3WithinMs`, and a joined link silent
 * for 75 s (the presence core's `closeLink`); 4426 no shared version; 4429 over a limit, a second
 * message queued during a handshake step, and a reader too slow to take its data; 4403 a key the
 * operator refuses; 4001 replaced by a newer link of the same identity; 1001 the relay stopping.
 *
 * The link itself only reads and writes; what a frame means is the relay's (`relay.ts`).
 */
import type { Handshake } from "@hsn/protocol/app";
import {
  decodeRelayHello,
  decodeRelayJoin,
  decodeTextFrame,
  encodeRelayWelcome,
  encodeTextFrame,
  type HubToRelayFrame,
  provedIdentity,
  RELAY_BINARY_KIND,
  RELAY_CLOSE,
  relayBinaryCodec,
  type RelayToHubFrame,
  type RelayWelcome,
  sharedRelayProto,
  startRelayResponder,
} from "@hsn/protocol/relay";
import { PROTECTION_LIMITS } from "../core/rules.ts";
import type { RelayClock } from "./clock.ts";
import type { RelayLog } from "./log.ts";
import type { RelaySocket } from "./safe/websocket.ts";

/** What a hub link asks of the relay. */
export interface HubLinkHost {
  readonly clock: RelayClock;
  readonly log: RelayLog;
  /** Message 2's payload, without the version, which the link chooses. */
  welcome(): Omit<RelayWelcome, "proto">;
  /**
   * Message 3 proved `identity`: join the link, or the close code to refuse it with (after
   * whatever the relay sent first, such as `limit`).
   */
  join(link: HubLink, identity: string): "ok" | { readonly close: number };
  /** Any frame on the joined link, before its meaning. */
  heard(link: HubLink): void;
  text(link: HubLink, frame: HubToRelayFrame): void;
  /** A kind 1 frame: one Noise message for a phone's stream. */
  streamData(link: HubLink, stream: number, message: Uint8Array): void;
  /** The link closed, joined or not; called once. */
  gone(link: HubLink): void;
}

type LinkState = "hello" | "join" | "joined" | "closed";

export class HubLink {
  private state: LinkState = "hello";
  private handshake: Handshake | undefined;
  private busy = false;
  private queued: (string | Uint8Array)[] = [];
  private proved: string | undefined;
  private cancelTimer: () => void;
  /** When the last frame arrived on the joined link. */
  lastFrameMs = 0;
  /** Whether the link ever joined. */
  everJoined = false;

  constructor(
    private readonly socket: RelaySocket,
    private readonly host: HubLinkHost,
    /** The address key the link came from. */
    readonly address: string,
  ) {
    this.cancelTimer = host.clock.after(PROTECTION_LIMITS.unauthenticated.message3WithinMs, () => {
      if (this.state === "hello" || this.state === "join") {
        this.host.log.write("warning", "handshakeFailed", { why: "timeout" });
        this.close(RELAY_CLOSE.handshakeTimeout);
      }
    });
  }

  /** The identity proved by message 3, once joined. */
  get identity(): string | undefined {
    return this.proved;
  }

  get joined(): boolean {
    return this.state === "joined";
  }

  /** Read through a method: the state changes across an `await`, which narrowing does not see. */
  private isClosed(): boolean {
    return this.state === "closed";
  }

  /** A WebSocket message from the hub. */
  receive(message: string | Uint8Array): void {
    if (this.state === "closed") return;
    if (this.state === "joined") {
      this.frame(message);
      return;
    }
    // A handshake step: one message in hand, and at most `queuedMessages` queued (D142).
    if (this.busy) {
      if (this.queued.length >= PROTECTION_LIMITS.unauthenticated.queuedMessages) {
        this.host.log.write("warning", "handshakeFailed", { why: "queue" });
        this.close(RELAY_CLOSE.overLimit);
        return;
      }
      this.queued.push(message);
      return;
    }
    this.busy = true;
    void this.step(message).then(() => {
      this.busy = false;
      const next = this.queued.shift();
      if (next !== undefined) this.receive(next);
    });
  }

  private async step(message: string | Uint8Array): Promise<void> {
    if (typeof message === "string") {
      this.refuseHandshake("badFrame", RELAY_CLOSE.badFrame);
      return;
    }
    if (this.state === "hello") await this.hello(message);
    else if (this.state === "join") await this.join(message);
  }

  private refuseHandshake(why: "badFrame" | "noSharedVersion", code: number): void {
    this.host.log.write("warning", "handshakeFailed", { why });
    this.close(code);
  }

  private async hello(message: Uint8Array): Promise<void> {
    const started = startRelayResponder("hub");
    if (!started.ok) {
      this.refuseHandshake("badFrame", RELAY_CLOSE.badFrame);
      return;
    }
    const handshake = started.value;
    this.handshake = handshake;
    const read = await handshake.readMessage(message);
    if (this.isClosed()) return;
    const hello = read.ok ? decodeRelayHello(read.value) : undefined;
    if (hello?.ok !== true) {
      this.refuseHandshake("badFrame", RELAY_CLOSE.badFrame);
      return;
    }
    const proto = sharedRelayProto(hello.value.proto);
    if (proto === undefined) {
      this.refuseHandshake("noSharedVersion", RELAY_CLOSE.noSharedVersion);
      return;
    }
    const welcome = encodeRelayWelcome({ proto, ...this.host.welcome() });
    if (!welcome.ok) {
      this.refuseHandshake("badFrame", RELAY_CLOSE.badFrame);
      return;
    }
    const written = await handshake.writeMessage(welcome.value);
    if (this.isClosed()) return;
    if (!written.ok) {
      this.refuseHandshake("badFrame", RELAY_CLOSE.badFrame);
      return;
    }
    this.state = "join";
    if (!this.socket.sendBinary(written.value)) this.slow();
  }

  private async join(message: Uint8Array): Promise<void> {
    const handshake = this.handshake;
    if (handshake === undefined) return;
    const read = await handshake.readMessage(message);
    if (this.isClosed()) return;
    const identity = read.ok ? provedIdentity(handshake) : undefined;
    if (!read.ok || identity === undefined || !decodeRelayJoin(read.value).ok) {
      this.refuseHandshake("badFrame", RELAY_CLOSE.badFrame);
      return;
    }
    this.handshake = undefined;
    this.proved = identity;
    const answer = this.host.join(this, identity);
    if (answer !== "ok") {
      this.close(answer.close);
      return;
    }
    this.state = "joined";
    this.everJoined = true;
    this.cancelTimer();
    this.lastFrameMs = this.host.clock.now();
    this.send({ t: "joined", identity });
  }

  private frame(message: string | Uint8Array): void {
    if (typeof message === "string") {
      const decoded = decodeTextFrame("hubToRelay", message);
      if (!decoded.ok) {
        this.badFrame();
        return;
      }
      this.lastFrameMs = this.host.clock.now();
      this.host.heard(this);
      if (this.state === "joined") this.host.text(this, decoded.value);
      return;
    }
    const decoded = relayBinaryCodec.decode(message);
    // A hub sends only stream data; release pieces travel the other way.
    if (!decoded.ok || decoded.value.kind !== RELAY_BINARY_KIND.streamData) {
      this.badFrame();
      return;
    }
    this.lastFrameMs = this.host.clock.now();
    this.host.heard(this);
    if (this.state === "joined") {
      this.host.streamData(this, decoded.value.stream, decoded.value.message);
    }
  }

  private badFrame(): void {
    this.host.log.write("warning", "hubClosed", { code: RELAY_CLOSE.badFrame });
    this.close(RELAY_CLOSE.badFrame);
  }

  /** Sends a text frame; a frame the hub would refuse is never sent. False when not sent. */
  send(frame: RelayToHubFrame): boolean {
    if (this.state === "closed") return false;
    const text = encodeTextFrame("relayToHub", frame);
    if (!text.ok) return false;
    if (this.socket.sendText(text.value)) return true;
    this.slow();
    return false;
  }

  /** Sends a binary frame (kind 1 or 2). False when not sent. */
  sendBinary(bytes: Uint8Array): boolean {
    if (this.state === "closed") return false;
    if (this.socket.sendBinary(bytes)) return true;
    this.slow();
    return false;
  }

  /** Unsent bytes held for this hub now. */
  get pending(): number {
    return this.socket.pending;
  }

  /** The hub does not take its data: closed, so it cannot hold the relay's memory (D142). */
  private slow(): void {
    if (this.state === "closed") return;
    this.host.log.write("warning", "slowReader", { link: "hub" });
    this.close(RELAY_CLOSE.overLimit);
  }

  /** Closes the link with `code`; the host hears `gone` once. */
  close(code: number): void {
    if (this.state === "closed") return;
    this.socket.close(code);
    this.socketClosed();
  }

  /** The socket closed, by either side. */
  socketClosed(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.cancelTimer();
    this.handshake = undefined;
    this.queued = [];
    this.host.gone(this);
  }
}

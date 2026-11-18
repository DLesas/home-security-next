/**
 * One phone's stream through the relay (docs/m4-design.md section 3, "Phones"): opened at
 * `/v1/phone/<identity>/<session | link | restore>`, carried to the hub's link as `open {stream,
 * path, peer}` and kind 1 frames, one Noise message for one WebSocket message, both ways,
 * unchanged. The relay neither reads nor waits for the handshake.
 *
 * Closes to the phone: 1003 a text message or an empty one, 1009 one over 65,535 bytes
 * (`checkPhoneMessage`, `phoneCloseFor`); 4410 the hub's link closed, or nothing either way for
 * `streamIdleMs`; 4429 a reader too slow to take its data; the hub's own code when the hub closes
 * the stream. The hub hears `close {stream, code}` with the phone's own close code, or the
 * relay's when the relay ends it.
 */
import {
  checkPhoneMessage,
  PHONE_CLOSE,
  type PhonePathName,
  phoneCloseFor,
  RELAY_BINARY_KIND,
  relayBinaryCodec,
} from "@hsn/protocol/relay";
import { PROTECTION_LIMITS } from "../core/rules.ts";
import type { RelayClock } from "./clock.ts";
import type { RelayLog } from "./log.ts";
import type { RelaySocket } from "./safe/websocket.ts";

/** What a phone stream asks of the relay: its hub link's side, and the accounting. */
export interface StreamHost {
  readonly clock: RelayClock;
  readonly log: RelayLog;
  /** Sends a kind 1 frame to the hub; false when the hub link could not take it. */
  toHub(stream: PhoneStream, frame: Uint8Array): boolean;
  /** Tells the hub the stream closed with `code`. */
  closedToHub(stream: PhoneStream, code: number): void;
  /** Bytes carried, either way. */
  carried(stream: PhoneStream, bytes: number): void;
  /** The stream ended; called once. */
  streamGone(stream: PhoneStream): void;
}

export class PhoneStream {
  private open = true;
  private lastMs: number;
  private cancelIdle: () => void = () => undefined;

  constructor(
    private readonly socket: RelaySocket,
    private readonly host: StreamHost,
    /** The stream's number on its hub link. */
    readonly stream: number,
    /** The hub's identity. */
    readonly hub: string,
    readonly path: PhonePathName,
    /** The address key the phone came from. */
    readonly address: string,
  ) {
    this.lastMs = host.clock.now();
    this.armIdle(PROTECTION_LIMITS.slowClients.idlePhoneStreamMs);
  }

  get isOpen(): boolean {
    return this.open;
  }

  private armIdle(waitMs: number): void {
    this.cancelIdle = this.host.clock.after(waitMs, () => {
      if (!this.open) return;
      const idle = this.host.clock.now() - this.lastMs;
      const left = PROTECTION_LIMITS.slowClients.idlePhoneStreamMs - idle;
      if (left > 0) {
        this.armIdle(left);
        return;
      }
      this.end(PHONE_CLOSE.hubGone, PHONE_CLOSE.hubGone);
    });
  }

  /** A WebSocket message from the phone: carried to the hub as one kind 1 frame. */
  receive(message: string | Uint8Array): void {
    if (!this.open) return;
    const checked = checkPhoneMessage(message);
    if (!checked.ok) {
      const code = phoneCloseFor(checked.error);
      this.end(code, code);
      return;
    }
    const frame = relayBinaryCodec.encode({
      kind: RELAY_BINARY_KIND.streamData,
      stream: this.stream,
      message: checked.value,
    });
    if (!frame.ok) {
      this.end(PHONE_CLOSE.tooLarge, PHONE_CLOSE.tooLarge);
      return;
    }
    this.lastMs = this.host.clock.now();
    this.host.carried(this, checked.value.length);
    // A hub too slow to take it is closed by its link, which ends this stream with 4410.
    this.host.toHub(this, frame.value);
  }

  /** A Noise message from the hub for this phone. */
  fromHub(message: Uint8Array): void {
    if (!this.open) return;
    this.lastMs = this.host.clock.now();
    this.host.carried(this, message.length);
    if (!this.socket.sendBinary(message)) {
      this.host.log.write("warning", "slowReader", { link: "phone" });
      this.end(PHONE_CLOSE.overLimit, PHONE_CLOSE.overLimit);
    }
  }

  /** The hub closed the stream with `code`: passed to the phone unchanged. */
  closedByHub(code: number): void {
    if (!this.open) return;
    this.finish();
    this.socket.close(code);
  }

  /** The hub's link went: the phone hears 4410. */
  hubGone(): void {
    if (!this.open) return;
    this.finish();
    this.socket.close(PHONE_CLOSE.hubGone);
  }

  /** The relay is stopping: the phone hears 1001. */
  stopping(): void {
    if (!this.open) return;
    this.finish();
    this.socket.close(PHONE_CLOSE.stopping);
  }

  /** The phone's socket closed with `code`: the hub hears it. */
  socketClosed(code: number): void {
    if (!this.open) return;
    this.host.closedToHub(this, code);
    this.finish();
  }

  /** The relay ends the stream: `toPhone` to the phone, `toHub` to the hub. */
  private end(toPhone: number, toHub: number): void {
    if (!this.open) return;
    this.host.closedToHub(this, toHub);
    this.finish();
    this.socket.close(toPhone);
  }

  private finish(): void {
    this.open = false;
    this.cancelIdle();
    this.host.streamGone(this);
  }
}

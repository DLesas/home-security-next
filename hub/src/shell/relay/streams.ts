/**
 * Phones' streams through the relay, as connections of the hub's app channel (docs/m4-design.md
 * section 4, "Relayed streams in the app channel"): each `open {stream, path, peer}` is
 * `admit(peer, path)` then `open(ticket, socket, "relay")`, under the same handshake and session
 * limits as the home network's listener (16 open handshakes, 10 a second from one address and 100
 * in all, 5 s to prove, 4 sessions a client and 64 in all), the relay's pseudonym of the phone's
 * address (`relay-` and 16 hex digits) standing where the home listener has an address. A refused
 * `admit` answers `close {stream, 1013}`: try later.
 *
 * - The connection's socket writes a kind 1 frame for each message, and its `close(code)` sends
 *   `close {stream, code}`: the channel's own codes pass through as they are (1000, 1008, 4000 to
 *   4004); a code the relay does not carry for a hub (1001 at a stop, 1003) goes as 1008.
 * - Each kind 1 frame is one Noise message for `receive`; the relay's `close` is `closed`.
 * - Stream numbers start at 0 on each link and only grow (B2's relay); an `open` for a number
 *   already seen on this link is refused with 1008, and data for a stream the hub does not hold is
 *   dropped (it closed it, and the relay's `close` is on its way).
 * - When the link drops, every relayed connection is closed (`clientClosed {reason: "remote"}`).
 *
 * `Host` and `Origin`, which belong to HTTP, do not apply: no HTTP reaches the hub from the relay.
 */
import { HUB_STREAM_CLOSE_CODES, PHONE_CLOSE, RELAY_BINARY_KIND } from "@hsn/protocol/relay";
import type { ConnId } from "../../core/model/ids.ts";
import type { AppChannel, ChannelSocket } from "../app/channel.ts";
import type { RelayLink } from "./link.ts";

/** What the streams need of the app channel. */
export type StreamChannel = Pick<AppChannel, "admit" | "cancel" | "open" | "receive" | "closed">;

/** The code a hub's close of a stream carries: its own if the relay passes it on, else 1008. */
export function streamCloseCode(code: number): number {
  return HUB_STREAM_CLOSE_CODES.includes(code) ? code : 1008;
}

interface Stream {
  readonly stream: number;
  conn: ConnId | undefined;
  live: boolean;
}

export class RelayedStreams {
  readonly #channel: StreamChannel;
  readonly #link: RelayLink;
  readonly #streams = new Map<number, Stream>();
  /** The highest stream number this link has opened; numbers never come again. */
  #highest = -1;

  constructor(channel: StreamChannel, link: RelayLink) {
    this.#channel = channel;
    this.#link = link;
  }

  /** Streams open now. */
  get open(): number {
    return this.#streams.size;
  }

  /** The relay's `open {stream, path, peer}`. */
  opened(frame: {
    readonly stream: number;
    readonly path: "session" | "link" | "restore";
    readonly peer: string;
  }): void {
    if (frame.stream <= this.#highest) {
      this.#sendClose(frame.stream, 1008);
      return;
    }
    this.#highest = frame.stream;
    const ticket = this.#channel.admit(frame.peer, frame.path);
    if (ticket.refused) {
      this.#sendClose(frame.stream, PHONE_CLOSE.tryLater);
      return;
    }
    const entry: Stream = { stream: frame.stream, conn: undefined, live: true };
    this.#streams.set(frame.stream, entry);
    entry.conn = this.#channel.open(ticket, this.#socketOf(entry), "relay");
  }

  /** A kind 1 frame: one Noise message of the phone's connection. */
  data(stream: number, message: Uint8Array): void {
    const entry = this.#streams.get(stream);
    if (entry?.conn !== undefined) this.#channel.receive(entry.conn, message);
  }

  /** The relay's `close {stream, code}`: the phone went, or the relay ended the stream. */
  closedByRelay(stream: number): void {
    const entry = this.#streams.get(stream);
    if (entry === undefined) return;
    this.#forget(entry);
    if (entry.conn !== undefined) this.#channel.closed(entry.conn);
  }

  /** The link dropped: every relayed connection is closed. */
  linkLost(): void {
    for (const entry of [...this.#streams.values()]) {
      this.#forget(entry);
      if (entry.conn !== undefined) this.#channel.closed(entry.conn);
    }
  }

  #forget(entry: Stream): void {
    entry.live = false;
    this.#streams.delete(entry.stream);
  }

  #socketOf(entry: Stream): ChannelSocket {
    return {
      send: (bytes) => {
        if (!entry.live) return { ok: false };
        const sent = this.#link.sendBinary({
          kind: RELAY_BINARY_KIND.streamData,
          stream: entry.stream,
          message: bytes,
        });
        return { ok: sent.isOk() };
      },
      close: (code) => {
        if (!entry.live) return;
        this.#forget(entry);
        this.#sendClose(entry.stream, streamCloseCode(code));
      },
    };
  }

  #sendClose(stream: number, code: number): void {
    // A link that is not up has closed every stream already: nothing to tell.
    this.#link.sendText({ t: "close", stream, code }).match(
      () => undefined,
      () => undefined,
    );
  }
}

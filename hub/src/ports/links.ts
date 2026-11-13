/** Serial ports and WebSockets (hub-design.md section 3, "Serial links" and "WebSocket links"). */
import type { Result } from "neverthrow";
import type { HubError } from "../core/model/errors.ts";
import type { HubEvent, LinkErrorCode } from "../core/model/events.ts";
import type { LinkId, SendRef } from "../core/model/ids.ts";

/** Where a port delivers the events it makes; the shell stamps each with time and entropy. */
export type EventSink = (event: HubEvent) => void;

export type LinkError = HubError & { readonly kind: "link"; readonly code: LinkErrorCode };

/**
 * Emits `linkOpened`, `linkClosed`, `frame` and `inputRejected` (a frame that failed COBS
 * decoding, section 10) events. Frames from one link reach the core in arrival order; sends to
 * one link leave in effect order. `send` queues and returns at once: a failure it can see then (a
 * closed link, a full queue past 64 frames, back-pressure, a dropped message) is its `Err`, for
 * the loop to give the core as `sendFailed` with `ref`; a write that fails later is emitted as
 * `sendFailed` with the same `ref`, and closes the link.
 */
export interface Links {
  listen(sink: EventSink): void;
  send(link: LinkId, bytes: Uint8Array, ref: SendRef): Result<void, LinkError>;
  /** Closes a link; its `linkClosed` event follows. */
  close(link: LinkId, reason: string): Result<void, LinkError>;
}

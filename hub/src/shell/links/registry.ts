/**
 * The `Links` port (hub-design.md section 3) over every kind of link: the serial ports, the
 * WebSocket endpoint and the bench's lockstep link each register their links here, which hands
 * out `LinkId`s, delivers their events to the loop's sink in arrival order, and routes the
 * core's `send` and `close` to the right adapter.
 *
 * A failure `send` can see at once is its `Err`, for the loop to give the core as `sendFailed`;
 * one an adapter learns of later is emitted here as `sendFailed` with the send's reference. A USB
 * frame that fails COBS decoding is emitted as `inputRejected`, so the core counts it (section
 * 10).
 */
import { err, ok, type Result } from "neverthrow";
import type { LinkCloseReason, LinkKind } from "../../core/model/events.ts";
import { type LinkId, linkId, type SendRef } from "../../core/model/ids.ts";
import type { EventSink, LinkError, Links } from "../../ports/links.ts";
import { linkError } from "../safe/link-error.ts";

/** What an adapter does for one of its links. */
export interface LinkHandle {
  send(bytes: Uint8Array, ref: SendRef): Result<void, LinkError>;
  close(reason: string): Result<void, LinkError>;
}

/** A frame an adapter could not pass on (section 10): not COBS, or too long. */
export type FrameRejection = "badFrame" | "tooLong";

/** Where the links adapters' errors say they arose (section 10). */
export const ORIGIN = "shell/links";

/** The `Links` port: every adapter's links behind one interface (section 3). */
export class LinkRegistry implements Links {
  readonly #handles = new Map<LinkId, LinkHandle>();
  #sink: EventSink | undefined;
  #next = 1;

  listen(sink: EventSink): void {
    this.#sink = sink;
  }

  /** A new link: its id, and `linkOpened` to the core. */
  open(kind: LinkKind, label: string, handle: LinkHandle): LinkId {
    const id = linkId(this.#next++);
    this.#handles.set(id, handle);
    this.#sink?.({ kind: "linkOpened", link: id, linkKind: kind, label });
    return id;
  }

  /** One packet or setup message from a link. */
  frame(link: LinkId, bytes: Uint8Array): void {
    if (this.#handles.has(link)) this.#sink?.({ kind: "frame", link, bytes });
  }

  /** A frame the adapter could not decode: counted by the core as a rejection (section 10). */
  reject(link: LinkId, reason: FrameRejection): void {
    if (!this.#handles.has(link)) return;
    this.#sink?.({ kind: "inputRejected", rejection: { source: "frame", link, reason } });
  }

  /** A send that failed after `send` returned: `sendFailed` to the core with its reference. */
  failed(link: LinkId, ref: SendRef, error: LinkError): void {
    this.#sink?.({ kind: "sendFailed", link, ref, error: error.code });
  }

  /** The link is gone: `linkClosed` to the core, once. */
  closed(link: LinkId, reason: LinkCloseReason): void {
    if (!this.#handles.delete(link)) return;
    this.#sink?.({ kind: "linkClosed", link, reason });
  }

  isOpen(link: LinkId): boolean {
    return this.#handles.has(link);
  }

  send(link: LinkId, bytes: Uint8Array, ref: SendRef): Result<void, LinkError> {
    const handle = this.#handles.get(link);
    if (handle === undefined)
      return err(linkError("closed", ORIGIN, `send on link ${link}, which is closed`));
    return handle.send(bytes, ref);
  }

  close(link: LinkId, reason: string): Result<void, LinkError> {
    const handle = this.#handles.get(link);
    if (handle === undefined) return ok(undefined);
    const closed = handle.close(reason);
    this.closed(link, "closedByHub");
    return closed;
  }
}

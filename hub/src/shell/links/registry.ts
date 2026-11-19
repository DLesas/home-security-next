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
import { type LinkId, linkId, type SendRef, sendRef } from "../../core/model/ids.ts";
import type { EventSink, LinkError, Links } from "../../ports/links.ts";
import { linkError } from "../safe/link-error.ts";

/** What an adapter does for one of its links. */
export interface LinkHandle {
  send(bytes: Uint8Array, ref: SendRef): Result<void, LinkError>;
  close(reason: string): Result<void, LinkError>;
}

/** A frame an adapter could not pass on (section 10): not COBS, too long, or after a close. */
export type FrameRejection = "badFrame" | "tooLong" | "closedLink";

/** Where the links adapters' errors say they arose (section 10). */
export const ORIGIN = "shell/links";

/**
 * What answers firmware transfer frames (0xF2) on the links the core granted, before they reach
 * the core (m3-updates-design.md section 5; `shell/firmware/serve.ts`): `take` is true for a frame
 * it answered, which the core then never sees; `forget` drops a link's record when it closes.
 */
export interface FrameTaker {
  take(link: LinkId, bytes: Uint8Array): boolean;
  forget(link: LinkId): void;
}

/**
 * The reference a transfer frame's answer is sent with: no module's (`sendRefModule` names none),
 * so its failure is never the core's `sendFailed`; a write that fails closes the link anyway.
 */
export const TRANSFER_SEND_REF: SendRef = sendRef(0);

/** The `Links` port: every adapter's links behind one interface (section 3). */
export class LinkRegistry implements Links {
  readonly #handles = new Map<LinkId, LinkHandle>();
  #sink: EventSink | undefined;
  #next = 1;
  #transfers: FrameTaker | undefined;

  listen(sink: EventSink): void {
    this.#sink = sink;
  }

  /** Transfer frames on granted links go to `taker` first (m3-updates-design.md section 5). */
  serveTransfers(taker: FrameTaker): void {
    this.#transfers = taker;
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
    if (!this.#handles.has(link)) return;
    if (this.#transfers?.take(link, bytes) === true) return;
    this.#sink?.({ kind: "frame", link, bytes });
  }

  /** A frame the adapter could not decode: counted by the core as a rejection (section 10). */
  reject(link: LinkId, reason: FrameRejection): void {
    if (!this.#handles.has(link)) return;
    this.#sink?.({ kind: "inputRejected", rejection: { source: "frame", link, reason } });
  }

  /**
   * A frame on a link the hub closed, which only lockstep's controller can still send on
   * (section 11): counted by the core as a rejection, so nothing arriving is lost unrecorded.
   */
  frameAfterClose(link: LinkId): void {
    this.#sink?.({
      kind: "inputRejected",
      rejection: { source: "frame", link, reason: "closedLink" },
    });
  }

  /** A send that failed after `send` returned: `sendFailed` to the core with its reference. */
  failed(link: LinkId, ref: SendRef, error: LinkError): void {
    if (ref === TRANSFER_SEND_REF) return;
    this.#sink?.({ kind: "sendFailed", link, ref, error: error.code });
  }

  /** The link is gone: `linkClosed` to the core, once. */
  closed(link: LinkId, reason: LinkCloseReason): void {
    if (!this.#handles.delete(link)) return;
    this.#transfers?.forget(link);
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

  /** A transfer frame's answer on `link` (`FrameTaker`): sent, or false when it could not be. */
  sendTransfer(link: LinkId, bytes: Uint8Array): boolean {
    return this.#handles.get(link)?.send(bytes, TRANSFER_SEND_REF).isOk() === true;
  }

  close(link: LinkId, reason: string): Result<void, LinkError> {
    const handle = this.#handles.get(link);
    if (handle === undefined) return ok(undefined);
    const closed = handle.close(reason);
    this.closed(link, "closedByHub");
    return closed;
  }
}

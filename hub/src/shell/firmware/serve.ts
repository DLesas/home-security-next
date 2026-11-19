/**
 * Serving firmware to devices on their own links (docs/m3-updates-design.md sections 4 and 5,
 * D137): the `Transfers` port. The core decides every offer and grant; the shell answers a
 * device's `Get` frames (0xF2 0x01) from the store's file, on WebSocket and USB alike, and the
 * bytes never enter the core. The shell reads only a frame's first two bytes and the transfer
 * format's fields, never a packet (R3).
 *
 * For each link it holds what the core last said:
 *
 * - **Granted** (`transferGrant`): a Get for the granted image, inside the file (the 128-byte
 *   header, then the payload), is answered with one Data frame of exactly the bytes asked and
 *   their CRC-32. A Get outside the file is answered Gone `outOfRange`, a Get naming another image
 *   Gone `notGranted`, and a frame that is not a Get (or not a frame) Gone `notAvailable`; each of
 *   these is also reported to the core as `inputRejected` (`badFrame`), which counts it. A file
 *   that cannot be read is answered Gone `notAvailable`.
 * - **Revoked** (`transferRevoke`): every later Get is answered Gone `paused` (a countdown or an
 *   alarm runs; the device resumes from its checkpoint when it ends) or `notGranted`.
 * - **Nothing**: a transfer frame on a link the core never granted is not the shell's: it goes to
 *   the core as any frame does, where `links` rejects and counts it (`transferNotGranted`).
 *
 * A link's record goes when the link closes. Progress goes to the core as `transferProgress`, the
 * file's bytes served so far from its start (the highest end of a Data sent), each time that
 * passes a 64 KB ‡ step and when the file's last byte is served.
 *
 * **One thread.** Each frame is answered at once, in the link's own callback, with one read of at
 * most 1,000 bytes (a Get's largest) from a file held open while the grant lasts: no frame holds
 * the hub's loop for longer than that read, whatever the number of devices.
 */
import { join } from "node:path";
import {
  decodeTransferFrame,
  encodeTransferFrame,
  GoneReason,
  IMAGE_HEADER,
  TRANSFER_PREFIX,
  TransferKind,
} from "@hsn/protocol/update";
import type { TransferRevokeReason } from "../../core/model/effects.ts";
import type { HubEvent } from "../../core/model/events.ts";
import type { LinkId } from "../../core/model/ids.ts";
import type { TransferGrant, Transfers } from "../../ports/transfers.ts";
import { closeQuietly, openToRead, readAt } from "../safe/firmware-io.ts";
import { IMAGE_FILE, storeFolder } from "./store.ts";

/** Where the header holds the image's length (m3-updates-design section 3). */
const IMAGE_BYTES_OFFSET = 12;

/** `transferProgress` is sent each time the bytes served pass a multiple of this ‡. */
export const PROGRESS_STEP_BYTES = 64 * 1024;

/** What the server needs of the hub. */
export interface TransferServerOptions {
  readonly dataDir: string;
  /** Sends a frame on a link (`LinkRegistry.sendTransfer`); false when it could not. */
  readonly send: (link: LinkId, bytes: Uint8Array) => boolean;
  /** An input for the core: `transferProgress`, or `inputRejected` for a refused frame. */
  readonly emit: (event: HubEvent) => void;
  /** Milliseconds on a monotonic clock, to time each frame's answer; none when not given. */
  readonly stopwatch?: () => number;
}

interface Granted {
  readonly kind: "granted";
  readonly imageId: Uint8Array;
  readonly header: Uint8Array;
  /** The payload's file, open while the grant lasts; undefined when it could not be opened. */
  readonly fd: number | undefined;
  /** The header and the payload: the bytes a device pulls. */
  readonly fileBytes: number;
  /** The highest end of a Data sent so far, and the last such end reported to the core. */
  served: number;
  reported: number;
}

interface Revoked {
  readonly kind: "revoked";
  readonly reason: TransferRevokeReason;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The `Transfers` port, and the frames it answers (`take`). */
export class TransferServer implements Transfers {
  readonly #options: TransferServerOptions;
  readonly #links = new Map<LinkId, Granted | Revoked>();
  #longestMs = 0;
  #answered = 0;

  constructor(options: TransferServerOptions) {
    this.#options = options;
  }

  grant(link: LinkId, grant: TransferGrant): void {
    this.#release(link);
    const path = IMAGE_FILE.test(grant.file)
      ? join(storeFolder(this.#options.dataDir), grant.file)
      : undefined;
    const opened = path === undefined ? undefined : openToRead(path);
    const fd = opened?.isOk() === true ? opened.value : undefined;
    // The file's length is the signed header's (its image bytes), never the file's own: a file
    // that is short or missing then answers `notAvailable`, not `outOfRange`.
    const payloadBytes =
      grant.header.length >= IMAGE_HEADER.bytes
        ? new DataView(grant.header.buffer, grant.header.byteOffset, grant.header.length).getUint32(
            IMAGE_BYTES_OFFSET,
            true,
          )
        : 0;
    this.#links.set(link, {
      kind: "granted",
      imageId: grant.imageId.slice(),
      header: grant.header.slice(),
      fd,
      fileBytes: IMAGE_HEADER.bytes + payloadBytes,
      served: 0,
      reported: 0,
    });
  }

  revoke(link: LinkId, reason?: TransferRevokeReason): void {
    this.#release(link);
    this.#links.set(link, { kind: "revoked", reason: reason ?? "notGranted" });
  }

  /** The link closed: its record goes. */
  forget(link: LinkId): void {
    this.#release(link);
    this.#links.delete(link);
  }

  /** Every grant's file closed (the hub stops). */
  close(): void {
    for (const link of [...this.#links.keys()]) this.forget(link);
  }

  /** Whether the shell holds a record for `link` (a grant, or its revocation). */
  holds(link: LinkId): boolean {
    return this.#links.has(link);
  }

  /** The longest time one frame's answer took since the last read, in milliseconds. */
  takeLongestMs(): number {
    const longest = this.#longestMs;
    this.#longestMs = 0;
    return longest;
  }

  /** Frames answered since start. */
  get answered(): number {
    return this.#answered;
  }

  /**
   * A frame from `link`: true when it was a transfer frame on a link the shell holds a record for,
   * answered here; false for anything else, which goes to the core as a frame.
   */
  take(link: LinkId, bytes: Uint8Array): boolean {
    if (bytes[0] !== TRANSFER_PREFIX) return false;
    const held = this.#links.get(link);
    if (held === undefined) return false;
    const stopwatch = this.#options.stopwatch;
    const started = stopwatch?.() ?? 0;
    if (held.kind === "revoked") this.#whileRevoked(link, held, bytes);
    else this.#serve(link, held, bytes);
    this.#answered += 1;
    if (stopwatch !== undefined) this.#longestMs = Math.max(this.#longestMs, stopwatch() - started);
    return true;
  }

  #release(link: LinkId): void {
    const held = this.#links.get(link);
    if (held?.kind === "granted" && held.fd !== undefined) closeQuietly(held.fd);
  }

  #gone(link: LinkId, imageId: Uint8Array, reason: GoneReason): void {
    const frame = encodeTransferFrame({ kind: TransferKind.Gone, imageId, reason });
    if (frame.ok) this.#options.send(link, frame.value);
  }

  #refused(link: LinkId): void {
    this.#options.emit({
      kind: "inputRejected",
      rejection: { source: "frame", link, reason: "badFrame" },
    });
  }

  #whileRevoked(link: LinkId, held: Revoked, bytes: Uint8Array): void {
    const frame = decodeTransferFrame(bytes);
    if (!frame.ok || frame.value.kind !== TransferKind.Get) {
      this.#refused(link);
      return;
    }
    this.#gone(
      link,
      frame.value.imageId,
      held.reason === "paused" ? GoneReason.Paused : GoneReason.NotGranted,
    );
  }

  #serve(link: LinkId, held: Granted, bytes: Uint8Array): void {
    const frame = decodeTransferFrame(bytes);
    if (!frame.ok || frame.value.kind !== TransferKind.Get) {
      this.#gone(link, held.imageId, GoneReason.NotAvailable);
      this.#refused(link);
      return;
    }
    const get = frame.value;
    if (!same(get.imageId, held.imageId)) {
      this.#gone(link, get.imageId, GoneReason.NotGranted);
      this.#refused(link);
      return;
    }
    const end = get.offset + get.length;
    if (end > held.fileBytes) {
      this.#gone(link, get.imageId, GoneReason.OutOfRange);
      this.#refused(link);
      return;
    }
    const data = this.#bytes(held, get.offset, get.length);
    if (data === undefined) {
      this.#gone(link, get.imageId, GoneReason.NotAvailable);
      return;
    }
    const answer = encodeTransferFrame({
      kind: TransferKind.Data,
      imageId: held.imageId,
      offset: get.offset,
      data,
    });
    if (!answer.ok || !this.#options.send(link, answer.value)) return;
    this.#progress(link, held, end);
  }

  /** The file's bytes `offset` to `offset + length`: the header's, then the payload's. */
  #bytes(held: Granted, offset: number, length: number): Uint8Array | undefined {
    const out = new Uint8Array(length);
    const fromHeader = Math.max(0, Math.min(length, IMAGE_HEADER.bytes - offset));
    if (fromHeader > 0) out.set(held.header.subarray(offset, offset + fromHeader), 0);
    if (fromHeader === length) return out;
    if (held.fd === undefined) return undefined;
    const into = out.subarray(fromHeader);
    const read = readAt(held.fd, into, offset + fromHeader - IMAGE_HEADER.bytes, "an image");
    return read.isOk() && read.value === into.length ? out : undefined;
  }

  #progress(link: LinkId, held: Granted, end: number): void {
    if (end <= held.served) return;
    held.served = end;
    const step =
      Math.floor(end / PROGRESS_STEP_BYTES) > Math.floor(held.reported / PROGRESS_STEP_BYTES);
    const last = end === held.fileBytes;
    if (!step && !last) return;
    held.reported = end;
    this.#options.emit({
      kind: "transferProgress",
      link,
      image: held.imageId.slice(),
      bytes: end,
    });
  }
}

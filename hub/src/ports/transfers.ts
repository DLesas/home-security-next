/**
 * Firmware transfers on device links (docs/m3-updates-design.md sections 4 and 5, D137): the
 * shell answers a device's `Get` frames (0xF2) from the store's file, but only on a link the core
 * has granted. The core decides every offer and grant; the bytes never enter it. A small,
 * accepted departure from HD 3 (R3): the shell reads a frame's first two bytes, the transfer
 * format's, never a packet's.
 *
 * What the shell gives back: `transferProgress {link, image, bytes}` every 64 KB ‡ and at the end;
 * a transfer frame on a link no grant covers reaches the core as a `frame`, which `links` rejects
 * and counts (`transferNotGranted`); frames the shell refuses on a granted link (a Get outside
 * the file, a bad kind) are answered Gone and reported as `inputRejected`.
 */
import type { TransferRevokeReason } from "../core/model/effects.ts";
import type { LinkId } from "../core/model/ids.ts";

/** A grant: which image `link` may pull, and where its bytes are. */
export interface TransferGrant {
  /** The image id, 8 bytes: the first 8 bytes of the image's SHA-256, as Get frames name it. */
  readonly imageId: Uint8Array;
  /** The 128-byte image header, served from offset 0. */
  readonly header: Uint8Array;
  /** The payload's file in the data folder's `firmware/`, served from offset 128. */
  readonly file: string;
}

export interface Transfers {
  /** A `transferGrant` effect: serve this image on `link` from now; replaces a grant in force. */
  grant(link: LinkId, grant: TransferGrant): void;
  /**
   * A `transferRevoke` effect, or the link closing: later Gets are answered Gone with `reason`,
   * `paused` while a countdown or alarm runs, `notGranted` otherwise and when it is left out.
   */
  revoke(link: LinkId, reason?: TransferRevokeReason): void;
}

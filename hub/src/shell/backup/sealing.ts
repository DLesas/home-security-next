/**
 * A backup file sealed a bounded piece at a time (m2-design.md section 9; the backup codec's
 * incremental form, `backupSealer`): the header first, then the chunks the plaintext completes,
 * at most `bytes` of plaintext a call, so no seal holds the loop past section 3's limit. The
 * plaintext is in memory; nothing of it reaches a disk.
 */
import { type BackupHeader, backupSealer, type BackupSealer } from "@hsn/protocol/app";
import { joined } from "./files.ts";

/** Plaintext sealed a piece at a time ‡ (provisional, section 3). */
export const SEAL_PIECE_BYTES = 256 * 1024;

export class SealStream {
  readonly #sealer: BackupSealer;
  readonly #plain: Uint8Array;
  #at = 0;
  #headerGiven = false;
  #finished = false;

  private constructor(sealer: BackupSealer, plain: Uint8Array) {
    this.#sealer = sealer;
    this.#plain = plain;
  }

  /** A stream for this plaintext, or why the key or header cannot seal. */
  static start(key: Uint8Array, header: BackupHeader, plain: Uint8Array): SealStream | string {
    const sealer = backupSealer(key, header);
    return sealer.ok ? new SealStream(sealer.value, plain) : sealer.error;
  }

  get done(): boolean {
    return this.#finished;
  }

  /** The next sealed bytes from at most `bytes` of plaintext; the last call finishes the file. */
  next(bytes: number = SEAL_PIECE_BYTES): Uint8Array | string {
    if (this.#finished) return new Uint8Array();
    const parts: Uint8Array[] = [];
    if (!this.#headerGiven) {
      parts.push(this.#sealer.headerBytes);
      this.#headerGiven = true;
    }
    const piece = this.#plain.subarray(this.#at, this.#at + bytes);
    this.#at += piece.length;
    if (piece.length > 0) {
      const chunks = this.#sealer.add(piece);
      if (!chunks.ok) return chunks.error;
      parts.push(...chunks.value);
    }
    if (this.#at >= this.#plain.length) {
      const last = this.#sealer.finish();
      if (!last.ok) return last.error;
      parts.push(last.value);
      this.#finished = true;
    }
    return joined(parts);
  }
}

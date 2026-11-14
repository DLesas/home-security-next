/**
 * The control socket's framing (hub-design.md section 9): one JSON request per line, ended by a
 * newline. A line longer than the limit is refused without being kept, and what is left when a
 * connection ends without a newline is a partial line, never executed.
 */

import { CONTROL_LINE_BYTES } from "../../control-protocol/index.ts";

/** `\n`. */
const NEWLINE = 0x0a;

/**
 * The longest request line, in bytes, without its newline: 64 KiB ‡ (m2-design.md section 6),
 * above the largest `fileChunk` line, so the limit bounds what a client can make the hub hold.
 */
export const MAX_REQUEST_LINE_BYTES = CONTROL_LINE_BYTES;

export type LineEvent =
  | { readonly kind: "line"; readonly text: string }
  /** A line passed the limit; the connection is to be closed, since its framing is lost. */
  | { readonly kind: "tooLong"; readonly bytes: number };

/** Splits a byte stream into lines, holding at most `limit` bytes of an unfinished one. */
export class LineReader {
  readonly #limit: number;
  #held: Uint8Array[] = [];
  #heldBytes = 0;
  #overflowed = false;
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(limit: number = MAX_REQUEST_LINE_BYTES) {
    this.#limit = limit;
  }

  /** The lines a chunk completes, in order; after `tooLong`, nothing more. */
  push(chunk: Uint8Array): readonly LineEvent[] {
    if (this.#overflowed) return [];
    const events: LineEvent[] = [];
    let start = 0;
    for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, at);
      if (this.#heldBytes + piece.length > this.#limit) return this.#overflow(events, piece.length);
      events.push({ kind: "line", text: this.#decoder.decode(this.#join(piece)) });
      start = at + 1;
    }
    const rest = chunk.subarray(start);
    if (this.#heldBytes + rest.length > this.#limit) return this.#overflow(events, rest.length);
    if (rest.length > 0) {
      this.#held.push(rest.slice());
      this.#heldBytes += rest.length;
    }
    return events;
  }

  /** Bytes of an unfinished line when the stream ended: a partial line, to record and drop. */
  end(): number {
    const partial = this.#heldBytes;
    this.#held = [];
    this.#heldBytes = 0;
    return partial;
  }

  #join(piece: Uint8Array): Uint8Array {
    if (this.#heldBytes === 0) return piece;
    const line = new Uint8Array(this.#heldBytes + piece.length);
    let offset = 0;
    for (const part of this.#held) {
      line.set(part, offset);
      offset += part.length;
    }
    line.set(piece, offset);
    this.#held = [];
    this.#heldBytes = 0;
    return line;
  }

  #overflow(events: LineEvent[], more: number): readonly LineEvent[] {
    const bytes = this.#heldBytes + more;
    this.#overflowed = true;
    this.#held = [];
    this.#heldBytes = 0;
    return [...events, { kind: "tooLong", bytes }];
  }
}

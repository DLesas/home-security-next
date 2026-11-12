/**
 * Consistent Overhead Byte Stuffing, which removes every zero byte so a zero can end each USB
 * frame (section 10). Encoding follows the usual reference: a 254-byte run that ends the data
 * is not followed by an extra empty block.
 */
import { fail, ok, type Result } from "../result.ts";

/** A block of 254 non-zero bytes with no zero after it. */
const FULL_BLOCK_CODE = 0xff;
const MAX_BLOCK_DATA = FULL_BLOCK_CODE - 1;

/** Most bytes `length` bytes of data can take once encoded, without the delimiter. */
export function maxCobsEncodedLength(length: number): number {
  return length + 1 + Math.floor(length / MAX_BLOCK_DATA);
}

/** Encodes `data`; the result contains no zero byte and no delimiter. */
export function cobsEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let block: number[] = [];
  let endedWithFullBlock = false;
  for (const byte of data) {
    endedWithFullBlock = false;
    if (byte === 0) {
      out.push(block.length + 1, ...block);
      block = [];
    } else {
      block.push(byte);
      if (block.length === MAX_BLOCK_DATA) {
        out.push(FULL_BLOCK_CODE, ...block);
        block = [];
        endedWithFullBlock = true;
      }
    }
  }
  if (!endedWithFullBlock) out.push(block.length + 1, ...block);
  return Uint8Array.from(out);
}

/** Decodes one frame without its delimiter. A zero byte or a block running past the end is `badFrame`. */
export function cobsDecode(encoded: Uint8Array): Result<Uint8Array> {
  if (encoded.length === 0) return fail("badFrame");
  const out: number[] = [];
  let index = 0;
  while (index < encoded.length) {
    const code = encoded[index] ?? 0;
    const end = index + code;
    if (code === 0 || end > encoded.length) return fail("badFrame");
    for (let i = index + 1; i < end; i++) {
      const byte = encoded[i] ?? 0;
      if (byte === 0) return fail("badFrame");
      out.push(byte);
    }
    index = end;
    if (code !== FULL_BLOCK_CODE && index < encoded.length) out.push(0);
  }
  return ok(Uint8Array.from(out));
}

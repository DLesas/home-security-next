/** USB framing (section 10): each packet COBS-encoded and ended by a zero byte. */
import { MaxPacketLength } from "../packet/header.ts";
import { fail, type Result } from "../result.ts";
import { cobsDecode, cobsEncode, maxCobsEncodedLength } from "./cobs.ts";

const FRAME_DELIMITER = 0;

/** One packet or setup message, ready to write to the serial port. */
export function encodeUsbFrame(payload: Uint8Array): Uint8Array {
  const encoded = cobsEncode(payload);
  const frame = new Uint8Array(encoded.length + 1);
  frame.set(encoded);
  frame[encoded.length] = FRAME_DELIMITER;
  return frame;
}

/**
 * Splits a serial byte stream, arriving in chunks of any size, into decoded frames. Each zero
 * byte ends a frame, so a corrupt or oversized frame costs only itself: the decoder reports it
 * and carries on with the next. Empty frames (repeated zeros) are skipped.
 */
export class UsbFrameDecoder {
  readonly #maxPayloadLength: number;
  readonly #maxEncodedLength: number;
  #pending: number[] = [];
  #overflowed = false;

  constructor(maxPayloadLength: number = MaxPacketLength.Link) {
    this.#maxPayloadLength = maxPayloadLength;
    this.#maxEncodedLength = maxCobsEncodedLength(maxPayloadLength);
  }

  /** Feeds received bytes; returns one result per frame completed by them, in order. */
  push(chunk: Uint8Array): Result<Uint8Array>[] {
    const frames: Result<Uint8Array>[] = [];
    for (const byte of chunk) {
      if (byte !== FRAME_DELIMITER) {
        this.#append(byte);
        continue;
      }
      if (this.#overflowed) frames.push(fail("tooLong"));
      else if (this.#pending.length > 0) frames.push(this.#decodePending());
      this.#pending = [];
      this.#overflowed = false;
    }
    return frames;
  }

  #append(byte: number): void {
    if (this.#overflowed) return;
    if (this.#pending.length === this.#maxEncodedLength) {
      // Drop the oversized frame now rather than buffering an endless stream.
      this.#overflowed = true;
      this.#pending = [];
      return;
    }
    this.#pending.push(byte);
  }

  #decodePending(): Result<Uint8Array> {
    const decoded = cobsDecode(Uint8Array.from(this.#pending));
    if (decoded.ok && decoded.value.length > this.#maxPayloadLength) return fail("tooLong");
    return decoded;
  }
}

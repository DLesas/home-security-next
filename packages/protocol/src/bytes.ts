/** Little-endian byte reading and writing, plus small byte helpers. */

export const MAX_U8 = 0xff;
export const MAX_U16 = 0xffff;
export const MAX_U32 = 0xffffffff;

/** True for an integer that fits an unsigned 32-bit field. */
export function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_U32;
}

/**
 * Reads little-endian fields from untrusted bytes. A read that would pass the end returns
 * `undefined` and leaves the position unchanged; nothing here throws.
 */
export class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Bytes not yet read. */
  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  u8(): number | undefined {
    return this.#take(1, (at) => this.#view.getUint8(at));
  }

  i8(): number | undefined {
    return this.#take(1, (at) => this.#view.getInt8(at));
  }

  u16(): number | undefined {
    return this.#take(2, (at) => this.#view.getUint16(at, true));
  }

  i16(): number | undefined {
    return this.#take(2, (at) => this.#view.getInt16(at, true));
  }

  u32(): number | undefined {
    return this.#take(4, (at) => this.#view.getUint32(at, true));
  }

  /** A copy of the next `length` bytes, so decoded values never alias the input. */
  bytes(length: number): Uint8Array | undefined {
    return this.#take(length, (at) => this.#bytes.slice(at, at + length));
  }

  /** A copy of everything not yet read. */
  rest(): Uint8Array {
    return this.#take(this.remaining, (at) => this.#bytes.slice(at)) ?? new Uint8Array(0);
  }

  #take<T>(length: number, read: (at: number) => T): T | undefined {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining) return undefined;
    const value = read(this.#offset);
    this.#offset += length;
    return value;
  }
}

/**
 * Builds little-endian bytes. Writing a value that does not fit its field is a programmer
 * error and throws a RangeError.
 */
export class ByteWriter {
  readonly #out: number[] = [];

  /** Bytes written so far. */
  get length(): number {
    return this.#out.length;
  }

  u8(value: number): this {
    return this.#integer(value, 0, MAX_U8, 1, (view) => {
      view.setUint8(0, value);
    });
  }

  i8(value: number): this {
    return this.#integer(value, -0x80, 0x7f, 1, (view) => {
      view.setInt8(0, value);
    });
  }

  u16(value: number): this {
    return this.#integer(value, 0, MAX_U16, 2, (view) => {
      view.setUint16(0, value, true);
    });
  }

  i16(value: number): this {
    return this.#integer(value, -0x8000, 0x7fff, 2, (view) => {
      view.setInt16(0, value, true);
    });
  }

  u32(value: number): this {
    return this.#integer(value, 0, MAX_U32, 4, (view) => {
      view.setUint32(0, value, true);
    });
  }

  bytes(bytes: Uint8Array): this {
    for (const byte of bytes) this.#out.push(byte);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.#out);
  }

  #integer(
    value: number,
    min: number,
    max: number,
    size: number,
    write: (view: DataView) => void,
  ): this {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`${value} does not fit a ${size}-byte field from ${min} to ${max}`);
    }
    const field = new Uint8Array(size);
    write(new DataView(field.buffer));
    return this.bytes(field);
  }
}

/** Joins byte arrays into one new array. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Lowercase hex, as used in the test vectors. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Parses hex written by `toHex` (either case). Malformed hex is a programmer error and throws. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new RangeError("not an even-length hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

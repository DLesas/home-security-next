/**
 * Field codecs: each reads one field from untrusted bytes and writes it back. Message bodies
 * are declared as ordered lists of these (see layout.ts), so every byte layout is written once.
 */
import type { ByteReader, ByteWriter } from "../bytes.ts";
import { fail, ok, type Result } from "../result.ts";

export interface FieldCodec<T> {
  /** Fewest bytes the field can take. */
  readonly minLength: number;
  /** Never throws; reports a short or malformed field as an error. */
  read(reader: ByteReader): Result<T>;
  /** Throws a RangeError for a value the field cannot hold (a programmer error). */
  write(writer: ByteWriter, value: T): void;
}

type IntegerKind = "u8" | "i8" | "u16" | "i16" | "u32";

function integer(kind: IntegerKind, length: number): FieldCodec<number> {
  return {
    minLength: length,
    read: (reader) => present(reader[kind]()),
    write: (writer, value) => {
      writer[kind](value);
    },
  };
}

function present<T>(value: T | undefined): Result<T> {
  return value === undefined ? fail("truncated") : ok(value);
}

export const u8 = integer("u8", 1);
export const i8 = integer("i8", 1);
export const u16 = integer("u16", 2);
export const i16 = integer("i16", 2);
export const u32 = integer("u32", 4);

/** Exactly `length` bytes, such as a random value or a key. */
export function fixedBytes(length: number): FieldCodec<Uint8Array> {
  return {
    minLength: length,
    read: (reader) => present(reader.bytes(length)),
    write(writer, value) {
      if (value.length !== length) throw new RangeError(`field must be ${length} bytes`);
      writer.bytes(value);
    },
  };
}

/** Everything to the end of the body, which must be `minLength` to `maxLength` bytes long. */
export function restOfBodyBetween(minLength: number, maxLength: number): FieldCodec<Uint8Array> {
  return {
    minLength,
    read(reader) {
      if (reader.remaining < minLength) return fail("truncated");
      if (reader.remaining > maxLength) return fail("tooLong");
      return ok(reader.rest());
    },
    write(writer, value) {
      if (value.length < minLength || value.length > maxLength) {
        throw new RangeError(`must be ${minLength} to ${maxLength} bytes`);
      }
      writer.bytes(value);
    },
  };
}

/** One byte that must be 0 (false) or 1 (true). */
export const booleanByte: FieldCodec<boolean> = {
  minLength: 1,
  read(reader) {
    const byte = reader.u8();
    if (byte === undefined) return fail("truncated");
    if (byte > 1) return fail("badValue");
    return ok(byte === 1);
  },
  write: (writer, value) => writer.u8(value ? 1 : 0),
};

/** Named bits of one flags byte, bit 0 first. */
export type Flags<Names extends readonly string[]> = Readonly<Record<Names[number], boolean>>;

/**
 * A flags byte whose bit `i` is `names[i]`. Bits with no name are ignored when reading and
 * written as zero, so a newer sender's extra flags do not make the body invalid.
 */
export function flagsByte<const Names extends readonly string[]>(
  names: Names,
): FieldCodec<Flags<Names>> {
  if (names.length > 8) throw new RangeError("a flags byte has 8 bits");
  return {
    minLength: 1,
    read(reader) {
      const byte = reader.u8();
      if (byte === undefined) return fail("truncated");
      const flags: Record<string, boolean> = {};
      names.forEach((name, bit) => {
        flags[name] = (byte & (1 << bit)) !== 0;
      });
      // Every name in `names` was given a value above, which is all Flags<Names> requires.
      return ok(flags as Flags<Names>);
    },
    write(writer, value) {
      let byte = 0;
      names.forEach((name: Names[number], bit) => {
        if (value[name]) byte |= 1 << bit;
      });
      writer.u8(byte);
    },
  };
}

/** Bytes after a one-byte length, at most `maxBytes` long, used exactly as sent. */
export function lengthPrefixedBytes(maxBytes: number): FieldCodec<Uint8Array> {
  return {
    minLength: 1,
    read(reader) {
      const length = reader.u8();
      if (length === undefined) return fail("truncated");
      if (length > maxBytes) return fail("badLength");
      return present(reader.bytes(length));
    },
    write(writer, value) {
      if (value.length > maxBytes) throw new RangeError(`longer than ${maxBytes} bytes`);
      writer.u8(value.length).bytes(value);
    },
  };
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/**
 * UTF-8 text after a one-byte length, at most `maxBytes` bytes long. Invalid UTF-8 decodes with
 * replacement characters rather than failing (section 3, "Text").
 */
export function lengthPrefixedText(maxBytes: number): FieldCodec<string> {
  const bytes = lengthPrefixedBytes(maxBytes);
  return {
    minLength: bytes.minLength,
    read(reader) {
      const raw = bytes.read(reader);
      return raw.ok ? ok(utf8Decoder.decode(raw.value)) : raw;
    },
    write(writer, value) {
      bytes.write(writer, utf8Encoder.encode(value));
    },
  };
}

/** One or more items filling the rest of the body. A partial item at the end is truncated. */
export function listToEnd<T>(item: FieldCodec<T>): FieldCodec<readonly T[]> {
  if (item.minLength === 0) throw new RangeError("list items must take at least one byte");
  return {
    minLength: item.minLength,
    read(reader) {
      const items: T[] = [];
      do {
        const next = item.read(reader);
        if (!next.ok) return next;
        items.push(next.value);
      } while (reader.remaining > 0);
      return ok(items);
    },
    write(writer, value) {
      if (value.length === 0) throw new RangeError("list needs at least one item");
      for (const entry of value) item.write(writer, entry);
    },
  };
}

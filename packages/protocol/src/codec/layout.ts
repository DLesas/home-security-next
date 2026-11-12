/**
 * Layouts: a body declared as an ordered list of named fields, mirroring the tables in
 * docs/protocol.md. Reading and writing both walk the same list, so the order lives in one place.
 */
import type { ByteReader, ByteWriter } from "../bytes.ts";
import { fail, failUnknownType, ok, type Result } from "../result.ts";
import type { FieldCodec } from "./field.ts";

export type Layout = readonly (readonly [name: string, codec: FieldCodec<unknown>])[];

export type CodecValue<C> = C extends FieldCodec<infer T> ? T : never;

/** The decoded object a layout describes: one property per field. */
export type LayoutValue<L extends Layout> = {
  readonly [F in L[number] as F[0]]: CodecValue<F[1]>;
};

/** Declares a layout, keeping its field names as literal types. */
export function layout<const L extends Layout>(fields: L): L {
  return fields;
}

export function layoutMinLength(fields: Layout): number {
  return fields.reduce((sum, [, codec]) => sum + codec.minLength, 0);
}

/**
 * Reads every field in order. A body shorter than the fields need is truncated; bytes after
 * the last field are left unread, which is how receivers ignore fields added later.
 */
function readFields(fields: Layout, reader: ByteReader): Result<Record<string, unknown>> {
  if (reader.remaining < layoutMinLength(fields)) return fail("truncated");
  const value: Record<string, unknown> = {};
  for (const [name, codec] of fields) {
    const field = codec.read(reader);
    if (!field.ok) return field;
    value[name] = field.value;
  }
  return ok(value);
}

function writeFields(
  fields: Layout,
  writer: ByteWriter,
  value: Readonly<Record<string, unknown>>,
): void {
  for (const [name, codec] of fields) codec.write(writer, value[name]);
}

/** A nested group of fields, such as a firmware version. */
export function struct<const L extends Layout>(fields: L): FieldCodec<LayoutValue<L>> {
  return {
    minLength: layoutMinLength(fields),
    read(reader) {
      const value = readFields(fields, reader);
      // readFields gave every field in `fields` its decoded value, which is LayoutValue<L>.
      return value.ok ? ok(value.value as LayoutValue<L>) : value;
    },
    write: (writer, value) => {
      writeFields(fields, writer, value);
    },
  };
}

/** Maps a type byte to the layout of the body that follows it. */
export type Registry = Readonly<Record<number, Layout>>;

/** One variant per registry entry, told apart by `type`. */
export type VariantOf<R extends Registry> = {
  [T in keyof R & number]: { readonly type: T } & LayoutValue<R[T]>;
}[keyof R & number];

/** Encoding and decoding of a type byte followed by that type's body. */
export interface TaggedCodec<V> {
  encode(writer: ByteWriter, value: V): void;
  /** Unknown type bytes give `unknownType`, carrying the type for the caller to log. */
  decode(reader: ByteReader): Result<V>;
}

export function taggedUnion<const R extends Registry>(registry: R): TaggedCodec<VariantOf<R>> {
  const layoutFor = (type: number): Layout | undefined =>
    Object.hasOwn(registry, type) ? registry[type] : undefined;
  return {
    encode(writer, value) {
      const fields = layoutFor(value.type);
      if (fields === undefined) throw new RangeError(`no layout for type ${value.type}`);
      writer.u8(value.type);
      writeFields(fields, writer, value);
    },
    decode(reader) {
      const type = reader.u8();
      if (type === undefined) return fail("truncated");
      const fields = layoutFor(type);
      if (fields === undefined) return failUnknownType(type);
      const body = readFields(fields, reader);
      if (!body.ok) return body;
      // `type` chose `fields`, and the body was read with exactly those fields.
      return ok({ type, ...body.value } as VariantOf<R>);
    },
  };
}

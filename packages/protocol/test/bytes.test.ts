import { describe, expect, test } from "bun:test";
import { ByteReader, ByteWriter, concatBytes, fromHex, isU32, toHex } from "../src/index.ts";

describe("ByteReader", () => {
  test("reads little-endian fields in order", () => {
    const reader = new ByteReader(fromHex("01ff3412feff78563412"));
    expect(reader.u8()).toBe(0x01);
    expect(reader.i8()).toBe(-1);
    expect(reader.u16()).toBe(0x1234);
    expect(reader.i16()).toBe(-2);
    expect(reader.u32()).toBe(0x12345678);
    expect(reader.remaining).toBe(0);
  });

  test("a read past the end returns undefined and consumes nothing", () => {
    const reader = new ByteReader(fromHex("aabbcc"));
    expect(reader.u32()).toBeUndefined();
    expect(reader.bytes(4)).toBeUndefined();
    expect(reader.remaining).toBe(3);
    expect(reader.u16()).toBe(0xbbaa);
    expect(reader.u16()).toBeUndefined();
    expect(reader.u8()).toBe(0xcc);
    expect(reader.u8()).toBeUndefined();
    expect(reader.rest()).toEqual(new Uint8Array(0));
  });

  test("an empty input gives undefined for every fixed read", () => {
    const reader = new ByteReader(new Uint8Array(0));
    expect([reader.u8(), reader.i8(), reader.u16(), reader.i16(), reader.u32()]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("bytes() rejects negative and fractional lengths", () => {
    const reader = new ByteReader(fromHex("0102"));
    expect(reader.bytes(-1)).toBeUndefined();
    expect(reader.bytes(1.5)).toBeUndefined();
    expect(reader.bytes(0)).toEqual(new Uint8Array(0));
  });

  test("returns copies, so later changes to the input do not show through", () => {
    const input = fromHex("0102030405");
    const reader = new ByteReader(input);
    const head = reader.bytes(2);
    const tail = reader.rest();
    input.fill(0);
    expect(head).toEqual(fromHex("0102"));
    expect(tail).toEqual(fromHex("030405"));
  });

  test("respects the offset of a subarray view", () => {
    const view = fromHex("ff0100ff").subarray(1, 3);
    expect(new ByteReader(view).u16()).toBe(1);
  });
});

describe("ByteWriter", () => {
  test("writes little-endian fields", () => {
    const bytes = new ByteWriter().u8(1).i8(-1).u16(0x1234).i16(-2).u32(0x12345678).finish();
    expect(toHex(bytes)).toBe("01ff3412feff78563412");
  });

  test("writes the extremes of every width", () => {
    const bytes = new ByteWriter()
      .u8(0)
      .u8(255)
      .i8(-128)
      .i8(127)
      .u16(0xffff)
      .i16(-0x8000)
      .i16(0x7fff)
      .u32(0xffffffff)
      .finish();
    expect(toHex(bytes)).toBe("00ff807fffff0080ff7fffffffff");
  });

  test.each([
    ["u8", (w: ByteWriter) => w.u8(256)],
    ["u8 negative", (w: ByteWriter) => w.u8(-1)],
    ["u8 fraction", (w: ByteWriter) => w.u8(1.5)],
    ["i8", (w: ByteWriter) => w.i8(128)],
    ["i8 low", (w: ByteWriter) => w.i8(-129)],
    ["u16", (w: ByteWriter) => w.u16(0x10000)],
    ["i16", (w: ByteWriter) => w.i16(0x8000)],
    ["u32", (w: ByteWriter) => w.u32(2 ** 32)],
    ["u32 NaN", (w: ByteWriter) => w.u32(Number.NaN)],
  ])("throws a RangeError for a value that does not fit: %s", (_, write) => {
    expect(() => write(new ByteWriter())).toThrow(RangeError);
  });
});

describe("helpers", () => {
  test("hex round trip, lowercase out, either case in", () => {
    expect(toHex(fromHex("00FFa5"))).toBe("00ffa5");
    expect(fromHex("")).toEqual(new Uint8Array(0));
  });

  test("fromHex rejects malformed hex", () => {
    expect(() => fromHex("abc")).toThrow(RangeError);
    expect(() => fromHex("zz")).toThrow(RangeError);
  });

  test("concatBytes joins in order", () => {
    expect(toHex(concatBytes(fromHex("01"), new Uint8Array(0), fromHex("0203")))).toBe("010203");
  });

  test("isU32 bounds", () => {
    expect(isU32(0)).toBe(true);
    expect(isU32(0xffffffff)).toBe(true);
    expect(isU32(2 ** 32)).toBe(false);
    expect(isU32(-1)).toBe(false);
    expect(isU32(0.5)).toBe(false);
  });
});

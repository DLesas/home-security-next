import { describe, expect, test } from "bun:test";
import {
  cobsDecode,
  cobsEncode,
  concatBytes,
  encodeUsbFrame,
  fromHex,
  maxCobsEncodedLength,
  type Result,
  toHex,
  UsbFrameDecoder,
} from "../src/index.ts";

const nonZero = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i % 255) + 1);

function expectRoundTrip(data: Uint8Array): Uint8Array {
  const encoded = cobsEncode(data);
  expect(encoded.includes(0)).toBe(false);
  expect(encoded.length).toBeLessThanOrEqual(maxCobsEncodedLength(data.length));
  expect(cobsDecode(encoded)).toEqual({ ok: true, value: data });
  return encoded;
}

describe("COBS", () => {
  test("known encodings", () => {
    const known: readonly (readonly [string, string])[] = [
      ["", "01"],
      ["00", "0101"],
      ["0000", "010101"],
      ["11220033", "0311220233"],
      ["11223344", "0511223344"],
      ["11000000", "0211010101"],
    ];
    for (const [data, encoded] of known) {
      expect(toHex(cobsEncode(fromHex(data)))).toBe(encoded);
      expect(cobsDecode(fromHex(encoded))).toEqual({ ok: true, value: fromHex(data) });
    }
  });

  test("a zero at every position of a 300-byte packet", () => {
    for (let position = 0; position < 300; position++) {
      const data = nonZero(300);
      data[position] = 0;
      expectRoundTrip(data);
    }
  });

  test("runs around the 254-byte block boundary", () => {
    for (const length of [253, 254, 255, 256, 507, 508, 509, 762, 1024]) {
      expectRoundTrip(nonZero(length));
      expectRoundTrip(concatBytes(nonZero(length), fromHex("00")));
      expectRoundTrip(concatBytes(fromHex("00"), nonZero(length)));
    }
  });

  test("254 non-zero bytes take one full block and no extra code", () => {
    const encoded = cobsEncode(nonZero(254));
    expect(encoded.length).toBe(255);
    expect(encoded[0]).toBe(0xff);
    expect(toHex(cobsEncode(concatBytes(nonZero(254), fromHex("00"))))).toBe(
      "ff" + toHex(nonZero(254)) + "0101",
    );
  });

  test("all zeros and long mixed data", () => {
    expectRoundTrip(new Uint8Array(1024));
    expectRoundTrip(Uint8Array.from({ length: 1024 }, (_, i) => (i * 7) & 0xff));
  });

  test("decoding also accepts an extra empty block after a full one", () => {
    expect(cobsDecode(concatBytes(fromHex("ff"), nonZero(254), fromHex("01")))).toEqual({
      ok: true,
      value: nonZero(254),
    });
  });

  test("invalid encodings are badFrame", () => {
    for (const encoded of ["", "00", "0100", "031100", "051122", "02", "ff01"]) {
      expect(cobsDecode(fromHex(encoded))).toEqual({ ok: false, error: { code: "badFrame" } });
    }
  });
});

describe("USB frames", () => {
  const frames = [fromHex("11220033"), nonZero(254), new Uint8Array(1), nonZero(1024)];
  const stream = concatBytes(...frames.map(encodeUsbFrame));
  const decoded = (results: Result<Uint8Array>[]) =>
    results.map((r) => (r.ok ? toHex(r.value) : r.error.code));

  test("a frame is the COBS encoding followed by one zero", () => {
    expect(toHex(encodeUsbFrame(fromHex("11220033")))).toBe("031122023300");
  });

  test("chunked at every split point, a stream gives the same frames", () => {
    const expected = frames.map(toHex);
    for (let split = 0; split <= stream.length; split++) {
      const decoder = new UsbFrameDecoder();
      const results = [
        ...decoder.push(stream.subarray(0, split)),
        ...decoder.push(stream.subarray(split)),
      ];
      expect(decoded(results)).toEqual(expected);
    }
  });

  test("byte-at-a-time chunks give the same frames", () => {
    const decoder = new UsbFrameDecoder();
    const results = Array.from(stream).flatMap((byte) => decoder.push(Uint8Array.of(byte)));
    expect(decoded(results)).toEqual(frames.map(toHex));
  });

  test("repeated zeros are skipped and an unfinished frame waits", () => {
    const decoder = new UsbFrameDecoder();
    expect(decoder.push(fromHex("000000"))).toEqual([]);
    expect(decoder.push(fromHex("03112202"))).toEqual([]);
    expect(decoded(decoder.push(fromHex("3300")))).toEqual(["11220033"]);
  });

  test("a frame of zero bytes is passed on, unlike an empty frame", () => {
    const decoder = new UsbFrameDecoder();
    expect(decoded(decoder.push(fromHex("0000" + "0100" + "00")))).toEqual([""]);
  });

  test("resynchronises after a corrupt frame", () => {
    const decoder = new UsbFrameDecoder();
    const results = decoder.push(concatBytes(fromHex("05112200"), encodeUsbFrame(fromHex("aa"))));
    expect(decoded(results)).toEqual(["badFrame", "aa"]);
  });

  test("drops a frame longer than the limit and carries on", () => {
    const decoder = new UsbFrameDecoder();
    const tooLong = encodeUsbFrame(nonZero(1025));
    const results = decoder.push(concatBytes(tooLong, encodeUsbFrame(fromHex("bb"))));
    expect(decoded(results)).toEqual(["tooLong", "bb"]);
  });

  test("an endless frame does not grow the buffer, and the next frame still decodes", () => {
    const decoder = new UsbFrameDecoder(16);
    for (let i = 0; i < 100; i++) expect(decoder.push(new Uint8Array(1000).fill(1))).toEqual([]);
    expect(
      decoded(decoder.push(concatBytes(fromHex("00"), encodeUsbFrame(fromHex("cc"))))),
    ).toEqual(["tooLong", "cc"]);
  });

  test("a frame exactly at the limit is accepted", () => {
    const decoder = new UsbFrameDecoder(254);
    expect(decoded(decoder.push(encodeUsbFrame(nonZero(254))))).toEqual([toHex(nonZero(254))]);
    expect(decoded(decoder.push(encodeUsbFrame(new Uint8Array(255))))).toEqual(["tooLong"]);
  });
});

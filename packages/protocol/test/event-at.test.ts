/**
 * An event time in a decision's `detail` (`eventAtDetail`, `eventAtOf`; D102): the wall time a late
 * notification's event happened, whole milliseconds since 1970 UTC, 8 bytes, u64 little-endian.
 */
import { describe, expect, test } from "bun:test";
import { EVENT_AT_DETAIL_BYTES, eventAtDetail, eventAtOf } from "../src/records.ts";

describe("an event time as a decision's detail (D102)", () => {
  test("8 bytes, u64 little-endian, whole milliseconds, read back exactly", () => {
    const at = Date.UTC(2026, 10, 13, 3, 10, 0, 123);
    const detail = eventAtDetail(at);
    expect(detail.length).toBe(EVENT_AT_DETAIL_BYTES);
    expect([...detail]).toEqual([...new Uint8Array(new BigUint64Array([BigInt(at)]).buffer)]);
    expect(eventAtOf(detail)).toBe(at);
  });

  test("rounded down to the millisecond; the largest safe time; 0", () => {
    expect(eventAtOf(eventAtDetail(1_000.999))).toBe(1_000);
    expect(eventAtOf(eventAtDetail(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(eventAtOf(eventAtDetail(0))).toBe(0);
  });

  test("never throws: before 1970, not finite, or past the safe range, written as 0", () => {
    for (const odd of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(eventAtOf(eventAtDetail(odd))).toBe(0);
    }
  });

  test("any other detail is no event time: none, another length, a value past the safe range", () => {
    expect(eventAtOf(null)).toBeUndefined();
    expect(eventAtOf(undefined)).toBeUndefined();
    expect(eventAtOf(new Uint8Array(7))).toBeUndefined();
    expect(eventAtOf(new Uint8Array(9))).toBeUndefined();
    expect(eventAtOf(new Uint8Array(8).fill(0xff))).toBeUndefined();
  });

  test("read from a view into a larger buffer, at an offset", () => {
    const buffer = new Uint8Array(12);
    buffer.set(eventAtDetail(42), 3);
    expect(eventAtOf(buffer.subarray(3, 11))).toBe(42);
  });
});

import { describe, expect, test } from "bun:test";
import {
  DATA_RATE_COUNT,
  dataRateMask,
  dataRatesInMask,
  EVENT_LISTEN_MS,
  eventListenMs,
  spreadingFactor,
  timeOnAirMs,
} from "../src/index.ts";

describe("data rates", () => {
  test("DR0 to DR5 map to SF12 down to SF7", () => {
    expect([0, 1, 2, 3, 4, 5].map(spreadingFactor)).toEqual([12, 11, 10, 9, 8, 7]);
    expect(spreadingFactor(6)).toBeUndefined();
    expect(spreadingFactor(-1)).toBeUndefined();
    expect(spreadingFactor(1.5)).toBeUndefined();
  });

  test("masks have one bit per index", () => {
    expect(dataRateMask([2, 5])).toBe(0b100100);
    expect(dataRatesInMask(0b100100)).toEqual([2, 5]);
    expect(dataRatesInMask(0xff)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(dataRateMask([])).toBe(0);
    expect(() => dataRateMask([6])).toThrow(RangeError);
  });
});

describe("time on air", () => {
  // docs/protocol.md section 2, milliseconds rounded to whole numbers.
  const table: readonly (readonly [string, number, readonly [number, number, number, number]])[] = [
    ["sensor status", 25, [62, 206, 412, 1483]],
    ["hub reply", 32, [72, 247, 453, 1810]],
    ["disarmed notice", 18, [51, 185, 330, 1319]],
    ["siren command", 21, [57, 185, 371, 1483]],
    ["siren report", 28, [67, 226, 412, 1647]],
    ["started", 26, [62, 206, 412, 1647]],
    ["log entry over LoRa, longest", 50, [98, 329, 616, 2302]],
  ];
  test.each(table)("%s, %i bytes, matches the spec table", (_, length, expected) => {
    const rounded = [7, 9, 10, 12].map((sf) => Math.round(timeOnAirMs(sf, length)));
    expect(rounded).toEqual([...expected]);
  });

  test("matches the worked example and the table in spike S2", () => {
    expect(timeOnAirMs(7, 16)).toBeCloseTo(51.456, 6);
    expect(timeOnAirMs(9, 24)).toBeCloseTo(205.8, 1);
    expect(timeOnAirMs(11, 32)).toBeCloseTo(987.1, 1);
    expect(timeOnAirMs(12, 24)).toBeCloseTo(1482.8, 1);
  });

  test("low data rate optimisation applies from SF11", () => {
    // Without it SF11 at 32 bytes would need 6 payload blocks of 44 bits, not 8 of 36.
    expect(timeOnAirMs(11, 32)).toBeCloseTo((60.25 * 2048) / 125, 9);
    expect(timeOnAirMs(10, 32)).toBeCloseTo((55.25 * 1024) / 125, 9);
  });

  test("refuses settings outside the radio's", () => {
    expect(() => timeOnAirMs(6, 10)).toThrow(RangeError);
    expect(() => timeOnAirMs(13, 10)).toThrow(RangeError);
    expect(() => timeOnAirMs(7, 256)).toThrow(RangeError);
    expect(() => timeOnAirMs(7, -1)).toThrow(RangeError);
    expect(timeOnAirMs(7, 0)).toBeGreaterThan(0);
  });
});

describe("event listen time", () => {
  test("is section 8's table, 3.0 s at DR0 down to 1.5 s at DR5", () => {
    expect([0, 1, 2, 3, 4, 5].map(eventListenMs)).toEqual([3000, 2600, 2200, 1900, 1700, 1500]);
    expect(EVENT_LISTEN_MS).toHaveLength(DATA_RATE_COUNT);
  });

  test("has no value for an index outside the table", () => {
    expect(eventListenMs(6)).toBeUndefined();
    expect(eventListenMs(-1)).toBeUndefined();
    expect(eventListenMs(2.5)).toBeUndefined();
  });

  test("leaves room for a reply at every rate (section 7, worked example)", () => {
    // The hub's latest start is the listen time less the reply's airtime: positive at every rate.
    for (let dataRate = 0; dataRate < DATA_RATE_COUNT; dataRate++) {
      const listen = eventListenMs(dataRate) ?? 0;
      expect(listen - timeOnAirMs(spreadingFactor(dataRate) ?? 7, 30)).toBeGreaterThan(0);
    }
  });
});

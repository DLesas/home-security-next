import { describe, expect, test } from "bun:test";
import {
  airtimePercent,
  batteryCode,
  batteryMillivolts,
  fifteenSecondUnitsFromSeconds,
  millisecondsFromTenths,
  secondsFromFifteenSecondUnits,
  snrDecibels,
  tenthsFromMilliseconds,
} from "../src/index.ts";

describe("battery byte", () => {
  test("decodes as 2,500 + 10 × the byte", () => {
    expect(batteryMillivolts(0)).toBe(2500);
    expect(batteryMillivolts(120)).toBe(3700);
    expect(batteryMillivolts(255)).toBe(5050);
  });

  test("encodes rounded to nearest and limited to 0–255", () => {
    expect(batteryCode(3700)).toBe(120);
    expect(batteryCode(3704)).toBe(120);
    expect(batteryCode(3705)).toBe(121);
    expect(batteryCode(3696)).toBe(120);
    expect(batteryCode(2500)).toBe(0);
    expect(batteryCode(2000)).toBe(0);
    expect(batteryCode(5050)).toBe(255);
    expect(batteryCode(6000)).toBe(255);
    expect(() => batteryCode(Number.NaN)).toThrow(RangeError);
  });

  test("every byte survives decoding and re-encoding", () => {
    for (let code = 0; code < 256; code++) expect(batteryCode(batteryMillivolts(code))).toBe(code);
  });
});

describe("other units", () => {
  test("15-second units", () => {
    expect(secondsFromFifteenSecondUnits(12)).toBe(180);
    expect(fifteenSecondUnitsFromSeconds(300)).toBe(20);
    expect(fifteenSecondUnitsFromSeconds(3825)).toBe(255);
    expect(() => fifteenSecondUnitsFromSeconds(3840)).toThrow(RangeError);
    expect(() => fifteenSecondUnitsFromSeconds(20)).toThrow(RangeError);
  });

  test("tenths of a second", () => {
    expect(millisecondsFromTenths(1795)).toBe(179500);
    expect(tenthsFromMilliseconds(179_549)).toBe(1795);
    expect(tenthsFromMilliseconds(6_553_500)).toBe(65535);
    expect(() => tenthsFromMilliseconds(6_553_550)).toThrow(RangeError);
    expect(() => tenthsFromMilliseconds(-100)).toThrow(RangeError);
  });

  test("signal-to-noise and airtime", () => {
    expect(snrDecibels(-30)).toBe(-7.5);
    expect(airtimePercent(125)).toBe(1.25);
  });
});

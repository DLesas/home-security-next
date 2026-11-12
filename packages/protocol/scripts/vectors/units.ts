/** Unit conversion vectors (sections 3 and 6), so every implementation rounds the same way. */
import {
  airtimePercent,
  batteryCode,
  batteryMillivolts,
  fifteenSecondUnitsFromSeconds,
  millisecondsFromTenths,
  ppmFromTenPpmUnits,
  secondsFromFifteenSecondUnits,
  snrDecibels,
  tenPpmUnitsFromPpm,
  tenthsFromMilliseconds,
} from "../../src/index.ts";
import type { Json, JsonObject } from "./json.ts";

/** An encoding the library refuses (it throws) is recorded as null. */
function orNull(encode: () => number): number | null {
  try {
    return encode();
  } catch {
    return null;
  }
}

export function unitVectorFile(): JsonObject {
  return {
    batteryEncode: [
      2000, 2494, 2495, 2500, 2504, 2505, 2506, 3695, 3700, 3704, 3705, 5045, 5050, 5054, 5055,
      9999,
    ].map((millivolts): Json => ({ millivolts, byte: batteryCode(millivolts) })),
    batteryDecode: [0, 1, 120, 254, 255].map((byte): Json => ({
      byte,
      millivolts: batteryMillivolts(byte),
    })),
    fifteenSecondDecode: [0, 1, 12, 20, 255].map((units): Json => ({
      units,
      seconds: secondsFromFifteenSecondUnits(units),
    })),
    fifteenSecondEncode: [0, 15, 180, 300, 3825, 20, 3840].map((seconds): Json => ({
      seconds,
      units: orNull(() => fifteenSecondUnitsFromSeconds(seconds)),
    })),
    tenthsDecode: [0, 1, 1795, 65535].map((tenths): Json => ({
      tenths,
      milliseconds: millisecondsFromTenths(tenths),
    })),
    tenthsEncode: [0, 49, 50, 149, 150, 179549, 179550, 6553500, 6553549, 6553550].map(
      (milliseconds): Json => ({
        milliseconds,
        tenths: orNull(() => tenthsFromMilliseconds(milliseconds)),
      }),
    ),
    clockCorrectionDecode: [-32768, -100, -1, 0, 1, 12, 32767].map((units): Json => ({
      units,
      ppm: ppmFromTenPpmUnits(units),
    })),
    clockCorrectionEncode: [
      -327680, -327685, -1000, -25, -15, -14, -5, 0, 4, 5, 15, 25, 123, 327670, 327674, 327675,
    ].map((ppm): Json => ({ ppm, units: orNull(() => tenPpmUnitsFromPpm(ppm)) })),
    snrDecode: [-128, -30, -1, 0, 1, 127].map((quarterDecibels): Json => ({
      quarterDecibels,
      decibels: snrDecibels(quarterDecibels),
    })),
    airtimeDecode: [0, 1, 125, 10000, 65535].map((hundredthsOfPercent): Json => ({
      hundredthsOfPercent,
      percent: airtimePercent(hundredthsOfPercent),
    })),
  };
}

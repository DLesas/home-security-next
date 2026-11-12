/**
 * Conversions between the raw units fields carry on the wire and everyday units. Message
 * objects always hold the raw value; these helpers are the one place each conversion lives.
 */
import { MAX_U16, MAX_U8 } from "../bytes.ts";

const BATTERY_BASE_MILLIVOLTS = 2500;
const BATTERY_STEP_MILLIVOLTS = 10;

/** Battery or cell byte to millivolts: 2,500 + 10 × the byte (section 3). */
export function batteryMillivolts(code: number): number {
  return BATTERY_BASE_MILLIVOLTS + BATTERY_STEP_MILLIVOLTS * code;
}

/** Millivolts to the battery byte: (mV − 2,500) ÷ 10, rounded to nearest and limited to 0–255. */
export function batteryCode(millivolts: number): number {
  if (!Number.isFinite(millivolts)) throw new RangeError("millivolts must be a finite number");
  const code = Math.round((millivolts - BATTERY_BASE_MILLIVOLTS) / BATTERY_STEP_MILLIVOLTS);
  return Math.min(MAX_U8, Math.max(0, code));
}

const FIFTEEN_SECONDS = 15;

/** Heartbeat and LoRa check intervals are sent in units of 15 seconds. */
export function secondsFromFifteenSecondUnits(units: number): number {
  return units * FIFTEEN_SECONDS;
}

/** Seconds to 15-second units; throws unless it is a whole number of units that fits a byte. */
export function fifteenSecondUnitsFromSeconds(seconds: number): number {
  const units = seconds / FIFTEEN_SECONDS;
  if (!Number.isInteger(units) || units < 0 || units > MAX_U8) {
    throw new RangeError("interval must be a multiple of 15 seconds from 0 to 3,825");
  }
  return units;
}

const MILLISECONDS_PER_TENTH = 100;

/** The reply's next-heartbeat field is in tenths of a second. */
export function millisecondsFromTenths(tenths: number): number {
  return tenths * MILLISECONDS_PER_TENTH;
}

/** Milliseconds to tenths of a second, rounded to nearest; throws if it does not fit 16 bits. */
export function tenthsFromMilliseconds(milliseconds: number): number {
  const tenths = Math.round(milliseconds / MILLISECONDS_PER_TENTH);
  if (!Number.isInteger(tenths) || tenths < 0 || tenths > MAX_U16) {
    throw new RangeError("time must be from 0 to 6,553.5 seconds");
  }
  return tenths;
}

/** Forwarded packets carry the signal-to-noise ratio × 4. */
export function snrDecibels(quarterDecibels: number): number {
  return quarterDecibels / 4;
}

/** Gateway status carries airtime in hundredths of a percent. */
export function airtimePercent(hundredthsOfPercent: number): number {
  return hundredthsOfPercent / 100;
}

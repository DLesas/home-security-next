/**
 * Battery percentage and the low-battery rule (m2-design.md section 7, "Device health"; HB33,
 * D109). Pure.
 *
 * - The percentage comes from `HubRules.health.batteryCurve`: (millivolts, percent) points,
 *   lowest first, linear between, held at its ends. Until the cell is measured it is the interim
 *   table, whose 10% point is the firmware's own 3,500 mV (`kLowBatteryMillivolts`).
 * - Low is decided on the exact value of the curve, not on the rounded percentage shown, so the
 *   hub's 10% is exactly the firmware's 3,500 mV: a reading of 3,510 mV is 10.5%, not low.
 * - Raised at 10% or below, cleared above 15% (HB33): between the two the state stays as it is,
 *   so a reading's noise cannot make it flap.
 */
import type { HubRules } from "../model/rules.ts";

type Curve = HubRules["health"]["batteryCurve"];

/** The exact charge of a cell at `millivolts`, 0 to 100, on the curve; undefined for no curve. */
export function chargeAt(curve: Curve, millivolts: number): number | undefined {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (first === undefined || last === undefined) return undefined;
  if (millivolts <= first[0]) return first[1];
  if (millivolts >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const low = curve[i - 1];
    const high = curve[i];
    if (low === undefined || high === undefined) return undefined;
    if (millivolts <= high[0]) {
      const span = high[0] - low[0];
      if (span <= 0) return high[1];
      return low[1] + ((millivolts - low[0]) * (high[1] - low[1])) / span;
    }
  }
  return last[1];
}

/** The percentage the app shows (`batteryPercent`, an integer 0 to 100). */
export function batteryPercent(rules: HubRules, millivolts: number): number | undefined {
  const charge = chargeAt(rules.health.batteryCurve, millivolts);
  return charge === undefined ? undefined : Math.min(100, Math.max(0, Math.round(charge)));
}

/**
 * The low-battery state after a reading at `millivolts`, starting from `wasLow` (HB33): low at
 * `batteryLowPercent` or below, no longer low above `batteryOkPercent`, otherwise unchanged.
 */
export function lowAfter(rules: HubRules, wasLow: boolean, millivolts: number): boolean {
  const charge = chargeAt(rules.health.batteryCurve, millivolts);
  if (charge === undefined) return wasLow;
  if (charge <= rules.health.batteryLowPercent) return true;
  if (charge > rules.health.batteryOkPercent) return false;
  return wasLow;
}

/**
 * Clock correction (hub-design.md section 8, "Clock correction"; protocol.md §7; D108). The
 * sensor sleeps I × (1 + c) on its own clock, c being the correction it holds; its clock runs fast
 * by d, so two slotted heartbeats m intervals apart arrive G = m·I·(1 + c) ÷ (1 + d) apart on the
 * gateway's clock, and d = m·I·(1 + c) ÷ G − 1. The estimate is the median of the last 5 ‡
 * samples; a new correction c' = d̂ is sent when it differs from c by at least 50 ppm ‡, with at
 * least 3 samples, at most once every 6 hours ‡, in units of 10 ppm, within ±32 % (§6). Pure.
 */
import { ok, type Result } from "neverthrow";
import type { HubError } from "../model/errors.ts";
import type { HubRules } from "../model/rules.ts";
import { MICROS_PER_MILLISECOND } from "../model/time.ts";
import { safeTenPpmUnitsFromPpm } from "../util/protocol-safe.ts";

/** Parts per million in one. */
export const PPM = 1_000_000;
/** Parts per million in one unit of the reply's clock correction (§6). */
export const PPM_PER_UNIT = 10;

/** m: the gap in whole intervals, rounded (section 8). */
export function intervalsIn(gapUs: number, intervalUs: number): number {
  return Math.round(gapUs / intervalUs);
}

/** d = m·I·(1 + c) ÷ G − 1, as a fraction (section 8). */
export function driftOf(
  m: number,
  intervalUs: number,
  correctionUnits: number,
  gapUs: number,
): number {
  return (m * intervalUs * (1 + (correctionUnits * PPM_PER_UNIT) / PPM)) / gapUs - 1;
}

/** G' = m·I·(1 + c) ÷ (1 + d): the gap a drift of d predicts. */
export function predictedGapUs(
  m: number,
  intervalUs: number,
  correctionUnits: number,
  drift: number,
): number {
  return (m * intervalUs * (1 + (correctionUnits * PPM_PER_UNIT) / PPM)) / (1 + drift);
}

/** The median, the mean of the two middle values for an even count; undefined when empty. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

/**
 * Whether a new sample of a gap is kept (section 8): m from 1 to 4, and, once there is an
 * estimate, no more than 0.5 s ‡ off the gap it predicts, which drops the 0.2 to 2 s waits of a
 * busy channel check (§2).
 */
export function keepsSample(
  rules: HubRules,
  m: number,
  intervalUs: number,
  correctionUnits: number,
  gapUs: number,
  estimate: number | undefined,
): boolean {
  if (m < 1 || m > rules.clockCorrection.maxIntervals) return false;
  if (estimate === undefined) return true;
  const predicted = predictedGapUs(m, intervalUs, correctionUnits, estimate);
  return Math.abs(gapUs - predicted) <= rules.clockCorrection.outlierMs * MICROS_PER_MILLISECOND;
}

/** The last `medianOf` samples with a new one. */
export function withSample(
  rules: HubRules,
  samples: readonly number[],
  drift: number,
): readonly number[] {
  return [...samples, drift].slice(-rules.clockCorrection.medianOf);
}

/**
 * The correction to send, in units of 10 ppm, or undefined when it stays: fewer than 3 samples,
 * a change under 50 ppm, or less than 6 hours since the last change (`changeAllowed` false).
 */
export function correctionToSend(
  rules: HubRules,
  samples: readonly number[],
  heldUnits: number,
  changeAllowed: boolean,
): Result<number | undefined, HubError> {
  const { minSamples, changePpm, limitPpm } = rules.clockCorrection;
  const estimate = median(samples);
  if (!changeAllowed || samples.length < minSamples || estimate === undefined) return ok(undefined);
  const wantedPpm = Math.min(limitPpm, Math.max(-limitPpm, estimate * PPM));
  if (Math.abs(wantedPpm - heldUnits * PPM_PER_UNIT) < changePpm) return ok(undefined);
  return safeTenPpmUnitsFromPpm(wantedPpm).map((units) =>
    units === heldUnits ? undefined : units,
  );
}

/**
 * Sensor silence (hub-design.md section 8, "Silence"; D107, D114, HB25): how many missed
 * heartbeats make a sensor silent, chosen daily from its loss over the last 7 days, and when.
 * Pure.
 */
import type { LossDailyRow } from "../model/rows.ts";
import type { HubRules } from "../model/rules.ts";
import { type Mono, monoAfterMs, MILLISECONDS_PER_SECOND } from "../model/time.ts";

/** Seconds in a year of 365 days, for H, the heartbeats a sensor sends in a year (D107). */
const SECONDS_PER_YEAR = 365 * 86_400;
/** Milliseconds in a day, for the day of a `loss_daily` row (section 6). */
export const MILLISECONDS_PER_DAY = 86_400_000;

/** The `loss_daily` day of a wall time: days since 1970 (section 6). */
export function dayOf(wallMs: number): number {
  return Math.floor(wallMs / MILLISECONDS_PER_DAY);
}

/** Received and expected packets summed over some days. */
export interface LossTotals {
  readonly received: number;
  readonly expected: number;
}

/**
 * The totals of the last `lossDays` days before `today` (D107), and whether there is a day of
 * data at all: a whole day before today with something expected.
 */
export function lossOverDays(
  rules: HubRules,
  rows: readonly LossDailyRow[],
  today: number,
): LossTotals | undefined {
  const days = rows.filter(
    (row) => row.day < today && row.day >= today - rules.silence.lossDays && row.expected > 0,
  );
  if (days.length === 0) return undefined;
  return days.reduce(
    (sum, row) => ({
      received: sum.received + row.received,
      expected: sum.expected + row.expected,
    }),
    { received: 0, expected: 0 },
  );
}

/** p = 1 − received ÷ expected, never below 0 (D107). */
export function lossFraction(totals: LossTotals): number {
  return totals.expected <= 0 ? 0 : Math.max(0, 1 - totals.received / totals.expected);
}

/**
 * D107's n: the smallest from 3 to 8 with H × pⁿ ≤ 1 ÷ S, H being the heartbeats a year at
 * interval I and S the sensors on the site, so the site stays under one false alert a year; 8 if
 * none. Before a day of data, 5 ‡ (D114).
 */
export function missedHeartbeats(
  rules: HubRules,
  totals: LossTotals | undefined,
  intervalMs: number,
  sensorsOnSite: number,
): number {
  const { sensorMinMissed, sensorMaxMissed, sensorDefaultMissed, falseAlertsPerYear } =
    rules.silence;
  if (totals === undefined) return sensorDefaultMissed;
  const p = lossFraction(totals);
  const heartbeatsPerYear = SECONDS_PER_YEAR / (intervalMs / MILLISECONDS_PER_SECOND);
  const allowed = falseAlertsPerYear / Math.max(1, sensorsOnSite);
  for (let n = sensorMinMissed; n <= sensorMaxMissed; n++) {
    if (heartbeatsPerYear * p ** n <= allowed) return n;
  }
  return sensorMaxMissed;
}

/** True when a loss shows a poor link: above 20 % (D107). */
export function isPoorLink(rules: HubRules, totals: LossTotals | undefined): boolean {
  return totals !== undefined && lossFraction(totals) > rules.silence.poorLinkLoss;
}

/** When a sensor last heard at `from` is silent: n × I + 30 s ‡ later (D107). */
export function silentAt(rules: HubRules, from: Mono, missed: number, intervalMs: number): Mono {
  return monoAfterMs(from, missed * intervalMs + rules.silence.sensorExtraMs);
}

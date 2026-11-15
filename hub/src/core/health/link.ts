/**
 * A poor link (D107; hub-design.md section 8, "Silence"): a sensor that lost more than a fifth of
 * its packets over the last 7 days. The counts are the sensors module's own (`loss_daily`, kept
 * per day in its slice and read through its view); this applies the rule `sensors` applies at its
 * daily choice (`isPoorLink` over `lossOverDays`), which it does not keep. Pure.
 */
import type { HubRules } from "../model/rules.ts";

/** One day's counts, as `loss_daily` keeps them. */
export interface DayLoss {
  readonly received: number;
  readonly expected: number;
}

/** The `loss_daily` day of a wall time: days since 1970 (section 6). */
export function dayOf(wallMs: number): number {
  return Math.floor(wallMs / 86_400_000);
}

/**
 * Whether the loss over the `lossDays` whole days before `today` is above `poorLinkLoss` (a fifth):
 * 1 − received ÷ expected. False with no such day that expected a packet: too little to judge.
 */
export function isPoorLink(
  rules: HubRules,
  loss: ReadonlyMap<number, DayLoss>,
  today: number,
): boolean {
  let received = 0;
  let expected = 0;
  for (const [day, counts] of loss) {
    if (day >= today || day < today - rules.silence.lossDays || counts.expected <= 0) continue;
    received += counts.received;
    expected += counts.expected;
  }
  if (expected <= 0) return false;
  // In counts, not a fraction, so exactly a fifth is never taken for more by rounding.
  return expected - received > rules.silence.poorLinkLoss * expected;
}

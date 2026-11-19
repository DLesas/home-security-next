/**
 * What a packet to a sensor answering one of its packets goes with (hub-design.md section 8, "When
 * to reply", "The reply rate", "Follow"): the version it carries after a site move's switch, and
 * the rate it goes at. Shared by the replies (`handle.ts`) and the Update offers and Key changes
 * (`updates.ts`, m3-updates-design sections 5 and 7).
 */
import type { Context } from "../model/handler.ts";
import type { Arrival } from "../model/messages.ts";
import type { SensorConfigRow } from "../model/rows.ts";
import { latestMove, onSiteSettings, switchedMove } from "../site/view.ts";
import { isKnownRate } from "./radio.ts";
import { keptVersion } from "./settings.ts";
import type { SensorEntry } from "./state.ts";

export type Lora = Extract<Arrival, { path: "lora" }>;

/**
 * The version a reply carries (section 8, "Follow"): after a switch, a packet that still came
 * on the old settings is answered with the version that announced the move; otherwise the
 * current one.
 */
export function versionFor(ctx: Context, entry: SensorEntry, arrival: Lora): SensorConfigRow {
  if (
    switchedMove(ctx.view) !== undefined &&
    entry.announcing !== undefined &&
    !onSiteSettings(ctx.view, ctx.deps.rules, arrival)
  ) {
    return entry.announcing;
  }
  return entry.config;
}

/**
 * True when this packet is the sensor's first on the new settings of a switched move. The site
 * module has already seen it, and may have ended the move with it, so a move done counts too.
 */
export function isFollowing(ctx: Context, entry: SensorEntry, arrival: Arrival): boolean {
  const move = latestMove(ctx.view);
  return (
    (move?.stage === "switched" || move?.stage === "done") &&
    entry.config.moveFollowed !== move.id &&
    onSiteSettings(ctx.view, ctx.deps.rules, arrival)
  );
}

/**
 * The rate a reply goes at (section 8, "Which rate a packet goes at"): with flag bit 7, or the
 * first on a move's new settings, the rate it arrived at; otherwise the reply rate of the version
 * it names, from the last 16 kept; for one not kept, the arrival rate. An unlisted arrival rate
 * gives the sending rate.
 */
export function replyRateFor(
  entry: SensorEntry,
  named: number | undefined,
  atSendRate: boolean,
  following: boolean,
  arrival: Lora,
): number {
  const arrived = isKnownRate(arrival.dataRate) ? arrival.dataRate : entry.config.sendRate;
  if (atSendRate || following || named === undefined) return arrived;
  return keptVersion(entry.config, named)?.replyRate ?? arrived;
}

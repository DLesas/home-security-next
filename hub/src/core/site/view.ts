/**
 * Read-only selectors over the site module's slice that other modules may use (hub-design.md
 * section 2): the site's channel, rate and powers; the move's stage and target, which sensors,
 * gateways and sirens act on (D115); whether a packet arrived on the new settings; each sensor's
 * follow and silence grace. It is also the one place that reads the Reply's two next-setting
 * fields and Siren settings' site channel from `@hsn/protocol` (model/settings.ts maps them).
 */
import {
  dataRatesInMask,
  type MessageOf,
  type MessageType,
  NEXT_SETTING_UNCHANGED,
} from "@hsn/protocol";
import type { DeviceId } from "../model/ids.ts";
import type { Arrival } from "../model/messages.ts";
import { MoveStage, type MoveStageName, NEXT_SETTING_STAYS, type SiteRow } from "../model/rows.ts";
import type { HubRules } from "../model/rules.ts";
import { PACKAGE_SETTINGS_FIELDS, type SensorSettings } from "../model/settings.ts";
import type { HubState } from "../model/state.ts";
import { type Mono, monoAfterMs } from "../model/time.ts";

/** The site's `site` row. */
export function siteRow(view: HubState): SiteRow {
  return view.site.row;
}

/** The site's one sending rate (section 8; §2): the fastest in its mask, or the default ‡. */
export function rateOfRow(row: SiteRow, rules: HubRules): number {
  return dataRatesInMask(row.rateMask).at(-1) ?? rules.site.defaultRate;
}

/**
 * The rate mask of a site with one sending rate (section 8; §6, one bit per data rate index): what
 * gateways listen for and pairing allows.
 */
export function oneRateMask(rate: number): number {
  return 1 << rate;
}

/** The site's sending rate now. */
export function siteRate(view: HubState, rules: HubRules): number {
  return rateOfRow(view.site.row, rules);
}

/** A move, as the other modules see it. */
export interface MoveView {
  readonly id: number;
  readonly stage: MoveStageName;
  /** The target channel, or undefined when it stays. */
  readonly channel: number | undefined;
  /** The target rate, or undefined when it stays. */
  readonly rate: number | undefined;
  readonly forced: boolean;
}

const STAGE_NAMES: Readonly<Record<number, MoveStageName>> = {
  [MoveStage.Announcing]: "announcing",
  [MoveStage.Switched]: "switched",
  [MoveStage.Done]: "done",
  [MoveStage.Cancelled]: "cancelled",
};

/** The `site.move_channel` or `move_rate` value as a target: undefined when it stays. */
function target(value: number | null): number | undefined {
  return value === null || value === NEXT_SETTING_STAYS ? undefined : value;
}

/** The latest move a `site` row holds, or undefined before the first. */
export function moveOfRow(row: SiteRow): MoveView | undefined {
  const stage = STAGE_NAMES[row.moveStage];
  if (stage === undefined || row.moveId === 0) return undefined;
  return {
    id: row.moveId,
    stage,
    channel: target(row.moveChannel),
    rate: target(row.moveRate),
    forced: row.moveForced,
  };
}

/** The latest move, or undefined before the first. */
export function latestMove(view: HubState): MoveView | undefined {
  return moveOfRow(view.site.row);
}

/** The move whose next settings a new sensor version announces: one that is announcing. */
export function announcingMove(view: HubState): MoveView | undefined {
  const move = latestMove(view);
  return move?.stage === "announcing" ? move : undefined;
}

/** The move after its switch and before it is done, when packets may still come on the old settings. */
export function switchedMove(view: HubState): MoveView | undefined {
  const move = latestMove(view);
  return move?.stage === "switched" ? move : undefined;
}

/**
 * True when a packet arrived on the site's current channel and rate, as the forwarded packet
 * names them (§6): after a switch, on the new settings (section 8, "Follow").
 */
export function onSiteSettings(view: HubState, rules: HubRules, arrival: Arrival): boolean {
  if (arrival.path !== "lora") return false;
  const row = view.site.row;
  return (
    arrival.dataRate === rateOfRow(row, rules) &&
    (row.channel === null || arrival.siteChannel === row.channel)
  );
}

/** True when the sensor followed the latest move. */
export function hasFollowed(view: HubState, sensor: DeviceId): boolean {
  const part = view.site.sensors.get(sensor);
  return part?.followed === view.site.row.moveId && part.followed !== 0;
}

/** True when a forced move left the sensor behind (section 8, "Force"). */
export function isLeftBehind(view: HubState, sensor: DeviceId): boolean {
  return view.site.leftBehind.has(sensor);
}

/**
 * Until when a sensor's silence alert is held back after a switch (section 8, "Silence across
 * the switch"): 4 † of its intervals from the switch, the larger of its old and new effective
 * interval; undefined when nothing is held back (no switch, or it followed).
 */
export function silenceHeldUntil(
  view: HubState,
  rules: HubRules,
  sensor: DeviceId,
  intervalAt: (rate: number) => number,
): Mono | undefined {
  const { switchedAt, before, row } = view.site;
  if (
    switchedAt === undefined ||
    hasFollowed(view, sensor) ||
    row.moveStage !== MoveStage.Switched
  ) {
    return undefined;
  }
  const newInterval = intervalAt(rateOfRow(row, rules));
  const oldInterval = before === undefined ? newInterval : intervalAt(before.rate);
  return monoAfterMs(
    switchedAt,
    rules.siteMove.silenceGraceIntervals * Math.max(oldInterval, newInterval),
  );
}

/** The Reply's fields that announce a move (§6). */
type NextSettingField = "nextSiteChannel" | "nextSendDataRate";

/**
 * The Reply's two next-setting fields for one settings version (§6, Reply; D115): the channel
 * and rate the site is moving to, `NEXT_SETTING_UNCHANGED` for one that stays; both
 * unchanged, no move announced.
 */
export function nextSettingFields(
  settings: Pick<SensorSettings, "nextChannel" | "nextRate">,
): Pick<MessageOf<typeof MessageType.Reply>, NextSettingField> {
  const { nextSiteChannel, nextSendDataRate } = PACKAGE_SETTINGS_FIELDS.reply;
  return {
    nextSiteChannel: settings[nextSiteChannel] ?? NEXT_SETTING_UNCHANGED,
    nextSendDataRate: settings[nextSendDataRate] ?? NEXT_SETTING_UNCHANGED,
  };
}

/** Siren settings' site channel field (§6, Siren settings; D115): the channel to send on. */
export function sirenSiteChannelField(
  channel: number,
): Pick<MessageOf<typeof MessageType.SirenSettings>, "siteChannel"> {
  return { siteChannel: channel };
}

/**
 * The current move's counts, as `hsn site change status` gives them (section 9): the sensors that
 * confirmed it and the sensors in all. For `app`'s `siteMoveStatus` (m2-design.md section 11,
 * "Step 1's questions"); read only.
 */
export function moveCounts(view: HubState): { readonly confirmed: number; readonly total: number } {
  const move = view.site.row.moveId;
  const parts = [...view.site.sensors.values()];
  return { confirmed: parts.filter((part) => part.confirmed === move).length, total: parts.length };
}

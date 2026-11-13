/**
 * Gateway settings (hub-design.md sections 6 and 8; protocol.md §6, Gateway settings): the
 * `gateway_config` row of each gateway, its version, and the message the hub sends after every
 * welcome, after any status that names another version, and on every change, the site move's
 * switch included (D115).
 */
import { ok, type Result } from "neverthrow";
import { MessageType, type MessageOf } from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import { type GatewayConfigRow, MoveStage, type SiteRow } from "../model/rows.ts";
import type { HubRules } from "../model/rules.ts";
import { safeDataRateMask } from "../util/protocol-safe.ts";
import { asFault } from "./common.ts";
import {
  DEFAULT_SITE_CHANNEL,
  FIRST_SETTINGS_VERSION,
  INTERFERENCE_ALERT_S,
  LAST_SETTINGS_VERSION,
  STATUS_INTERVAL_S,
} from "./constants.ts";
import type { GatewayConfig, SiteRadio } from "./state.ts";

/** The gateway settings message (§6). */
export type GatewaySettingsMessage = MessageOf<typeof MessageType.GatewaySettings>;

/** The version after `version`: 1 to 255, then 1 again (see `LAST_SETTINGS_VERSION`). */
export function nextSettingsVersion(version: number): number {
  return version >= LAST_SETTINGS_VERSION || version < FIRST_SETTINGS_VERSION
    ? FIRST_SETTINGS_VERSION
    : version + 1;
}

/** A new gateway's settings, version 1, with the site's powers (section 8, "Powers"). */
export function firstConfig(rules: HubRules, site: SiteRadio): GatewayConfig {
  return {
    version: FIRST_SETTINGS_VERSION,
    statusIntervalS: STATUS_INTERVAL_S,
    interferenceDb: rules.noise.alertDb,
    interferenceS: INTERFERENCE_ALERT_S,
    defaultPowerDbm: site.replyPowerDbm,
    sirenPowerDbm: site.sirenPowerDbm,
  };
}

/** A gateway's settings as `gateway_config` stored them (section 6). */
export function configFromRow(row: GatewayConfigRow): GatewayConfig {
  return {
    version: row.version,
    statusIntervalS: row.statusIntervalS,
    interferenceDb: row.interferenceDb,
    interferenceS: row.interferenceS,
    defaultPowerDbm: row.defaultPowerDbm,
    sirenPowerDbm: row.sirenPowerDbm,
  };
}

/** The `write` effect that stores a gateway's settings: now, with the change (section 5). */
export function configWrite(device: DeviceId, config: GatewayConfig): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "gateway_config", op: "upsert", row: { deviceId: device, ...config } },
  };
}

/** The settings message for one gateway: its own fields and the site's channel and rates. */
export function settingsMessage(config: GatewayConfig, site: SiteRadio): GatewaySettingsMessage {
  return {
    type: MessageType.GatewaySettings,
    settingsVersion: config.version,
    siteChannel: site.channel,
    listenDataRateMask: site.rateMask,
    statusIntervalSeconds: config.statusIntervalS,
    interferenceThresholdDb: config.interferenceDb,
    interferenceSeconds: config.interferenceS,
    defaultTxPowerDbm: config.defaultPowerDbm,
    sirenTxPowerDbm: config.sirenPowerDbm,
  };
}

/**
 * The site's radio from its row, or the design's defaults before it has one: the rate is
 * `rules.site.defaultRate` (DR5 ‡) and the powers `rules.powers` (22 dBm ‡).
 */
export function siteRadio(ctx: Context, row: SiteRow | undefined): Result<SiteRadio, CoreFault> {
  const { rules } = ctx.deps;
  // A move switched before this boot is already in the stored gateway settings (section 8).
  const switched = row?.moveStage === MoveStage.Switched || row?.moveStage === MoveStage.Done;
  const appliedMove = switched ? row.moveId : 0;
  const channel = row?.channel ?? DEFAULT_SITE_CHANNEL;
  if (row !== undefined) {
    return ok({
      channel,
      rateMask: row.rateMask,
      replyPowerDbm: row.replyPowerDbm,
      sirenPowerDbm: row.sirenPowerDbm,
      appliedMove,
    });
  }
  return rateMask(ctx, rules.site.defaultRate).map((mask) => ({
    channel,
    rateMask: mask,
    replyPowerDbm: rules.powers.defaultTxPowerDbm,
    sirenPowerDbm: rules.powers.sirenTxPowerDbm,
    appliedMove,
  }));
}

/** The listen mask for one sending rate: one site, one rate (§2, O14). */
export function rateMask(ctx: Context, rate: number): Result<number, CoreFault> {
  return safeDataRateMask([rate]).mapErr((error) => asFault(ctx, error));
}

/**
 * Siren settings and their versions (hub-design.md sections 5, 6 and 8; protocol.md §6, Siren
 * settings; D115): the defaults of a new siren, a change bumping the version, the packet's message,
 * the rates of recent versions, and the report pace P on LoRa alone (section 8, "Silence").
 */
import { err, type Result } from "neverthrow";
import { DataRate, MessageType, type MessageOf, spreadingFactor } from "@hsn/protocol";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { SirenConfigRow } from "../model/rows.ts";
import type { HubRules } from "../model/rules.ts";
import { PACKAGE_SETTINGS_FIELDS, type SirenSettings } from "../model/settings.ts";
import { safeTimeOnAirMs } from "../util/protocol-safe.ts";
import { MILLISECONDS_PER_SECOND } from "../model/time.ts";
import { fault } from "./out.ts";
import type { SiteRadio, VersionRates } from "./state.ts";

/** Wi-Fi report interval until settings change it: 30 s (§6, §8, D73). */
export const DEFAULT_WIFI_REPORT_S = 30;
/** LoRa check interval: 20 units of 15 s, 5 minutes (§6, §8, D73). */
export const DEFAULT_LORA_CHECK_UNITS = 20;
/** A siren's settings versions run from 1 to 255 and wrap (§6: one byte; 0 is "none yet"). */
const MAX_VERSION = 255;
/** How many recent versions' rates are kept, as for sensors (section 6). */
const HISTORY_LENGTH = 16;
/** `siren_config.version_history`: this format byte, then 3 bytes a version (section 6). */
const HISTORY_FORMAT = 1;
const HISTORY_ENTRY_BYTES = 3;

/** The version after `version`. */
export function nextVersion(version: number): number {
  return version >= MAX_VERSION ? 1 : version + 1;
}

/** A new siren's first settings, version 1, on the site's channel and rate (section 9). */
export function firstSettings(site: SiteRadio, rules: HubRules): SirenSettings {
  return {
    version: 1,
    wifiIntervalS: DEFAULT_WIFI_REPORT_S,
    loraCheckUnits: DEFAULT_LORA_CHECK_UNITS,
    // Until told otherwise a siren caps a command at 5 minutes (§6, D40).
    maxSoundS: rules.arming.autoStopS,
    sendRate: site.rate,
    commandRate: site.rate,
    siteChannel: site.channel,
  };
}

/** The settings a row holds. */
export function settingsOfRow(row: SirenConfigRow): SirenSettings {
  return {
    version: row.version,
    wifiIntervalS: row.wifiIntervalS,
    loraCheckUnits: row.loraCheckUnits,
    maxSoundS: row.maxSoundS,
    sendRate: row.sendRate,
    commandRate: row.commandRate,
    siteChannel: row.siteChannel,
  };
}

function ratesOf(settings: SirenSettings): VersionRates {
  return {
    version: settings.version,
    sendRate: settings.sendRate,
    commandRate: settings.commandRate,
  };
}

/** The history with `settings` as its newest version. */
export function withVersion(
  history: readonly VersionRates[],
  settings: SirenSettings,
): readonly VersionRates[] {
  const older = history.filter((entry) => entry.version !== settings.version);
  return [ratesOf(settings), ...older].slice(0, HISTORY_LENGTH);
}

/** `version_history`: the format byte, then version, sending and command rate of each (section 6). */
export function encodeHistory(history: readonly VersionRates[]): Uint8Array {
  return new Uint8Array([
    HISTORY_FORMAT,
    ...history.flatMap((entry) => [entry.version, entry.sendRate, entry.commandRate]),
  ]);
}

/** A saved history, or just the current version when the blob is empty or of another format. */
export function decodeHistory(bytes: Uint8Array, settings: SirenSettings): readonly VersionRates[] {
  if (bytes[0] !== HISTORY_FORMAT) return [ratesOf(settings)];
  const entries: VersionRates[] = [];
  for (let i = 1; i + HISTORY_ENTRY_BYTES <= bytes.length; i += HISTORY_ENTRY_BYTES) {
    const [version = 0, sendRate = 0, commandRate = 0] = bytes.subarray(i, i + HISTORY_ENTRY_BYTES);
    entries.push({ version, sendRate, commandRate });
  }
  return withVersion(entries, settings);
}

/** The `siren_config` row (section 6), written now with every change (section 5). */
export function configRow(
  siren: DeviceId,
  settings: SirenSettings,
  history: readonly VersionRates[],
): SirenConfigRow {
  return {
    deviceId: siren,
    version: settings.version,
    wifiIntervalS: settings.wifiIntervalS,
    loraCheckUnits: settings.loraCheckUnits,
    maxSoundS: settings.maxSoundS,
    sendRate: settings.sendRate,
    commandRate: settings.commandRate,
    siteChannel: settings.siteChannel,
    versionHistory: encodeHistory(history),
  };
}

/** The Siren settings message of a version, filled through the one field map of the model. */
export function settingsMessage(
  settings: SirenSettings,
): MessageOf<typeof MessageType.SirenSettings> {
  const field = PACKAGE_SETTINGS_FIELDS.sirenSettings;
  return {
    type: MessageType.SirenSettings,
    settingsVersion: settings[field.settingsVersion],
    wifiReportIntervalSeconds: settings[field.wifiReportIntervalSeconds],
    loraCheckIntervalUnits: settings[field.loraCheckIntervalUnits],
    maxSoundSeconds: settings[field.maxSoundSeconds],
    sendDataRate: settings[field.sendDataRate],
    commandDataRate: settings[field.commandDataRate],
    siteChannel: settings[field.siteChannel],
  };
}

/**
 * The rate a command goes at (section 8, "Which rate a packet goes at"): the command rate of the
 * version the siren last reported, and before any report that of version 1; a version no longer
 * kept gets the current one's.
 */
export function commandRateFor(
  history: readonly VersionRates[],
  settings: SirenSettings,
  reportedVersion: number | undefined,
): number {
  const held = history.find((entry) => entry.version === (reportedVersion ?? 1));
  return held?.commandRate ?? settings.commandRate;
}

/**
 * A site switch's settings (section 8, D115): the new channel and sending rate; the command rate
 * kept, but never slower than the new sending rate nor more than the steps allowed faster.
 */
export function switchedSettings(
  settings: SirenSettings,
  channel: number | undefined,
  rate: number | undefined,
  rules: HubRules,
): SirenSettings {
  const sendRate = rate ?? settings.sendRate;
  const fastest = sendRate + rules.replyRate.maxStepsFaster;
  return {
    ...settings,
    version: nextVersion(settings.version),
    siteChannel: channel ?? settings.siteChannel,
    sendRate,
    commandRate: Math.min(Math.max(settings.commandRate, sendRate), fastest),
  };
}

/**
 * P, the report pace on LoRa alone (section 8, "Silence"; §7): the larger of the report interval
 * and 200 × the airtime of a 28-byte report at the sending rate, milliseconds. A rate this version
 * does not know counts as the slowest, DR0, so silence is never judged early.
 */
export function paceMs(ctx: Context, settings: SirenSettings): Result<number, CoreFault> {
  const rules = ctx.deps.rules.sirens;
  const sf = spreadingFactor(settings.sendRate) ?? spreadingFactor(DataRate.DR0);
  if (sf === undefined) return err(fault(ctx, "no spreading factor for DR0"));
  return safeTimeOnAirMs(sf, rules.loraOnlyReportBytes)
    .mapErr((error) => fault(ctx, error))
    .map((airtime) =>
      Math.max(
        settings.wifiIntervalS * MILLISECONDS_PER_SECOND,
        rules.loraOnlyPaceAirtimes * airtime,
      ),
    );
}

/** On LoRa alone, silent after 2P + max(10 s ‡, P ÷ 10 ‡) (section 8, D52). */
export function silenceMs(pace: number, rules: HubRules): number {
  const { loraOnlySilenceMinExtraMs, loraOnlySilenceExtraFraction } = rules.sirens;
  return 2 * pace + Math.max(loraOnlySilenceMinExtraMs, pace * loraOnlySilenceExtraFraction);
}

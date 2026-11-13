/**
 * A sensor's settings and settings versions (hub-design.md sections 6 and 8; protocol.md §6,
 * Reply; D72). Every setting a reply carries is covered by the version, the armed state and the
 * clock correction included, so any change to one bumps it; a change that leaves every carried
 * setting as it was does not (the test hub's flaw of bumping every sensor, section 13). The last
 * 16 versions are kept with their reply rate and the move they announce (`version_history`).
 */
import { ArmState, NEXT_SETTING_STAYS, type SensorConfigRow } from "../model/rows.ts";
import type { SensorSettings } from "../model/settings.ts";

/** `version_history` starts with this format byte (section 6: every blob of our own layout does). */
export const VERSION_HISTORY_FORMAT = 1;
/** The last 16 versions are kept (section 6, `sensor_config.version_history`). */
export const VERSION_HISTORY_LENGTH = 16;
/** Each kept version takes 3 bytes: the version, its reply rate, the move it announces or 0. */
const ENTRY_BYTES = 3;
/** Versions run from 1 to 255 and wrap (section 8); 0 is what a sensor with none holds (§6). */
export const MAX_VERSION = 255;

/** One kept version. */
export interface VersionEntry {
  readonly version: number;
  readonly replyRate: number;
  /** The site move this version announces, 0 for none (D115). */
  readonly move: number;
}

/** The version after `version`: 1 to 255, wrapping, never 0. */
export function nextVersion(version: number): number {
  return (version % MAX_VERSION) + 1;
}

/** The kept versions, newest first; an unreadable blob keeps none. */
export function decodeHistory(blob: Uint8Array): readonly VersionEntry[] {
  if (blob[0] !== VERSION_HISTORY_FORMAT) return [];
  const entries: VersionEntry[] = [];
  for (let at = 1; at + ENTRY_BYTES <= blob.length; at += ENTRY_BYTES) {
    entries.push({ version: blob[at] ?? 0, replyRate: blob[at + 1] ?? 0, move: blob[at + 2] ?? 0 });
  }
  return entries.slice(0, VERSION_HISTORY_LENGTH);
}

/** The blob for `entries`, newest first, at most 16. */
export function encodeHistory(entries: readonly VersionEntry[]): Uint8Array {
  const kept = entries.slice(0, VERSION_HISTORY_LENGTH);
  const blob = new Uint8Array(1 + kept.length * ENTRY_BYTES);
  blob[0] = VERSION_HISTORY_FORMAT;
  kept.forEach((entry, i) => {
    blob.set([entry.version, entry.replyRate, entry.move & 0xff], 1 + i * ENTRY_BYTES);
  });
  return blob;
}

/** The kept entry for `version`, or undefined when it is not among the last 16. */
export function keptVersion(config: SensorConfigRow, version: number): VersionEntry | undefined {
  return decodeHistory(config.versionHistory).find((entry) => entry.version === version);
}

/** The settings one version carries, as the reply sends them (§6). */
export function carriedSettings(config: SensorConfigRow): SensorSettings {
  return {
    version: config.version,
    // Both waiting states count as armed for the user and send "not armed" (section 8).
    armed: config.arm === ArmState.Armed,
    countdownS: config.countdownS,
    heartbeatUnits: config.heartbeatUnits,
    linkCheckEvery: config.linkCheckEvery,
    sendRate: config.sendRate,
    replyRate: config.replyRate,
    correctionUnits: config.correctionUnits,
    nextChannel: config.nextChannel === NEXT_SETTING_STAYS ? undefined : config.nextChannel,
    nextRate: config.nextRate === NEXT_SETTING_STAYS ? undefined : config.nextRate,
  };
}

/** The `sensor_config` columns a change may set. */
export type ConfigChange = Partial<
  Pick<
    SensorConfigRow,
    | "arm"
    | "armedBoot"
    | "armedMono"
    | "countdownS"
    | "heartbeatUnits"
    | "linkCheckEvery"
    | "sendRate"
    | "replyRate"
    | "replyRateFixed"
    | "correctionUnits"
    | "correctionFixed"
    | "nextChannel"
    | "nextRate"
    | "moveConfirmed"
    | "moveFollowed"
  >
>;

/** True when two versions would carry different settings (everything but the version itself). */
function carriesOtherSettings(a: SensorConfigRow, b: SensorConfigRow): boolean {
  const x = carriedSettings(a);
  const y = carriedSettings(b);
  return (Object.keys(x) as (keyof SensorSettings)[]).some(
    (field) => field !== "version" && x[field] !== y[field],
  );
}

/**
 * `config` with `change` applied. When the change alters a carried setting, the version is
 * bumped and kept in the history with its reply rate and `move`, the site move it announces or 0
 * (D72, D115); otherwise the version stays and only the row changes.
 */
export function applyChange(
  config: SensorConfigRow,
  change: ConfigChange,
  move: number,
): { readonly config: SensorConfigRow; readonly bumped: boolean } {
  const changed: SensorConfigRow = { ...config, ...change };
  if (!carriesOtherSettings(config, changed)) {
    return { config: changed, bumped: false };
  }
  const version = nextVersion(config.version);
  const history = [
    { version, replyRate: changed.replyRate, move },
    ...decodeHistory(config.versionHistory).filter((entry) => entry.version !== version),
  ];
  return {
    config: { ...changed, version, versionHistory: encodeHistory(history) },
    bumped: true,
  };
}

/** The `next_channel`, `next_rate` pair that announces nothing (§6, D115). */
export const NO_NEXT_SETTINGS = {
  nextChannel: NEXT_SETTING_STAYS,
  nextRate: NEXT_SETTING_STAYS,
} as const;

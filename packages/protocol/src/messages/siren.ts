/** Siren command (0x90), siren report (0x10) and siren settings (0x91), section 6. */
import { flagsByte, i8, u16, u8 } from "../codec/field.ts";
import { layout } from "../codec/layout.ts";

export const SirenAction = { Off: 0, SoundAlarm: 1, Test: 2, ReportNow: 3 } as const;
export type SirenAction = (typeof SirenAction)[keyof typeof SirenAction];

/** Body of siren command: 3 bytes. Never bound, so LoRa and Wi-Fi copies are identical. */
export const sirenCommandLayout = layout([
  // A SirenAction value; check with isEnumValue. A siren ignores actions it does not know.
  ["action", u8],
  // For SoundAlarm and Test; the siren stops by itself when they run out (SR5).
  ["soundSeconds", u16],
]);

export const SirenState = { Off: 0, SoundingAlarm: 1, Testing: 2 } as const;
export type SirenState = (typeof SirenState)[keyof typeof SirenState];

export const SirenReportReason = {
  Regular: 0,
  CommandAnswer: 1,
  LoraCheck: 2,
  WifiReportFailed: 3,
} as const;
export type SirenReportReason = (typeof SirenReportReason)[keyof typeof SirenReportReason];

export const SIREN_REPORT_FLAGS = [
  "onMains",
  "cellFitted",
  "charging",
  "coverOpen",
  "wifiConnected",
] as const;

/** Body of siren report: 10 bytes. */
export const sirenReportLayout = layout([
  ["settingsVersion", u8],
  // A SirenState value; check with isEnumValue.
  ["state", u8],
  ["soundingSecondsLeft", u16],
  // Low 16 bits of the counter of the last command acted on.
  ["lastCommandCounterLow", u16],
  ["flags", flagsByte(SIREN_REPORT_FLAGS)],
  // Cell voltage as a battery byte; see batteryMillivolts.
  ["cellBatteryCode", u8],
  ["temperatureCelsius", i8],
  // A SirenReportReason value; check with isEnumValue.
  ["reason", u8],
]);

/** Body of siren settings: 8 bytes. The siren answers with a report. */
export const sirenSettingsLayout = layout([
  ["settingsVersion", u8],
  ["wifiReportIntervalSeconds", u8],
  // In units of 15 seconds; see secondsFromFifteenSecondUnits.
  ["loraCheckIntervalUnits", u8],
  // Longest a command may make it sound.
  ["maxSoundSeconds", u16],
  // A DataRate value; check with isEnumValue.
  ["sendDataRate", u8],
  // A DataRate value; check with isEnumValue.
  ["commandDataRate", u8],
  // The site channel to send on: a SiteChannel value; check with isEnumValue.
  ["siteChannel", u8],
]);

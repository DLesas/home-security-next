/** Sensor status (0x01–0x04), reply (0x81) and disarmed notice (0x82), section 6. */
import { flagsByte, i16, i8, u16, u8 } from "../codec/field.ts";
import { layout } from "../codec/layout.ts";

/** Sensor status flags, bit 0 first. */
export const SENSOR_STATUS_FLAGS = [
  "doorOpen",
  "coverOpen",
  "usbPower",
  "charging",
  "replyWanted",
  "localAlarmSounded",
  "buzzing",
  // The sensor will listen for the answer at the rate it sent at, not its reply rate.
  "listeningAtSendRate",
] as const;

/** Body of heartbeat, door changed and cover changed: 7 bytes. */
export const sensorStatusLayout = layout([
  ["settingsVersion", u8],
  ["flags", flagsByte(SENSOR_STATUS_FLAGS)],
  // Battery byte; see batteryMillivolts.
  ["batteryCode", u8],
  ["temperatureCelsius", i8],
  // Adds one on every open and close, wrapping at 256.
  ["doorChangeCount", u8],
  // Seconds since the event this packet reports; 0 for heartbeats.
  ["eventAgeSeconds", u16],
]);

export const ButtonAction = {
  ShortPress: 1,
  PairingHoldIgnoredWhileArmed: 2,
  FactoryResetHoldWhileArmed: 3,
  FactoryResetGoingAhead: 4,
} as const;
export type ButtonAction = (typeof ButtonAction)[keyof typeof ButtonAction];

/** Body of button: sensor status plus the action, 8 bytes. */
export const buttonLayout = layout([
  ...sensorStatusLayout,
  // A ButtonAction value; check with isEnumValue.
  ["buttonAction", u8],
]);

export const REPLY_FLAGS = ["armed", "countdownStarted", "updateAvailable"] as const;

/**
 * In a reply's next site channel or next sending rate: that setting stays as it is. With both
 * at this value, no move of the site is announced (section 7, D115).
 */
export const NEXT_SETTING_UNCHANGED = 0xff;

/** Body of reply: 14 bytes. Bound to the sensor packet it answers. */
export const replyLayout = layout([
  ["settingsVersion", u8],
  ["flags", flagsByte(REPLY_FLAGS)],
  // This sensor's countdown, seconds (D86).
  ["countdownSeconds", u8],
  // Seconds left, when the countdownStarted flag is set.
  ["countdownRemainingSeconds", u8],
  // In units of 15 seconds; see secondsFromFifteenSecondUnits.
  ["heartbeatIntervalUnits", u8],
  // Ask for a reply on every Nth heartbeat.
  ["linkCheckEvery", u8],
  // A DataRate value; check with isEnumValue.
  ["sendDataRate", u8],
  // A DataRate value; check with isEnumValue.
  ["replyDataRate", u8],
  // Tenths of a second after the end of the answered packet; 0 keeps the schedule.
  ["nextHeartbeatTenths", u16],
  // How much to stretch or shrink the sensor's sleep times, in units of 10 parts per million;
  // see ppmFromTenPpmUnits.
  ["clockCorrectionTenPpm", i16],
  // The channel the site is moving to: a SiteChannel value (check with isEnumValue), or
  // NEXT_SETTING_UNCHANGED.
  ["nextSiteChannel", u8],
  // The data rate the site is moving to: a DataRate value (check with isEnumValue), or
  // NEXT_SETTING_UNCHANGED.
  ["nextSendDataRate", u8],
]);

/** Disarmed notice has no body. Bound to the door report that started the countdown. */
export const disarmedNoticeLayout = layout([]);

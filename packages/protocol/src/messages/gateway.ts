/** Gateway messages, section 6: hello, welcome, settings, forwarding, transmitting, status. */
import { fixedBytes, flagsByte, i16, i8, restOfBodyBetween, u16, u32, u8 } from "../codec/field.ts";
import { layout } from "../codec/layout.ts";
import { MaxPacketLength, MIN_PACKET_LENGTH } from "../packet/header.ts";
import { firmwareVersion } from "./common.ts";

/** A radio packet carried inside a forwarded packet or transmit request: 18 to 255 bytes (section 6). */
const carriedRadioPacket = restOfBodyBetween(MIN_PACKET_LENGTH, MaxPacketLength.Radio);

/** Length of the gateway's and the hub's random values. */
export const CONNECTION_RANDOM_LENGTH = 8;

/** Body of hello: 12 bytes. */
export const helloLayout = layout([
  // New for every connection; binds the welcome.
  ["gatewayRandom", fixedBytes(CONNECTION_RANDOM_LENGTH)],
  ["firmwareVersion", firmwareVersion],
  ["settingsVersion", u8],
]);

/** Body of welcome: 8 bytes. Bound to the hello's gateway random. */
export const welcomeLayout = layout([["hubRandom", fixedBytes(CONNECTION_RANDOM_LENGTH)]]);

/** Body of gateway settings: 8 bytes. */
export const gatewaySettingsLayout = layout([
  ["settingsVersion", u8],
  // A SiteChannel value; check with isEnumValue.
  ["siteChannel", u8],
  // One bit per data rate index; see dataRateMask.
  ["listenDataRateMask", u8],
  ["statusIntervalSeconds", u8],
  // Decibels above the gateway's normal noise level.
  ["interferenceThresholdDb", u8],
  // Seconds the level must last.
  ["interferenceSeconds", u8],
  ["defaultTxPowerDbm", i8],
  ["sirenTxPowerDbm", i8],
]);

/** Body of forwarded packet: 9 bytes, then the device packet as received (18 to 255 bytes). */
export const forwardedPacketLayout = layout([
  // When the packet finished arriving, on the gateway's own microsecond clock.
  ["receivedAtMicros", u32],
  ["rssiDbm", i16],
  // Signal-to-noise ratio × 4; see snrDecibels.
  ["snrQuarterDb", i8],
  // A DataRate value; check with isEnumValue.
  ["dataRate", u8],
  // A SiteChannel value; check with isEnumValue.
  ["siteChannel", u8],
  ["packet", carriedRadioPacket],
]);

export const TransmitWhen = { AtTime: 0, AsSoonAsPossible: 1 } as const;
export type TransmitWhen = (typeof TransmitWhen)[keyof typeof TransmitWhen];

export const TransmitPriority = { Normal: 0, SirenCommand: 1 } as const;
export type TransmitPriority = (typeof TransmitPriority)[keyof typeof TransmitPriority];

/** Body of transmit request: 8 bytes, then the packet to send on 869.525 MHz (18 to 255 bytes). */
export const transmitRequestLayout = layout([
  // A TransmitWhen value; check with isEnumValue.
  ["when", u8],
  // When to send, or for AsSoonAsPossible the latest moment to start (0 for no limit).
  ["gatewayTimeMicros", u32],
  // A DataRate value; check with isEnumValue.
  ["dataRate", u8],
  ["powerDbm", i8],
  // A TransmitPriority value; check with isEnumValue. Siren commands may use the
  // kept-back airtime.
  ["priority", u8],
  ["packet", carriedRadioPacket],
]);

export const TransmitResultCode = {
  Sent: 0,
  TooLate: 1,
  NoAirtimeLeft: 2,
  RadioBusy: 3,
  NotValid: 4,
} as const;
export type TransmitResultCode = (typeof TransmitResultCode)[keyof typeof TransmitResultCode];

/** Body of transmit result: 9 bytes. */
export const transmitResultLayout = layout([
  // Counter of the transmit request it answers.
  ["requestCounter", u32],
  // A TransmitResultCode value; check with isEnumValue.
  ["result", u8],
  // Gateway clock time it was sent, microseconds.
  ["sentAtMicros", u32],
]);

export const GATEWAY_STATUS_FLAGS = ["usbConnected", "cellFitted", "onMains"] as const;

/** Body of gateway status: 16 bytes. Every dBm field is signed (section 3). */
export const gatewayStatusLayout = layout([
  ["settingsVersion", u8],
  ["uptimeSeconds", u32],
  // Airtime on 869.525 MHz in the last hour; see airtimePercent.
  ["airtimeHundredthsPercent", u16],
  ["noiseMedianDbm", i8],
  ["noiseHighestDbm", i8],
  ["normalNoiseDbm", i8],
  ["packetsReceived", u16],
  ["packetsCrcFailed", u16],
  // 0 on USB.
  ["wifiRssiDbm", i8],
  ["flags", flagsByte(GATEWAY_STATUS_FLAGS)],
]);

export const InterferenceEvent = { Ended: 0, Started: 1 } as const;
export type InterferenceEvent = (typeof InterferenceEvent)[keyof typeof InterferenceEvent];

/** Body of interference: 4 bytes. */
export const interferenceLayout = layout([
  // An InterferenceEvent value; check with isEnumValue.
  ["event", u8],
  ["noiseDbm", i8],
  ["durationSeconds", u16],
]);

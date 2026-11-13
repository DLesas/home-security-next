/**
 * The radio arithmetic the sensor rules share (hub-design.md section 8; protocol.md §2, §3, §6,
 * §7): packet lengths, time on air, the effective heartbeat interval with its floors at SF11 and
 * SF12, the event listen time, and data-rate steps. Pure; one helper per idea, used by sensors,
 * slots and site through `sensors/view.ts`.
 */
import { err, type Result } from "neverthrow";
import {
  CLEAR_HEADER_LENGTH,
  DATA_RATE_COUNT,
  DataRate,
  secondsFromFifteenSecondUnits,
  spreadingFactor,
  TAG_LENGTH,
} from "@hsn/protocol";
import type { HubError } from "../model/errors.ts";
import type { HubRules } from "../model/rules.ts";
import { MILLISECONDS_PER_SECOND } from "../model/time.ts";
import { safeTimeOnAirMs } from "../util/protocol-safe.ts";

const ORIGIN = "core/sensors/radio";

/** The type byte between the clear header and the body (§3). */
const TYPE_BYTE = 1;

/** Body of heartbeat, door changed and cover changed: 7 bytes (§3, "Sensor status"). */
export const SENSOR_STATUS_BODY_BYTES = 7;
/** Body of a reply: 14 bytes (§6, Reply, with the two next-setting fields of D115). */
export const REPLY_BODY_BYTES = 14;
/** The disarmed notice has no body (§6). */
export const DISARMED_NOTICE_BODY_BYTES = 0;

/** A whole packet's length for a body of `bodyBytes`: clear header, type, body, tag (§3). */
export function packetLength(bodyBytes: number): number {
  return CLEAR_HEADER_LENGTH + TYPE_BYTE + bodyBytes + TAG_LENGTH;
}

/** A sensor status packet: 25 bytes (§2's table). */
export const SENSOR_STATUS_PACKET_BYTES = packetLength(SENSOR_STATUS_BODY_BYTES);
/** A reply: 32 bytes (§2's table). */
export const REPLY_PACKET_BYTES = packetLength(REPLY_BODY_BYTES);
/** A disarmed notice: 18 bytes (§2's table). */
export const DISARMED_NOTICE_PACKET_BYTES = packetLength(DISARMED_NOTICE_BODY_BYTES);

/** The shortest heartbeat interval at SF11, DR1: 3 minutes, to stay inside the airtime (§7). */
export const MIN_INTERVAL_AT_SF11_MS = 3 * 60 * MILLISECONDS_PER_SECOND;
/** The shortest heartbeat interval at SF12, DR0: 5 minutes (§7). */
export const MIN_INTERVAL_AT_SF12_MS = 5 * 60 * MILLISECONDS_PER_SECOND;

/** True for a data rate the protocol lists, DR0 to DR5 (§2); an unlisted one passes through (§3). */
export function isKnownRate(rate: number): boolean {
  return Number.isInteger(rate) && rate >= 0 && rate < DATA_RATE_COUNT;
}

/** The fastest data rate (§2). */
export const FASTEST_RATE: number = DataRate.DR5;

/**
 * The heartbeat interval a sensor really keeps (section 8; §7, "Data rate"): its setting in
 * units of 15 s, at least 3 minutes at SF11 and 5 at SF12. The same rule as the firmware's
 * `heartbeat_interval`.
 */
export function effectiveIntervalMs(heartbeatUnits: number, sendRate: number): number {
  const setting = secondsFromFifteenSecondUnits(heartbeatUnits) * MILLISECONDS_PER_SECOND;
  const floor =
    sendRate === DataRate.DR0
      ? MIN_INTERVAL_AT_SF12_MS
      : sendRate === DataRate.DR1
        ? MIN_INTERVAL_AT_SF11_MS
        : 0;
  return Math.max(setting, floor);
}

/** Milliseconds a packet of `length` bytes takes at `rate` (§2), or an error for an unlisted rate. */
export function airtimeMs(rate: number, length: number): Result<number, HubError> {
  const sf = spreadingFactor(rate);
  if (sf === undefined) {
    return err({ kind: "codec", origin: ORIGIN, message: "no airtime for an unlisted rate" });
  }
  return safeTimeOnAirMs(sf, length);
}

/**
 * How long a sensor listens after an event report sent at `rate` (section 8, "When to reply"):
 * the table `EVENT_LISTEN_MS` that `HubRules` holds (§8 †). An unlisted rate has none.
 */
export function eventListenMs(rules: HubRules, rate: number): number | undefined {
  return isKnownRate(rate) ? rules.replies.eventListenMs[rate] : undefined;
}

/** `rate` moved `steps` faster (positive) or slower (negative), kept within DR0 to DR5. */
export function stepRate(rate: number, steps: number): number {
  return Math.min(FASTEST_RATE, Math.max(DataRate.DR0, rate + steps));
}

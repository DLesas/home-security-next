/**
 * What a reading says of a device's cell, cover and button (§6; HD 6, `device_state.reading`).
 * Pure.
 */
import { batteryMillivolts, decodeMessage, MessageType, Role } from "@hsn/protocol";
import type { CellReading } from "./state.ts";

/** What one packet tells the health module. */
export interface Reading {
  /** Undefined when the device reports no cell (a siren with none fitted). */
  readonly cell: CellReading | undefined;
  /** For a cover changed report: whether it shows the cover open. */
  readonly coverChanged: boolean | undefined;
  /** For a heartbeat: whether it shows the cover open (D114's check). */
  readonly heartbeatCover: boolean | undefined;
  /** For a button report: its action (§6, `ButtonAction`). */
  readonly button: number | undefined;
}

/**
 * The cell a stored reading shows, for the start: `device_state.reading` is the newest status
 * body without its type byte (a sensor status, 7 or 8 bytes, or a siren report). Decoded as a
 * heartbeat or a siren report, which every such body is a prefix of; undefined for a body that
 * does not decode or a role without one.
 */
export function readingOf(role: number, body: Uint8Array): Reading | undefined {
  const type =
    role === Role.Sensor
      ? MessageType.Heartbeat
      : role === Role.Siren
        ? MessageType.SirenReport
        : undefined;
  if (type === undefined) return undefined;
  const plaintext = new Uint8Array(body.length + 1);
  plaintext[0] = type;
  plaintext.set(body, 1);
  const decoded = decodeMessage(plaintext);
  if (!decoded.ok) return undefined;
  const message = decoded.value;
  if (message.type === MessageType.Heartbeat) {
    return {
      cell: { millivolts: batteryMillivolts(message.batteryCode), onMains: false },
      coverChanged: undefined,
      heartbeatCover: undefined,
      button: undefined,
    };
  }
  if (message.type === MessageType.SirenReport) {
    return {
      cell: message.flags.cellFitted
        ? { millivolts: batteryMillivolts(message.cellBatteryCode), onMains: message.flags.onMains }
        : undefined,
      coverChanged: undefined,
      heartbeatCover: undefined,
      button: undefined,
    };
  }
  return undefined;
}

/**
 * Read-only selectors over the sensors module's slice that other modules may use (hub-design.md
 * section 2): each sensor's settings and kept versions, whether a version carries a site move,
 * the correction a version holds, and whether a heartbeat is slotted. It also carries the
 * helpers intake, slots and site share with sensors (records, faults, timers, radio arithmetic),
 * so each idea has one definition.
 */
import type { DeviceId } from "../model/ids.ts";
import type { SensorConfigRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { effectiveIntervalMs } from "./radio.ts";
import { keptVersion } from "./settings.ts";
import type { SensorEntry } from "./state.ts";

export {
  airtimeMs,
  DISARMED_NOTICE_PACKET_BYTES,
  effectiveIntervalMs,
  eventListenMs,
  isKnownRate,
  REPLY_PACKET_BYTES,
  SENSOR_STATUS_PACKET_BYTES,
} from "./radio.ts";
export {
  clearTimer,
  decisionMessage,
  fault,
  faultOf,
  foldOut,
  orFault,
  recordMessage,
  setTimer,
} from "./records.ts";
export { carriedSettings } from "./settings.ts";
export { DEFAULT_HEARTBEAT_UNITS } from "./defaults.ts";
export { versionNamed } from "./observe.ts";

/** What sensors keeps of one sensor, or undefined for a device that is not one. */
export function sensorEntry(view: HubState, device: DeviceId): SensorEntry | undefined {
  return view.sensors.sensors.get(device);
}

/** Every sensor, in order of pairing (device id). */
export function allSensors(view: HubState): readonly SensorEntry[] {
  return [...view.sensors.sensors.values()].toSorted((a, b) => a.device - b.device);
}

/** A sensor's current settings row, or undefined. */
export function sensorConfig(view: HubState, device: DeviceId): SensorConfigRow | undefined {
  return view.sensors.sensors.get(device)?.config;
}

/** A sensor's effective heartbeat interval at its sending rate (§7), or undefined. */
export function sensorIntervalMs(view: HubState, device: DeviceId): number | undefined {
  const config = sensorConfig(view, device);
  return config === undefined
    ? undefined
    : effectiveIntervalMs(config.heartbeatUnits, config.sendRate);
}

/**
 * True when `version`, as one of the sensor's last 16 kept, announces `move` (section 8,
 * "Announce": versions wrap at 255, so the history decides, not a comparison).
 */
export function versionCarriesMove(
  view: HubState,
  device: DeviceId,
  version: number,
  move: number,
): boolean {
  const config = sensorConfig(view, device);
  if (config === undefined || move === 0) return false;
  return keptVersion(config, version)?.move === move;
}

/**
 * The clock correction `version` holds, units of 10 ppm: known for the current version only,
 * since the history keeps no correction (section 6); undefined otherwise.
 */
export function heldCorrection(
  view: HubState,
  device: DeviceId,
  version: number,
): number | undefined {
  const config = sensorConfig(view, device);
  return config?.version === version ? config.correctionUnits : undefined;
}

/**
 * True when a heartbeat with `counter` was sent in the sensor's slot: a reply that gave it a
 * slot was sent for an earlier packet, with no Started since (section 8, "Clock correction").
 */
export function isSlotted(view: HubState, device: DeviceId, counter: number): boolean {
  const from = view.sensors.sensors.get(device)?.slotFrom;
  return from !== undefined && counter > from;
}

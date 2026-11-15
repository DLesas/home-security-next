/**
 * Read-only selectors over the health module's slice that other modules may use (hub-design.md
 * section 2): the battery percentage and low-battery state for arming's confirmation (D109,
 * AL12) and for the app's snapshot and events, tamper and silence for the device screens.
 */
import type { DeviceId } from "../model/ids.ts";
import type { HubRules } from "../model/rules.ts";
import type { HubState } from "../model/state.ts";
import { batteryPercent as percentOf } from "./battery.ts";
import type { HealthSlice } from "./state.ts";

/** The slice itself, for tests. */
export function healthSlice(view: HubState): HealthSlice {
  return view.health;
}

/** A device's battery percentage from its newest reading (HB33), or null when none is known. */
export function batteryPercent(view: HubState, rules: HubRules, device: DeviceId): number | null {
  const cell = view.health.devices.get(device)?.cell;
  return cell === undefined ? null : (percentOf(rules, cell.millivolts) ?? null);
}

/** Whether a device's battery is low (HB33): raised at 10% or below, cleared above 15%. */
export function batteryLow(view: HubState, device: DeviceId): boolean {
  return view.health.devices.get(device)?.batteryLow ?? false;
}

/** Whether a device's cover is open (D9). */
export function tamperOpen(view: HubState, device: DeviceId): boolean {
  return view.health.devices.get(device)?.tamperOpen ?? false;
}

/** Whether a device was judged silent and has not been heard since (D107, D52). */
export function silent(view: HubState, device: DeviceId): boolean {
  return view.health.devices.get(device)?.silent ?? false;
}

/**
 * Whether a sensor has a poor link (D107): over the last 7 days it lost more than a fifth of its
 * packets, by the sensors module's daily counts; false for too few packets to judge, and for a
 * device that is not a sensor. Judged when the sensor is heard and at the daily `poor_link`.
 */
export function poorLink(view: HubState, device: DeviceId): boolean {
  return view.health.devices.get(device)?.poorLink ?? false;
}

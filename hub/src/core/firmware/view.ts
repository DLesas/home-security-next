/**
 * Read-only selectors over the firmware module's slice that other modules may use (hub-design.md
 * section 2; docs/m3-updates-design.md section 4, "Where it sits in the core and the shell"):
 *
 * - `offerWaiting`: `sensors` sets a reply's "update available" flag from it, and replies to a
 *   heartbeat while it is true (HD 8, "When to reply"). It is true when the hub has something new
 *   to tell the sensor: a fetch, a Bluetooth session, the go-ahead, or "discard" after a cancel.
 *   The sensor then sends an Update query, which firmware answers with the offer.
 * - `deviceUpdateOf`: the device object's `update` in `device.list`, `device.show` and the snapshot.
 * - `devicesInstalling`: a hub version switch also waits while any device is installing or on
 *   trial (`upkeep`).
 */
import { Role, UpdateAction } from "@hsn/protocol";
import type { DeviceUpdateObject } from "@hsn/protocol/app";
import type { DeviceId } from "../model/ids.ts";
import type { HubRules } from "../model/rules.ts";
import type { HubState } from "../model/state.ts";
import type { Now } from "../model/time.ts";
import { INSTALLING_STATES } from "./codes.ts";
import { decide, sessionOf, workingRole } from "./decide.ts";
import { actionOf, alreadyTold } from "./deliver.ts";
import { updateObject } from "./ops.ts";
import type { FirmwareSlice } from "./state.ts";

/** The slice itself, for tests. */
export function firmwareSlice(view: HubState): FirmwareSlice {
  return view.firmware;
}

/** Whether an offer waits for this sensor: its next reply says "update available". */
export function offerWaiting(view: HubState, rules: HubRules, now: Now, device: DeviceId): boolean {
  const slice = view.firmware;
  const entry = slice.updates.get(device);
  if (entry === undefined || workingRole(view, device) !== Role.Sensor) return false;
  if (entry.discard) return true;
  const decision = decide(slice, { view, rules, now }, device, "radio");
  const action = actionOf(decision);
  if (action === UpdateAction.Nothing || action === UpdateAction.KeepAndWait) return false;
  return !alreadyTold(entry.told, action, sessionOf(entry, now));
}

/** The device object's `update`: its state, hold and method, or null when it has none. */
export function deviceUpdateOf(view: HubState, device: DeviceId): DeviceUpdateObject | null {
  return updateObject(view.firmware.updates.get(device));
}

/** Whether any device is installing or on trial. */
export function devicesInstalling(view: HubState): boolean {
  return [...view.firmware.updates.values()].some((entry) =>
    INSTALLING_STATES.has(entry.row.state),
  );
}

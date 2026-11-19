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
 * - `sessionGrantedIn`, `sessionRetried`: what `app` does with a retry of a `firmware.bluetooth`
 *   whose kept reply is a granted session's marker (m3-updates section 5, step 1).
 */
import { Role, UpdateAction } from "@hsn/protocol";
import type { DeviceUpdateObject } from "@hsn/protocol/app";
import { type DeviceId, deviceId } from "../model/ids.ts";
import type { HubRules } from "../model/rules.ts";
import type { HubState } from "../model/state.ts";
import type { Now } from "../model/time.ts";
import { INSTALLING_STATES, type SessionGranted, sessionGrantedOf } from "./codes.ts";
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

/** Whether an update changed the device object, ignoring progress bytes and retry bookkeeping. */
export function deviceUpdateChanged(
  view: HubState,
  seen: FirmwareSlice["updates"],
  device: DeviceId,
): boolean {
  const previous = seen.get(device);
  if (previous === view.firmware.updates.get(device)) return false;
  const before = updateObject(previous);
  const after = deviceUpdateOf(view, device);
  return (
    before?.state !== after?.state ||
    before?.held !== after?.held ||
    before?.method !== after?.method
  );
}

/** Whether any device is installing or on trial. */
export function devicesInstalling(view: HubState): boolean {
  return [...view.firmware.updates.values()].some((entry) =>
    INSTALLING_STATES.has(entry.row.state),
  );
}

/** The granted session's marker an answer or a kept reply carries, or undefined for any other. */
export function sessionGrantedIn(reply: unknown): SessionGranted | undefined {
  if (typeof reply !== "object" || reply === null || !("body" in reply)) return undefined;
  return sessionGrantedOf(reply.body);
}

/**
 * A retry of a `firmware.bluetooth` whose kept reply is `kept`, for `device`: "live" while the
 * session that reply granted lives (firmware answers it with that session again), "ended" once it
 * has (answered `unavailable`: a retry never starts a session), undefined when the kept reply is no
 * granted session's (a refusal, sent again as kept). The session is the one granted if its expiry
 * is the one the marker kept: a later session for the device is another one.
 */
export function sessionRetried(
  view: HubState,
  now: Now,
  kept: unknown,
  device: number,
): "live" | "ended" | undefined {
  const granted = sessionGrantedIn(kept);
  if (granted === undefined) return undefined;
  const entry = view.firmware.updates.get(deviceId(device));
  const live =
    granted.device === device &&
    entry?.row.bleExpiresMs === granted.expiresAtMs &&
    sessionOf(entry, now) !== undefined;
  return live ? "live" : "ended";
}

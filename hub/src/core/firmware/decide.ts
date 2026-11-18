/**
 * What the hub wants of one device now (docs/m3-updates-design.md section 4, "How a rollout
 * proceeds", "Before any offer", "Before the go-ahead", "Choosing the method"): a pure function of
 * the slice, the other modules' views and the time, used both when a device's packet is answered
 * and when `sensors` asks whether an offer waits (`offerWaiting`, view.ts), so the two never
 * disagree.
 *
 * - **Presence**: a sensor heard within `heardWithinHeartbeats` of its heartbeat intervals; a siren
 *   or gateway with its own link open (Wi-Fi, or USB for a gateway).
 * - **Holds**, in the design's order: armed (sensors, D91), battery (sensors below the floor and
 *   not on USB power, UP7; sirens and gateways are on mains), a countdown, alarm or site move
 *   (D115), a key change after a restore not finished (D141); and the sticky "gateway always busy".
 * - **Turns**: in the pilots stage only the current pilot (sensor, siren, gateway in turn); in the
 *   rest, fetches `fetchesAtOnce` at a time, sensors `sensorsAtOnce` at a time installing, sirens
 *   and gateways `sirensAndGatewaysAtOnce` between them, and no gateway while a sensor is on trial.
 * - **The go-ahead** also waits for no provisioning, no hub version switch and, for a siren, for it
 *   to be off (it installs only when off, section 5).
 */
import { Role, UpdateReason } from "@hsn/protocol";
import { alarmSummary, armedForUser, countdownOrAlarmRunning, sirenShould } from "../alarm/view.ts";
import { gatewayLink, isGatewayConnected } from "../gateways/view.ts";
import { batteryPercent } from "../health/view.ts";
import { knownDevice } from "../intake/view.ts";
import type { DeviceId, LinkId } from "../model/ids.ts";
import type { HubRules } from "../model/rules.ts";
import { DeviceUpdateState, RolloutStage, UpdateHeld, UpdateMethod } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { msBetween, type Now } from "../model/time.ts";
import { deviceById, isWorking } from "../registry/view.ts";
import { usbBoards } from "../setup/view.ts";
import { latestMove } from "../site/view.ts";
import { sensorIntervalMs } from "../sensors/view.ts";
import { updateSummary } from "../upkeep/view.ts";
import { FETCHING_STATES, INSTALLING_STATES } from "./codes.ts";
import {
  type Climate,
  type DeviceEntry,
  type FirmwareSlice,
  type Rollout,
  type Seen,
  UNSEEN,
} from "./state.ts";

/** What the hub tells a device now. */
export type Decision =
  /** Action 0: discard anything held; nothing is planned for it. */
  | { readonly kind: "nothing" }
  /** Action 5: keep what it holds and wait; `held` is the hold to show, when one applies. */
  | { readonly kind: "wait"; readonly held: UpdateHeld | undefined }
  /**
   * Action 1 on `link`; action 6 on `link` for a gateway a person forced ("update now anyway");
   * 2 (join Wi-Fi), or 3 (open Bluetooth).
   */
  | { readonly kind: "fetch"; readonly via: "link" | "forced"; readonly link: LinkId }
  | { readonly kind: "fetch"; readonly via: "wifi" | "bluetooth" }
  /** Action 4: the go-ahead. */
  | { readonly kind: "install" };

/** How a packet the hub answers arrived: on one of the device's own links, or by LoRa. */
export type Where = LinkId | "radio";

export interface Facts {
  readonly view: HubState;
  readonly rules: HubRules;
  readonly now: Now;
}

/** The one rollout not ended, if any. */
export function openRollout(slice: FirmwareSlice): Rollout | undefined {
  for (const rollout of slice.rollouts.values()) {
    if (rollout.row.endedMs === null) return rollout;
  }
  return undefined;
}

/** What firmware remembers of the device's own packets. */
export function seenOf(slice: FirmwareSlice, device: DeviceId): Seen {
  return slice.seen.get(device) ?? UNSEEN;
}

/** A device's protocol role, when the registry knows it as working with this hub. */
export function workingRole(view: HubState, device: DeviceId): number | undefined {
  const row = deviceById(view, device);
  return row !== undefined && isWorking(row.state) ? row.role : undefined;
}

/** The countdown, alarm or site move running now (D115), or "quiet". */
export function climateOf(view: HubState): Climate {
  if (countdownOrAlarmRunning(view))
    return alarmSummary(view) === undefined ? "countdown" : "alarm";
  const move = latestMove(view);
  return move?.stage === "announcing" || move?.stage === "switched" ? "siteMove" : "quiet";
}

/**
 * A Bluetooth session in force for the entry: its nonce, while its life has not ended. Live up to
 * the millisecond before `ble_expires_ms` and over at it: the reply tells the phone the key is good
 * for `expiresInMs` after it is made, so `opened + life` is the first moment it is not, and the
 * expiry timer fires at exactly that moment. Every reading of the expiry (here, `firmware.bluetooth`'s
 * "another session" check, and the rebuild at boot) goes through this or the same comparison.
 */
export function sessionOf(entry: DeviceEntry, now: Now): Uint8Array | undefined {
  const { bleNonce, bleExpiresMs } = entry.row;
  return bleNonce !== null && bleExpiresMs !== null && bleExpiresMs > now.wall
    ? bleNonce
    : undefined;
}

/**
 * Present for an offer or the go-ahead: a sensor heard within its intervals (section 4); a siren or
 * gateway with its own link open.
 */
export function present(
  slice: FirmwareSlice,
  facts: Facts,
  device: DeviceId,
  role: number,
): boolean {
  const { view, rules, now } = facts;
  if (role === Role.Sensor) {
    const heardAt = knownDevice(view, device)?.heardAt;
    const interval = sensorIntervalMs(view, device);
    return (
      heardAt !== undefined &&
      interval !== undefined &&
      msBetween(heardAt, now.mono) <= rules.firmware.heardWithinHeartbeats * interval
    );
  }
  if (role === Role.Gateway) {
    return isGatewayConnected(view, device) && ownLink(slice, view, device, role) !== undefined;
  }
  return ownLink(slice, view, device, role) !== undefined;
}

/** The device's own link: a gateway's live session, a siren's (or sensor's) last Wi-Fi link. */
export function ownLink(
  slice: FirmwareSlice,
  view: HubState,
  device: DeviceId,
  role: number,
): LinkId | undefined {
  return role === Role.Gateway
    ? (gatewayLink(view, device) ?? seenOf(slice, device).link)
    : seenOf(slice, device).link;
}

/** A sensor below the battery floor, and not on USB power (UP7, P9). */
export function lowBattery(
  slice: FirmwareSlice,
  facts: Facts,
  device: DeviceId,
  role: number,
): boolean {
  if (role !== Role.Sensor || seenOf(slice, device).externalPower) return false;
  const percent = batteryPercent(facts.view, facts.rules, device);
  return percent !== null && percent < facts.rules.firmware.batteryFloorPercent;
}

/** The first hold that applies to the device now, in the design's order, or undefined. */
export function holdOf(
  slice: FirmwareSlice,
  facts: Facts,
  entry: DeviceEntry,
  role: number,
): UpdateHeld | undefined {
  const device = entry.row.deviceId;
  if (entry.row.held === UpdateHeld.GatewayBusy && !entry.forced) return UpdateHeld.GatewayBusy;
  const reported = entry.deviceHeld;
  if (
    reported !== undefined &&
    (reported.held !== UpdateHeld.Battery ||
      batteryPercent(facts.view, facts.rules, device) === reported.percent)
  ) {
    return reported.held;
  }
  if (role === Role.Sensor && armedForUser(facts.view, device)) return UpdateHeld.Armed;
  if (lowBattery(slice, facts, device, role)) return UpdateHeld.Battery;
  if (climateOf(facts.view) !== "quiet") return UpdateHeld.CountdownAlarmOrSiteMove;
  if (slice.rekey.has(device)) return UpdateHeld.KeyChange;
  return undefined;
}

/** The pilot whose turn it is: the first, by role (sensor, siren, gateway), not yet confirmed. */
export function currentPilot(
  slice: FirmwareSlice,
  view: HubState,
  rollout: Rollout,
): DeviceId | undefined {
  const order: readonly number[] = [Role.Sensor, Role.Siren, Role.Gateway];
  const place = (id: DeviceId): number => order.indexOf(workingRole(view, id) ?? 0);
  const pilots = rollout.pilots
    .filter((id) => place(id) >= 0)
    .toSorted((a, b) => place(a) - place(b) || a - b);
  return pilots.find((id) => slice.updates.get(id)?.row.state !== DeviceUpdateState.Confirmed);
}

/** May this device move on at this stage: the current pilot, or anyone once the rest has begun. */
export function hasTurn(
  slice: FirmwareSlice,
  view: HubState,
  rollout: Rollout,
  device: DeviceId,
): boolean {
  if (rollout.row.stage === RolloutStage.Rest) return true;
  if (rollout.row.stage === RolloutStage.Pilots)
    return currentPilot(slice, view, rollout) === device;
  return false;
}

/** How many of the rollout's devices are fetching and installing, besides `except`. */
export function counts(
  slice: FirmwareSlice,
  view: HubState,
  rollout: Rollout,
  except: DeviceId,
): { fetching: number; sensorsInstalling: number; othersInstalling: number } {
  let fetching = 0;
  let sensorsInstalling = 0;
  let othersInstalling = 0;
  for (const entry of slice.updates.values()) {
    const { deviceId, rolloutId, state, method } = entry.row;
    if (deviceId === except || rolloutId !== rollout.row.id) continue;
    // A phone serves a Bluetooth transfer: it takes nothing of the hub's (section 5).
    if (FETCHING_STATES.has(state) && method !== UpdateMethod.Bluetooth) fetching++;
    if (INSTALLING_STATES.has(state)) {
      if (deviceById(view, deviceId)?.role === Role.Sensor) sensorsInstalling++;
      else othersInstalling++;
    }
  }
  return { fetching, sensorsInstalling, othersInstalling };
}

/** The rollout's image is no longer in the store (removed, or dropped as damaged). */
export function imageGone(slice: FirmwareSlice, rollout: Rollout): boolean {
  return slice.images.get(rollout.row.image)?.removedMs !== null;
}

/** A hub version switch or a provisioning under way: the go-ahead waits (section 4). */
function goAheadBlocked(view: HubState): boolean {
  return (
    updateSummary(view).switching ||
    usbBoards(view).some((board) => board.exchange?.kind === "provision")
  );
}

/** Wi-Fi is worth offering to the sensor: it holds details, and Wi-Fi did not fail it this rollout. */
export function wifiWorth(slice: FirmwareSlice, entry: DeviceEntry): boolean {
  const reason = entry.row.lastReason;
  return (
    seenOf(slice, entry.row.deviceId).wifiDetails !== false &&
    reason !== UpdateReason.NoWifi &&
    reason !== UpdateReason.HubNotFound
  );
}

const wait = (held: UpdateHeld | undefined): Decision => ({ kind: "wait", held });

/** Where to fetch from, for a device that may fetch now. */
function fetchVia(
  slice: FirmwareSlice,
  facts: Facts,
  entry: DeviceEntry,
  role: number,
  where: Where,
): Decision {
  const device = entry.row.deviceId;
  if (sessionOf(entry, facts.now) !== undefined) return { kind: "fetch", via: "bluetooth" };
  // Only a gateway is ever forced, and only by `rollout.resume {device, force}` in this rollout.
  const via = role === Role.Gateway && entry.forced ? "forced" : "link";
  if (where !== "radio") return { kind: "fetch", via, link: where };
  if (role === Role.Sensor) {
    return wifiWorth(slice, entry) ? { kind: "fetch", via: "wifi" } : wait(UpdateHeld.NeedsPhone);
  }
  const link = ownLink(slice, facts.view, device, role);
  return link === undefined ? wait(undefined) : { kind: "fetch", via, link };
}

/**
 * What the hub tells the device now. `where` is how the packet being answered arrived, or "radio"
 * when nothing is being answered (a sensor is then reached in a reply by LoRa, a siren or gateway
 * on its own link).
 */
export function decide(
  slice: FirmwareSlice,
  facts: Facts,
  device: DeviceId,
  where: Where,
): Decision {
  const entry = slice.updates.get(device);
  const rollout = openRollout(slice);
  const role = workingRole(facts.view, device);
  if (entry === undefined || rollout?.row.id !== entry.row.rolloutId || role === undefined) {
    return { kind: "nothing" };
  }
  const paused = rollout.row.stage === RolloutStage.Paused;
  const onTrial = seenOf(slice, device).onTrial;
  switch (entry.row.state) {
    case DeviceUpdateState.Installing:
      return { kind: "install" };
    case DeviceUpdateState.OnTrial:
      return wait(undefined);
    case DeviceUpdateState.Planned:
    case DeviceUpdateState.Offered:
    case DeviceUpdateState.Fetching: {
      const started = entry.row.state !== DeviceUpdateState.Planned;
      const session = sessionOf(entry, facts.now) !== undefined;
      // A person asked for a Bluetooth session: it goes ahead of turns and pauses (section 5).
      if (session && !onTrial) return { kind: "fetch", via: "bluetooth" };
      // A download already under way goes on (armed or paused), but not while a countdown or an
      // alarm runs: every grant is revoked then (R12).
      // The store lost the image's file (`firmwareStoreDamaged`): nothing can be served.
      if (imageGone(slice, rollout)) return wait(undefined);
      if (started) {
        const climate = climateOf(facts.view);
        if (climate === "countdown" || climate === "alarm")
          return wait(UpdateHeld.CountdownAlarmOrSiteMove);
        // A forced download stops while the rollout is paused: it delays the gateway's replies.
        if (paused && entry.forced) return wait(undefined);
        if (entry.row.held === UpdateHeld.GatewayBusy && !entry.forced) {
          return wait(UpdateHeld.GatewayBusy);
        }
        return fetchVia(slice, facts, entry, role, where);
      }
      if (paused) return wait(undefined);
      const hold = holdOf(slice, facts, entry, role);
      if (hold !== undefined) return wait(hold);
      if (!hasTurn(slice, facts.view, rollout, device)) return wait(UpdateHeld.WaitingTurn);
      if (onTrial || !(where !== "radio" || present(slice, facts, device, role))) {
        return wait(undefined);
      }
      if (counts(slice, facts.view, rollout, device).fetching >= facts.rules.firmware.fetchesAtOnce)
        return wait(UpdateHeld.WaitingTurn);
      return fetchVia(slice, facts, entry, role, where);
    }
    case DeviceUpdateState.Verified: {
      if (paused) return wait(undefined);
      const hold = holdOf(slice, facts, entry, role);
      if (hold !== undefined && hold !== UpdateHeld.GatewayBusy) return wait(hold);
      if (!hasTurn(slice, facts.view, rollout, device) || goAheadBlocked(facts.view)) {
        return wait(UpdateHeld.WaitingTurn);
      }
      if (onTrial || !(where !== "radio" || present(slice, facts, device, role))) {
        return wait(undefined);
      }
      const now = counts(slice, facts.view, rollout, device);
      const rules = facts.rules.firmware;
      if (role === Role.Sensor && now.sensorsInstalling >= rules.sensorsAtOnce) {
        return wait(UpdateHeld.WaitingTurn);
      }
      if (role !== Role.Sensor && now.othersInstalling >= rules.sirensAndGatewaysAtOnce) {
        return wait(UpdateHeld.WaitingTurn);
      }
      // A gateway carries the sensors' trials to the hub: none installs while one is on trial.
      if (role === Role.Gateway && now.sensorsInstalling > 0) return wait(UpdateHeld.WaitingTurn);
      if (role === Role.Siren && sirenShould(facts.view, device, facts.now.mono).kind !== "off") {
        return wait(UpdateHeld.WaitingTurn);
      }
      return { kind: "install" };
    }
    case DeviceUpdateState.None:
    case DeviceUpdateState.Confirmed:
    case DeviceUpdateState.RolledBack:
    case DeviceUpdateState.Refused:
    case DeviceUpdateState.Cancelled:
      return { kind: "nothing" };
  }
}

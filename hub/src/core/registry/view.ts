/**
 * Read-only selectors over the registry module's slice that other modules may use (hub-design.md
 * section 2), with the registry's shared rules: names (section 9), roles and states (section 6),
 * firmware numbers, and the hub events that setup and control make too.
 */
import { Role } from "@hsn/protocol";
import { type DeviceId, deviceId, HUB_DEVICE } from "../model/ids.ts";
import { type DeviceRow, DeviceState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { type NameProblem, nameProblem } from "./names.ts";
import type { HubSigningIdentity } from "./state.ts";

export {
  gatewayName,
  isControlCharacter,
  MAX_NAME_LENGTH,
  NAME_PROBLEM_TEXT,
  type NameProblem,
  nameProblem,
  RETIRED_NAME_PREFIX,
} from "./names.ts";
export { type HubEventSpec, hubEventRecord } from "./records.ts";
export type { HubSigningIdentity } from "./state.ts";

/** States whose row still holds its name and address in use for a device that is there. */
const NAMED_STATES: ReadonlySet<DeviceState> = new Set([
  DeviceState.Provisioning,
  DeviceState.Paired,
  DeviceState.Contacted,
  DeviceState.LeftBehind,
]);

/** States of a device that is working with this hub: paired, and maybe heard from. */
const WORKING_STATES: ReadonlySet<DeviceState> = new Set([
  DeviceState.Paired,
  DeviceState.Contacted,
]);

/** True for a device that still has its name: not removed and not reset by its owner. */
export function isNamed(state: DeviceState): boolean {
  return NAMED_STATES.has(state);
}

/** True for a paired device, whether or not it has been heard from yet. */
export function isWorking(state: DeviceState): boolean {
  return WORKING_STATES.has(state);
}

/** Every device but the hub itself, by id. */
export function registeredDevices(view: HubState): readonly DeviceRow[] {
  return [...view.registry.devices.values()]
    .filter((row) => row.id !== HUB_DEVICE)
    .toSorted((a, b) => a.id - b.id);
}

export function deviceById(view: HubState, id: DeviceId): DeviceRow | undefined {
  return id === HUB_DEVICE ? undefined : view.registry.devices.get(id);
}

/** The device with exactly this name, retired names (`#3-front`) included; never the hub. */
export function deviceByName(view: HubState, name: string): DeviceRow | undefined {
  return registeredDevices(view).find((row) => row.name === name);
}

/** The device with this address, in any state, the hub's own row included. */
export function deviceByAddress(view: HubState, address: number): DeviceRow | undefined {
  return [...view.registry.devices.values()].find((row) => row.address === address);
}

/**
 * True when no row holds this address, in any state: an address is never given twice, so old
 * records never name two devices (section 6, unique `address`).
 */
export function addressFree(view: HubState, address: number): boolean {
  return deviceByAddress(view, address) === undefined;
}

/** The devices with this chip identifier whose state is one of `states`, newest first. */
export function devicesByChip(
  view: HubState,
  chipId: Uint8Array,
  states: ReadonlySet<DeviceState>,
): readonly DeviceRow[] {
  return registeredDevices(view)
    .filter((row) => states.has(row.state) && sameBytes(row.chipId, chipId))
    .toReversed();
}

/**
 * Why `name` may not be given to a device (the rule of `names.ts`, or `taken` by another row),
 * or undefined. `except` is the device being renamed, which may keep its own name.
 */
export function newNameProblem(
  view: HubState,
  name: string,
  except?: DeviceId,
): NameProblem | "taken" | undefined {
  const problem = nameProblem(name);
  if (problem !== undefined) return problem;
  const holder = [...view.registry.devices.values()].find((row) => row.name === name);
  return holder === undefined || holder.id === except ? undefined : "taken";
}

/** The id the next device takes. */
export function nextDeviceId(view: HubState): DeviceId {
  return deviceId(view.registry.highestId + 1);
}

/** The hub's signing public key and identity, once the shell has made them (section 9). */
export function hubSigning(view: HubState): HubSigningIdentity | undefined {
  return view.registry.hub;
}

/** Role names as the CLI uses them (§10, Set role). */
export type RoleName = "sensor" | "siren" | "gateway";

const ROLE_BY_NAME: Readonly<Record<RoleName, number>> = {
  sensor: Role.Sensor,
  siren: Role.Siren,
  gateway: Role.Gateway,
};

export function roleNumber(name: RoleName): number {
  return ROLE_BY_NAME[name];
}

/** The role's name, or undefined for a role this version does not list (§3, enumerated values). */
export function roleName(role: number): RoleName | undefined {
  switch (role) {
    case Role.Sensor:
      return "sensor";
    case Role.Siren:
      return "siren";
    case Role.Gateway:
      return "gateway";
    default:
      return undefined;
  }
}

/** `devices.state` as the control protocol names it. */
export type DeviceStateName =
  "provisioning" | "paired" | "contacted" | "reset" | "removed" | "leftBehind";

const STATE_NAMES: Readonly<Record<DeviceState, DeviceStateName>> = {
  [DeviceState.Provisioning]: "provisioning",
  [DeviceState.Paired]: "paired",
  [DeviceState.Contacted]: "contacted",
  [DeviceState.ResetByOwner]: "reset",
  [DeviceState.Removed]: "removed",
  [DeviceState.LeftBehind]: "leftBehind",
};

export function stateName(state: DeviceState): DeviceStateName {
  return STATE_NAMES[state];
}

/** A firmware version as three bytes (§3). */
export interface FirmwareVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const MAJOR_FACTOR = 65_536;
const MINOR_FACTOR = 256;

/** `devices.firmware`: major × 65,536 + minor × 256 + patch (section 6). */
export function firmwareNumber(version: FirmwareVersion): number {
  return version.major * MAJOR_FACTOR + version.minor * MINOR_FACTOR + version.patch;
}

/** "major.minor.patch" from `devices.firmware`. */
export function firmwareText(firmware: number): string {
  const major = Math.floor(firmware / MAJOR_FACTOR);
  const minor = Math.floor((firmware % MAJOR_FACTOR) / MINOR_FACTOR);
  return `${major}.${minor}.${firmware % MINOR_FACTOR}`;
}

/** Byte-for-byte equality. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * The stored codes of migration 3's tables and the names the app channel gives them
 * (docs/m3-updates-design.md section 4; `objects-v2.ts`), versions as text, bytes and numbers, and
 * the few device facts firmware reads from a Started.
 */
import {
  DEVICE_UPDATE_STATES,
  ROLLOUT_STAGES,
  UPDATE_HOLDS,
  UPDATE_METHODS,
  UPDATE_REASONS,
} from "@hsn/protocol/app";
import type { ROLLOUT_PAUSE_REASONS } from "@hsn/protocol/app";
import { Role, toHex } from "@hsn/protocol";
import { type DeviceId, deviceId } from "../model/ids.ts";
import {
  DeviceUpdateState,
  NO_CONTACT_REASON,
  PILOT_FAILED_REASON,
  ROLLED_BACK_REASON,
  type RolloutStage,
  UpdateHeld,
  type UpdateMethod,
} from "../model/rows.ts";
import type { DeviceUpdateEventReason } from "./state.ts";

/** The 128-byte image header before the image: a file's bytes are the image's and these. */
export const IMAGE_HEADER_BYTES = 128;

/**
 * ESP-IDF's reset causes (`esp_reset_reason_t`) that mean a crash: a panic, the interrupt
 * watchdog, the task watchdog, another watchdog ‡. Started carries the cause as ESP-IDF reports it
 * (§6), and a pilot that restarts by one of them in its soak pauses the rollout.
 */
export const CRASH_RESET_CAUSES: ReadonlySet<number> = new Set([4, 5, 6, 7]);

export type StateName = (typeof DEVICE_UPDATE_STATES)[number];
export type HoldName = (typeof UPDATE_HOLDS)[number];
export type MethodName = (typeof UPDATE_METHODS)[number];
export type StageName = (typeof ROLLOUT_STAGES)[number];

export function stateName(state: DeviceUpdateState): StateName {
  return DEVICE_UPDATE_STATES[state];
}

/** `held` 0 is null; 1 to 7 by name. */
export function holdName(held: UpdateHeld): HoldName | null {
  return held === UpdateHeld.No ? null : (UPDATE_HOLDS[held - 1] ?? null);
}

export function methodName(method: UpdateMethod): MethodName {
  return UPDATE_METHODS[method];
}

export function stageName(stage: RolloutStage): StageName {
  return ROLLOUT_STAGES[stage];
}

/** An Update status reason (1 to 17) or `noContact` (18) by name; undefined for none or another. */
export function reasonName(reason: number | null): DeviceUpdateEventReason | undefined {
  if (reason === null || reason < 1 || reason > NO_CONTACT_REASON) return undefined;
  return UPDATE_REASONS[reason - 1];
}

/** A paused rollout's reason by name: a device's, `noContact`, or `pilotFailed`. */
export function pausedReasonName(
  reason: number | null,
): DeviceUpdateEventReason | (typeof ROLLOUT_PAUSE_REASONS)[number] | undefined {
  if (reason === PILOT_FAILED_REASON) return "pilotFailed";
  if (reason === ROLLED_BACK_REASON) return "rolledBack";
  return reasonName(reason);
}

/** A version as three bytes (§3). */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const MAJOR = 65_536;
const MINOR = 256;

/** `devices.firmware` and `firmware_images.version`: major × 65,536 + minor × 256 + patch. */
export function versionNumber(version: Version): number {
  return version.major * MAJOR + version.minor * MINOR + version.patch;
}

export function versionOf(number: number): Version {
  return {
    major: Math.floor(number / MAJOR) % MINOR,
    minor: Math.floor(number / MINOR) % MINOR,
    patch: number % MINOR,
  };
}

export function versionText(number: number): string {
  const { major, minor, patch } = versionOf(number);
  return `${major}.${minor}.${patch}`;
}

/** "MAJOR.MINOR.PATCH" as the channel's `versionText` checks it; undefined for anything else. */
export function parseVersion(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 3) return undefined;
  const numbers = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((n) => !Number.isInteger(n) || n > 255)) return undefined;
  const [major = 0, minor = 0, patch = 0] = numbers;
  return versionNumber({ major, minor, patch });
}

export const hex = toHex;

/** The image header's roles byte (bit 1 sensor, bit 2 siren, bit 3 gateway) as role numbers. */
export function rolesOf(mask: number): readonly number[] {
  return [Role.Sensor, Role.Siren, Role.Gateway].filter((role) => (mask & (1 << role)) !== 0);
}

export function hasRole(mask: number, role: number): boolean {
  return role >= Role.Sensor && role <= Role.Gateway && (mask & (1 << role)) !== 0;
}

/** Device ids as u32 LE each, as `rollouts.devices` and `pilots` hold them. */
export function encodeIds(ids: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(ids.length * 4);
  const view = new DataView(bytes.buffer);
  ids.forEach((id, i) => {
    view.setUint32(i * 4, id, true);
  });
  return bytes;
}

export function decodeIds(bytes: Uint8Array): readonly DeviceId[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids: DeviceId[] = [];
  for (let at = 0; at + 4 <= bytes.byteLength; at += 4)
    ids.push(deviceId(view.getUint32(at, true)));
  return ids;
}

/** States in which a device is fetching, for "fetches at once". */
export const FETCHING_STATES: ReadonlySet<DeviceUpdateState> = new Set([
  DeviceUpdateState.Offered,
  DeviceUpdateState.Fetching,
]);

/** States in which a device has been given the go-ahead and not yet come back confirmed. */
export const INSTALLING_STATES: ReadonlySet<DeviceUpdateState> = new Set([
  DeviceUpdateState.Installing,
  DeviceUpdateState.OnTrial,
]);

/** States a rollout has finished with for the device, one way or another. */
export const FINAL_STATES: ReadonlySet<DeviceUpdateState> = new Set([
  DeviceUpdateState.Confirmed,
  DeviceUpdateState.RolledBack,
  DeviceUpdateState.Refused,
  DeviceUpdateState.Cancelled,
]);

/**
 * What `firmware.bluetooth`'s answer is as a change (m3-updates section 5, step 1; m2-design
 * section 5): the marker `app` records in `commands` and `people` keeps for the request's `seq`. The
 * phone's reply, with the session key, is the shell's to send (`bluetoothSession`), so this holds no
 * key and no nonce: only which device the session is for and when its life ends (`ble_expires_ms`),
 * which tells a retry of that `seq` whether the session it was given still lives.
 */
export interface SessionGranted {
  readonly session: "granted";
  readonly device: number;
  readonly expiresAtMs: number;
}

/** The marker for a session granted to `device`, ending at the wall time `expiresAtMs`. */
export function sessionGranted(device: DeviceId, expiresAtMs: number): SessionGranted {
  return { session: "granted", device, expiresAtMs };
}

/** The marker an answer's body is, read back from a kept reply's JSON; undefined for any other. */
export function sessionGrantedOf(body: unknown): SessionGranted | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const fields = body as Readonly<Record<string, unknown>>;
  const { session, device, expiresAtMs } = fields;
  return session === "granted" &&
    typeof device === "number" &&
    typeof expiresAtMs === "number" &&
    Object.keys(fields).length === 3
    ? { session, device, expiresAtMs }
    : undefined;
}

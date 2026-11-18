/**
 * The objects channel version 2 adds or extends (docs/m3-m4-plan.md: one version 2 for the three
 * designs, without per-hub names). Version 1's objects in `objects.ts` stay exactly as they are,
 * since a version 1 client parses them strictly; each object version 2 extends is a new schema
 * here, named with `V2`, and the hub sends it only on a version 2 session.
 *
 * Sources: docs/m3-design.md sections 3, 4 and 6 (`hub.info`'s addresses and port, the snapshot's
 * `backupKeyEpoch`); docs/m4-design.md section 9 (`hub.info`'s `relay`, the snapshot's `push`, the
 * relay's status, offered hub releases); docs/m3-updates-design.md section 4 (images, rollouts,
 * the device object's `update`, `deviceUpdate`). Frozen by the joint step 0; open to additions
 * until the first release (D119, QR11), so names add to it without a new version.
 */
import { z } from "zod";
import { deviceObject, hubInfo, snapshotObject } from "./objects.ts";
import { relayRole } from "../relay/frames.ts";
import { deviceRef, objectId, sha256Hex, wallMs } from "./values.ts";

// ----- Values -----

/** A firmware or hub version, `MAJOR.MINOR.PATCH`, each 0 to 255 (§3), without leading zeros. */
export const versionText = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/u,
    "MAJOR.MINOR.PATCH, each 0 to 255",
  )
  .refine((text) => text.split(".").every((part) => Number(part) <= 255), "each part 0 to 255");

/** A stored firmware image (`firmware_images.id`). */
export const imageRef = objectId;
/** A rollout (`rollouts.id`). */
export const rolloutRef = objectId;

/** An unsigned 32-bit integer: a device address (§4). */
export const u32Value = z.int().min(0).max(0xffff_ffff);

/** Lowercase hex of exactly `bytes` bytes. */
export function hexOf(bytes: number) {
  return z
    .string()
    .regex(
      new RegExp(`^[0-9a-f]{${String(bytes * 2)}}$`, "u"),
      `${String(bytes * 2)} lowercase hex digits`,
    );
}

/** An image id: the first 8 bytes of the image's SHA-256, as 16 hex digits (m3-updates-design section 3). */
export const imageIdHex = hexOf(8);

/** A 32-byte key as base64url without padding: 43 characters. */
export const key32Base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u, "32 bytes as base64url, 43 characters");

// ----- The home-network side (docs/m3-design.md section 2) -----

/** A TCP port. */
export const portValue = z.int().min(1).max(65_535);

/**
 * A home-network address the hub's certificate names, as the link code's `a=` lists them: an IPv4
 * address in dotted form or an IPv6 address without brackets. Only chooses where to try (D132).
 */
export const homeAddress = z.union([z.ipv4(), z.ipv6()]);

// ----- The relay (docs/m4-design.md sections 3, 4 and 9) -----

/** A relay's URL: `wss://` (or `ws://` for a local relay, which `relay.set` checks, RD 2). */
export const relayUrl = z
  .string()
  .max(2048)
  .regex(/^wss?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/u, "a ws:// or wss:// URL without query or fragment");

/** `relay.status` and `relay.set`'s reply (RD 9). */
export const relayStatusObject = z
  .strictObject({
    /** The relay in use: the setting, else the deployment's default; null when none (RD 2). */
    url: relayUrl.nullable(),
    /** True when `url` is the deployment's default (the setting is null). */
    isDefault: z.boolean(),
    /** `off`: no relay chosen, or the default is a placeholder (RD 2). */
    state: z.enum(["up", "down", "off"]),
    /** Since when in this state; null when it has not changed since the hub started. */
    sinceMs: wallMs.nullable(),
    /** The last failure the shell reported (`RelayDownReason`), while down. */
    lastError: z.string().max(200).optional(),
    /** The roles the relay named at its welcome; empty while not up. */
    roles: z.array(relayRole).readonly(),
  })
  .readonly();

/** A hub release a relay offered (RD 6), as `update.offers` shows it. */
export const hubReleaseOfferObject = z
  .strictObject({ version: versionText, bytes: z.int().min(1), platform: z.string().min(1) })
  .readonly();

/** The snapshot's `push` for the asking phone (RD 9): whether the hub holds a valid target. */
export const pushTargetState = z
  .strictObject({ registered: z.boolean(), valid: z.boolean() })
  .readonly();

// ----- Firmware updates (docs/m3-updates-design.md section 4) -----

/**
 * `device_updates.state`, by name, in the order of its stored codes (0 to 10). A device with no
 * row is `none`.
 */
export const DEVICE_UPDATE_STATES = [
  "none",
  "planned",
  "offered",
  "fetching",
  "verified",
  "installing",
  "onTrial",
  "confirmed",
  "rolledBack",
  "refused",
  "cancelled",
] as const;
export const deviceUpdateState = z.enum(DEVICE_UPDATE_STATES);

/**
 * `device_updates.held`, by name, in the order of its stored codes 1 to 7 (0, not held, is null):
 * armed, battery, waiting its turn, needs a phone, a countdown, alarm or site move, a gateway
 * always busy, a key change after a restore not finished.
 */
export const UPDATE_HOLDS = [
  "armed",
  "battery",
  "waitingTurn",
  "needsPhone",
  "countdownAlarmOrSiteMove",
  "gatewayBusy",
  "keyChange",
] as const;
export const updateHold = z.enum(UPDATE_HOLDS);

/** `device_updates.method`, by name, in the order of its stored codes 0 to 2. */
export const UPDATE_METHODS = ["ownLink", "joinWifi", "bluetooth"] as const;
export const updateMethod = z.enum(UPDATE_METHODS);

/**
 * Why a device's update was refused or stopped: the Update status reasons 1 to 17 (§6, m3-updates
 * section 5) by name, then the hub's own `noContact` (no Started after the go-ahead).
 */
export const UPDATE_REASONS = [
  "battery",
  "armed",
  "noWifi",
  "hubNotFound",
  "linkLost",
  "badHeader",
  "wrongHub",
  "wrongRole",
  "tooLarge",
  "badSignature",
  "hashMismatch",
  "flash",
  "imageCheck",
  "windowEnded",
  "sessionRefused",
  "onTrial",
  "radioBusy",
  "noContact",
] as const;
export const updateReason = z.enum(UPDATE_REASONS);

/** A device's update as device objects carry it (m3-updates section 4, `app`); null when none. */
export const deviceUpdateObject = z
  .strictObject({
    state: deviceUpdateState,
    held: updateHold.nullable(),
    method: updateMethod,
  })
  .readonly();

/** A device in version 2: version 1's, with its update. */
export const deviceObjectV2 = deviceObject
  .unwrap()
  .extend({ update: deviceUpdateObject.nullable() })
  .readonly();

/** The roles an image is for: 1 sensor, 2 siren, 3 gateway (§6's Role values), at least one, no repeats. */
export const imageRoles = z
  .array(z.int().min(1).max(3))
  .min(1)
  .max(3)
  .refine((roles) => new Set(roles).size === roles.length, "no role twice")
  .readonly();

/** A stored firmware image (`firmware.list`, `firmware.upload`). */
export const firmwareImageObject = z
  .strictObject({
    id: imageRef,
    imageId: imageIdHex,
    version: versionText,
    kind: z.enum(["official", "ownBuild"]),
    roles: imageRoles,
    /** The image's bytes, without the 128-byte header. */
    bytes: z.int().min(1),
    addedMs: wallMs,
  })
  .readonly();

/** A firmware release a relay offered (RD 6), as `firmware.offers` shows it. */
export const firmwareReleaseOfferObject = z
  .strictObject({ version: versionText, bytes: z.int().min(1), roles: imageRoles })
  .readonly();

/** A rollout's stage (`rollouts.stage`, codes 0 to 5). */
export const ROLLOUT_STAGES = ["pilots", "soak", "rest", "paused", "done", "cancelled"] as const;
export const rolloutStage = z.enum(ROLLOUT_STAGES);

/**
 * Why a rollout paused beyond a device's own reason (`UPDATE_REASONS`), in the order of their
 * stored codes in `rollouts.paused_reason`, 19 and 20 (m3-updates section 4, "How a rollout
 * proceeds" and "How a failed update is reported"): a pilot failed in its soak (it restarted by
 * watchdog or fatal error, or went silent), and a device rolled back (its trial failed).
 */
export const ROLLOUT_PAUSE_REASONS = ["pilotFailed", "rolledBack"] as const;

/** A paused rollout's reason: a device's (1 to 18), or one of the rollout's own (19, 20). */
export const rolloutPauseReason = updateReason.or(z.enum(ROLLOUT_PAUSE_REASONS));

/** A rollout (`rollout.start`, `rollout.status` and the other `rollout.*` replies). */
export const rolloutObject = z
  .strictObject({
    id: rolloutRef,
    image: imageRef,
    version: versionText,
    stage: rolloutStage,
    devices: z.array(deviceRef).readonly(),
    pilots: z.array(deviceRef).readonly(),
    approvedBy: z.string(),
    approvedMs: wallMs,
    soakUntilMs: wallMs.nullable(),
    paused: z
      .strictObject({
        reason: rolloutPauseReason,
        device: deviceRef.nullable(),
      })
      .readonly()
      .nullable(),
    endedMs: wallMs.nullable(),
  })
  .readonly();

/** One planned device's state in `rollout.status`. */
export const rolloutDeviceObject = z
  .strictObject({
    device: deviceRef,
    state: deviceUpdateState,
    held: updateHold.nullable(),
    method: updateMethod,
    bytes: z.int().min(0),
    of: z.int().min(0),
    lastReason: updateReason.nullable(),
  })
  .readonly();

/** `firmware.bluetooth`'s reply (m3-updates section 5, "What this gives the phone design"). */
export const bluetoothSessionObject = z
  .strictObject({
    device: deviceRef,
    address: u32Value,
    imageId: imageIdHex,
    version: versionText,
    /** The header and the image: the bytes the device pulls. */
    fileBytes: z.int().min(129),
    /** SHA-256 of those bytes. */
    sha256: sha256Hex,
    /** The session key K, 32 bytes. Never stored beyond `expiresInMs`, logged or shown. */
    sessionKey: key32Base64url,
    /** The advertising window, seconds (the offer's window byte × 10). */
    windowS: z.int().min(10).max(2550),
    expiresInMs: z.int().min(1),
    /** True when the sensor learns of the session only at its next reply. */
    needsWake: z.boolean(),
  })
  .readonly();

// ----- `hub.info` and the snapshot in version 2 -----

/** `hub.info` in version 2: version 1's, with the home addresses, the apps' port and the relay. */
export const hubInfoV2 = hubInfo
  .unwrap()
  .extend({
    /** The certificate's home-network addresses, as a link code's `a=` lists them (m3-design section 2). */
    addresses: z.array(homeAddress).readonly(),
    /** The apps' listener's port (8444 by default). */
    appsPort: portValue,
    /** The hub's relay, or null when it has none (RD 3). */
    relay: z.strictObject({ url: relayUrl }).readonly().nullable(),
  })
  .readonly();

/** The snapshot in version 2: devices with their updates, the phone's push target and backup epoch. */
export const snapshotObjectV2 = snapshotObject
  .unwrap()
  .extend({
    hub: hubInfoV2,
    devices: z.array(deviceObjectV2).readonly(),
    /** For a phone: whether the hub holds a valid push target for it (RD 9); null for other clients. */
    push: pushTargetState.nullable(),
    /** For a phone: the backup key's current epoch (m3-design section 4); null for other clients. */
    backupKeyEpoch: z.int().min(0).nullable(),
  })
  .readonly();

export type VersionText = z.infer<typeof versionText>;
export type RelayStatusObject = z.infer<typeof relayStatusObject>;
export type DeviceUpdateObject = z.infer<typeof deviceUpdateObject>;
export type DeviceObjectV2 = z.infer<typeof deviceObjectV2>;
export type FirmwareImageObject = z.infer<typeof firmwareImageObject>;
export type RolloutObject = z.infer<typeof rolloutObject>;
export type RolloutDeviceObject = z.infer<typeof rolloutDeviceObject>;
export type BluetoothSessionObject = z.infer<typeof bluetoothSessionObject>;
export type HubInfoV2 = z.infer<typeof hubInfoV2>;
export type SnapshotObjectV2 = z.infer<typeof snapshotObjectV2>;
export type DeviceUpdateState = z.infer<typeof deviceUpdateState>;
export type UpdateHold = z.infer<typeof updateHold>;
export type UpdateMethod = z.infer<typeof updateMethod>;
export type UpdateReasonName = z.infer<typeof updateReason>;
export type RolloutPauseReasonName = z.infer<typeof rolloutPauseReason>;

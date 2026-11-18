/**
 * Firmware updates and the key change after a restore (m3-updates-design.md sections 5 and 7):
 * update query (0x06), update status (0x07), update offer (0x83) and key change (0x84). All four
 * are sealed packets with their receiver's usual rules (section 4). Frozen by the joint step 0.
 */
import { fixedBytes, flagsByte, u32, u8 } from "../codec/field.ts";
import { layout } from "../codec/layout.ts";
import { KEY_LENGTH } from "../packet/header.ts";
import { firmwareVersion } from "./common.ts";

/** An image id: the first 8 bytes of the image's SHA-256 (bytes 16 to 23 of its header). */
export const IMAGE_ID_LENGTH = 8;

/** A Bluetooth session's nonce, drawn by the hub (m3-updates-design.md section 5). */
export const BLUETOOTH_NONCE_LENGTH = 8;

/** What the device holds of an image, in an update query. */
export const UpdateHolding = { Nothing: 0, Part: 1, Verified: 2 } as const;
export type UpdateHolding = (typeof UpdateHolding)[keyof typeof UpdateHolding];

/** Update query flags, bit 0 first. */
export const UPDATE_QUERY_FLAGS = [
  // The device holds Wi-Fi details (D47), so it can be offered "join Wi-Fi".
  "hasWifiDetails",
  // On USB power or mains (UP7).
  "externalPower",
] as const;

/**
 * Body of update query: 15 bytes. Sent when a reply carries "update available", and on every
 * (re)connection while the device holds part of an image. A sensor's is always answered.
 */
export const updateQueryLayout = layout([
  // Zeros for none.
  ["imageId", fixedBytes(IMAGE_ID_LENGTH)],
  // An UpdateHolding value; check with isEnumValue.
  ["held", u8],
  // Up to the last checkpoint.
  ["bytesHeld", u32],
  // Encoded as in sensor status; see batteryMillivolts.
  ["batteryCode", u8],
  ["flags", flagsByte(UPDATE_QUERY_FLAGS)],
]);

/** Update status stages. */
export const UpdateStage = {
  Fetching: 1,
  Verified: 2,
  Refused: 3,
  /** Sent just before the restart. */
  Installing: 4,
  Confirmed: 5,
  Cancelled: 6,
} as const;
export type UpdateStage = (typeof UpdateStage)[keyof typeof UpdateStage];

/**
 * Why an update stopped or waits, in update status and in a Bluetooth Done frame
 * (m3-updates-design.md section 5).
 */
export const UpdateReason = {
  None: 0,
  Battery: 1,
  Armed: 2,
  NoWifi: 3,
  HubNotFound: 4,
  LinkLost: 5,
  BadHeader: 6,
  WrongHub: 7,
  WrongRole: 8,
  TooLarge: 9,
  BadSignature: 10,
  HashMismatch: 11,
  Flash: 12,
  ImageCheck: 13,
  /** The Bluetooth window ended. */
  WindowEnded: 14,
  /** Five wrong tags in one Bluetooth window. */
  SessionRefused: 15,
  /** The running image is itself on trial, so no transfer may start. */
  OnTrial: 16,
  /** A gateway wrote no sector for its bound while transmissions always waited. */
  RadioBusy: 17,
} as const;
export type UpdateReason = (typeof UpdateReason)[keyof typeof UpdateReason];

/** Body of update status: 14 bytes. Over LoRa a device sends only stages 2 to 6. */
export const updateStatusLayout = layout([
  ["imageId", fixedBytes(IMAGE_ID_LENGTH)],
  // An UpdateStage value; check with isEnumValue.
  ["stage", u8],
  // An UpdateReason value; check with isEnumValue.
  ["reason", u8],
  ["bytesWritten", u32],
]);

/** What an update offer asks of the device. */
export const UpdateAction = {
  /** Discard anything held. */
  Nothing: 0,
  /** Fetch on the link this offer came by. */
  Fetch: 1,
  JoinWifiAndFetch: 2,
  OpenBluetooth: 3,
  /** Install the verified image now: the hub's go-ahead. */
  InstallNow: 4,
  /** Keep what you hold and wait. */
  KeepAndWait: 5,
  /**
   * Fetch on the link this offer came by, without waiting for the radio to be quiet: a gateway a
   * person chose to update although its site is always busy ("update now anyway", `rollout.resume`
   * with `force`; m3-updates-design.md section 5). Each reply it makes late is answered "too late"
   * and covered by the sensor's retry.
   */
  ForcedFetch: 6,
} as const;
export type UpdateAction = (typeof UpdateAction)[keyof typeof UpdateAction];

/**
 * Body of update offer: 25 bytes. Bound to the packet it answers for a sensor; as settings are
 * for a siren (strictly higher counter); in the session for a gateway.
 */
export const updateOfferLayout = layout([
  // An UpdateAction value; check with isEnumValue.
  ["action", u8],
  ["imageId", fixedBytes(IMAGE_ID_LENGTH)],
  // The file the device pulls: the 128-byte header and the image.
  ["fileBytes", u32],
  ["version", firmwareVersion],
  // Action 3 only, else zeros.
  ["bluetoothNonce", fixedBytes(BLUETOOTH_NONCE_LENGTH)],
  // Action 3 only, in units of 10 seconds; else 0.
  ["bluetoothWindowUnits", u8],
]);

/**
 * Body of key change: 16 bytes, the device's new key (m3-updates-design.md section 7). Sealed
 * under the old key with the answer's usual binding; to a gateway, bound to its hello's random
 * in place of the welcome. "Report again" is always meant.
 */
export const keyChangeLayout = layout([["newKey", fixedBytes(KEY_LENGTH)]]);

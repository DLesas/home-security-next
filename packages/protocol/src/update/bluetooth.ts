/**
 * Update over Bluetooth from the phone (m3-updates-design.md section 5, D138): the GATT service,
 * the session key the hub gives the phone, and the tag of the phone's Open frame.
 *
 *   K   = HKDF-SHA256(ikm = the device's 16-byte key, salt = the nonce (8 bytes),
 *                     info = "hsn-ble-update/1", a zero byte, the device address u32), 32 bytes
 *   tag = the first 16 bytes of HMAC-SHA256(K, "hsn-ble-open/1", a zero byte, the device address
 *         u32, the device random (8 bytes, from Hello), the image id (8 bytes))
 *
 * The address is written little-endian in both, as every integer of the device protocol is (§3);
 * the design does not say, and this is the frozen choice. The device key never leaves the hub's
 * shell or the device; the phone learns only K, which dies with the session.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteWriter, concatBytes, isU32 } from "../bytes.ts";
import { BLUETOOTH_NONCE_LENGTH, IMAGE_ID_LENGTH } from "../messages/update.ts";
import { KEY_LENGTH } from "../packet/header.ts";
import { fail, ok, type Result } from "../result.ts";
import { DEVICE_RANDOM_LENGTH, OPEN_TAG_LENGTH } from "./transfer.ts";

/** The update service's fixed values. UUIDs and times are provisional ‡ (S9). */
export const BLUETOOTH_UPDATE = {
  /** In the advertisement. */
  serviceUuid: "1012a7e5-5d53-44e0-9170-6c34720148a4",
  /** The phone writes, without response. */
  rxUuid: "9e848f59-78c5-4f7e-b604-38d088ceda4f",
  /** The device notifies. */
  txUuid: "0a218c6e-e0b9-4cfe-9580-e13887bcd840",
  /** The scan response's name: this, then the address as 8 lower-case hex digits. */
  namePrefix: "hsn-",
  /** The MTU the phone asks for; the device uses what is agreed. */
  requestedMtu: 517,
  sessionKeyLabel: "hsn-ble-update/1",
  openTagLabel: "hsn-ble-open/1",
  sessionKeyBytes: 32,
  /** The window an offer opens, in units of this many milliseconds (offer's byte 24). */
  windowUnitMs: 10_000,
  /** The window the hub gives ‡. */
  windowMs: 120_000,
  /** A session's life on the hub ‡. */
  sessionMs: 15 * 60_000,
  /** Wrong tags that end a window ‡. */
  maxWrongTags: 5,
  /** Bluetooth stops after this long without progress ‡. */
  idleStopMs: 30_000,
} as const;

const encoder = new TextEncoder();
const label = (text: string): Uint8Array => concatBytes(encoder.encode(text), Uint8Array.of(0));

const addressBytes = (address: number): Uint8Array => new ByteWriter().u32(address).finish();

/**
 * The session key the hub derives for the phone. A key, nonce or address of the wrong size is
 * `badValue`. Never throws.
 */
export function bluetoothSessionKey(
  deviceKey: Uint8Array,
  nonce: Uint8Array,
  address: number,
): Result<Uint8Array> {
  if (deviceKey.length !== KEY_LENGTH || nonce.length !== BLUETOOTH_NONCE_LENGTH) {
    return fail("badValue");
  }
  if (!isU32(address)) return fail("badValue");
  const info = concatBytes(label(BLUETOOTH_UPDATE.sessionKeyLabel), addressBytes(address));
  return ok(hkdf(sha256, deviceKey, nonce, info, BLUETOOTH_UPDATE.sessionKeyBytes));
}

/**
 * The tag the phone writes in Open, answering the device's Hello. A key, random, image id or
 * address of the wrong size is `badValue`. Never throws.
 */
export function bluetoothOpenTag(
  sessionKey: Uint8Array,
  address: number,
  deviceRandom: Uint8Array,
  imageId: Uint8Array,
): Result<Uint8Array> {
  if (
    sessionKey.length !== BLUETOOTH_UPDATE.sessionKeyBytes ||
    deviceRandom.length !== DEVICE_RANDOM_LENGTH ||
    imageId.length !== IMAGE_ID_LENGTH ||
    !isU32(address)
  ) {
    return fail("badValue");
  }
  const message = concatBytes(
    label(BLUETOOTH_UPDATE.openTagLabel),
    addressBytes(address),
    deviceRandom,
    imageId,
  );
  return ok(hmac(sha256, sessionKey, message).slice(0, OPEN_TAG_LENGTH));
}

/** The device's name in its scan response during an update window: `hsn-` and 8 hex digits. */
export function bluetoothUpdateName(address: number): string {
  return `${BLUETOOTH_UPDATE.namePrefix}${(address >>> 0).toString(16).padStart(8, "0")}`;
}

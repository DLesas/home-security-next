/**
 * Every refusal the three designs name for channel version 2, placed in M2's error scheme as
 * version 2 extends it (`appErrorV2`; docs/m3-m4-plan.md, "Error codes"): each is one error,
 * exactly as the hub sends it on a version 2 session. The
 * designs name refusals by short words; this table is where each word becomes a code and a
 * detail, so the hub's modules and the app's words read the same place.
 */
import type { AppErrorV2 } from "./errors-v2.ts";

type Refusals = Readonly<Record<string, AppErrorV2>>;

/**
 * `firmware.bluetooth` (m3-updates-design section 5, "What this gives the phone design"; the
 * phone's words in m3-design section 7): a hold that ends by waiting is `busy`, one a person must
 * act on is `invalid` on the body's `device`. A live session for the device is no refusal: asked
 * again, the hub answers with that session (section 5, step 1).
 */
export const FIRMWARE_BLUETOOTH_REFUSALS = {
  /** held: armed. "It is armed. Disarm it first." */
  armed: { code: "invalid", detail: { field: "device", reason: "armed" } },
  /** held: battery. "Its battery is low. Charge it first." */
  battery: { code: "invalid", detail: { field: "device", reason: "lowBattery" } },
  /** held: countdown. */
  countdown: { code: "busy", detail: { because: "countdown" } },
  /** held: alarm. */
  alarm: { code: "busy", detail: { because: "alarm" } },
  /** held: siteMove. */
  siteMove: { code: "busy", detail: { because: "siteMove" } },
  /** held: keyChange (D141): not heard under its new key since a restore. */
  keyChange: { code: "busy", detail: { because: "keyChange" } },
  notPaired: { code: "invalid", detail: { field: "device", reason: "notPaired" } },
  /** It runs an image on trial: "It is checking a new version already." */
  onTrial: { code: "busy", detail: { because: "onTrial" } },
  noImage: { code: "invalid", detail: { field: "device", reason: "noImage" } },
} as const satisfies Refusals;

/** `pair.prepare` (m3-design section 5). */
export const PAIR_PREPARE_REFUSALS = {
  pairedElsewhere: { code: "invalid", detail: { field: "identity", reason: "pairedElsewhere" } },
  alreadyOurs: { code: "invalid", detail: { field: "identity", reason: "alreadyOurs" } },
  noWifi: { code: "invalid", detail: { field: "identity", reason: "noWifi" } },
  badIdentity: { code: "invalid", detail: { field: "identity", reason: "badIdentity" } },
  provisioning: { code: "busy", detail: { because: "provisioning" } },
} as const satisfies Refusals;

/**
 * A firmware file refused when it is added (`firmware.upload`; m3-updates-design section 3, in
 * that order), and by `firmware.remove`. A fetched release ends in a `fileReady` failure instead,
 * with the same words, recorded as `firmware_file_refused`.
 */
export const FIRMWARE_FILE_REFUSALS = {
  badFile: { code: "invalid", detail: { field: "job", reason: "badFile" } },
  badSignature: { code: "invalid", detail: { field: "job", reason: "badSignature" } },
  wrongTarget: { code: "invalid", detail: { field: "job", reason: "wrongTarget" } },
  tooLarge: { code: "invalid", detail: { field: "job", reason: "tooLarge" } },
  storeFull: { code: "invalid", detail: { field: "job", reason: "storeFull" } },
  notConfirmed: { code: "invalid", detail: { field: "confirmOwn", reason: "notConfirmed" } },
} as const satisfies Refusals;

/** Offers and rollouts (m3-updates-design section 4, m4-design section 6). */
export const OFFER_AND_ROLLOUT_REFUSALS = {
  /** `update.fetch`, `firmware.fetch`: a version the relay has not offered. */
  notOffered: { code: "invalid", detail: { field: "version", reason: "unknownReference" } },
  /** `firmware.fetch`: an offered firmware over 8 MB, refused before any byte is fetched. */
  offerTooLarge: { code: "invalid", detail: { field: "version", reason: "tooLarge" } },
  /** `rollout.start` while a rollout is open. */
  rolloutOpen: { code: "busy", detail: { because: "rollout" } },
} as const satisfies Refusals;

/** `relay.set` (m4-design section 2). */
export const RELAY_SET_REFUSALS = {
  /** Not a `ws://` or `wss://` URL. */
  format: { code: "invalid", detail: { field: "url", reason: "format" } },
  /** `ws://` to an address that is not loopback or private. */
  notLocal: { code: "invalid", detail: { field: "url", reason: "notLocal" } },
} as const satisfies Refusals;

/**
 * The phone-only operations (`push.*`, `presence.set`, `backup.keyHeld`) from a client that is
 * not a phone, as `backup.key` refuses one in version 1.
 */
export const NOT_A_PHONE: AppErrorV2 = { code: "unauthorized", detail: {} };

/**
 * Channel version 2's operations (docs/m3-m4-plan.md: one version 2 for the three designs, without
 * per-hub names): version 1's table (`APP_OPS`, unchanged, which a version 1 session still uses),
 * with the rows version 2 changes and the rows it adds. Each new row cites its design:
 *
 * - docs/m3-design.md section 3: `hub.info`'s addresses and port; `pair.prepare`, `pair.finish`;
 *   `backup.key`'s new rule and `backup.keyHeld`; `site.wifi` from any client; `presence.set`.
 * - docs/m4-design.md section 9: `push.*`, `relay.*`, `update.offers`, `update.fetch`.
 * - docs/m3-updates-design.md section 4: `firmware.*`, `rollout.*`.
 *
 * Frozen by the joint step 0; open to additions until the first release (D119, QR11).
 */
import { z } from "zod";
import { pushEnvironment } from "../relay/index.ts";
import { APP_OPS, type OpRule } from "./ops.ts";
import {
  bluetoothSessionObject,
  deviceObjectV2,
  firmwareImageObject,
  firmwareReleaseOfferObject,
  hexOf,
  hubInfoV2,
  hubReleaseOfferObject,
  imageRef,
  key32Base64url,
  relayStatusObject,
  relayUrl,
  rolloutDeviceObject,
  rolloutObject,
  rolloutRef,
  snapshotObjectV2,
  versionText,
} from "./objects-v2.ts";
import { base64urlBytes, deviceNameValue, deviceRef, jobRef } from "./values.ts";

const empty = z.strictObject({}).readonly();
const ok = z.strictObject({}).readonly();

function op<B extends z.ZodType, R extends z.ZodType>(rule: OpRule, body: B, reply: R) {
  return { ...rule, body, reply } as const;
}
const C = (who: string, scope: OpRule["scope"], console = false): OpRule => ({
  change: true,
  scope,
  console,
  who,
});
const R = (who: string, scope: OpRule["scope"], console = false): OpRule => ({
  change: false,
  scope,
  console,
  who,
});

/** Lowercase hex of `min` to `max` bytes. */
function hexBetween(min: number, max: number) {
  return z
    .string()
    .regex(/^(?:[0-9a-f]{2})+$/u, "lowercase hex, whole bytes")
    .min(min * 2)
    .max(max * 2);
}

/** A setup message (§10) as hex: the 0xF1 marker and the type byte, then the body. */
const setupMessageHex = (type: number, min: number) =>
  hexBetween(min, 1024).refine(
    (hex) => hex.startsWith(`f1${type.toString(16).padStart(2, "0")}`),
    "a setup message of its type",
  );

/** The phone's push token (RD 9): APNs 64 to 200 lowercase hex ‡; FCM at most 4,096 characters ‡. */
export const PUSH_TOKEN_LIMITS = {
  apnsHexMin: 64,
  apnsHexMax: 200,
  fcmMax: 4096,
} as const;

const pushRegisterFields = {
  environment: pushEnvironment,
  /** The phone's key id for this hub: 8 random bytes as 16 hex digits (RD 5). */
  keyId: hexOf(8),
  /** The push key, 32 bytes as base64url. Never recorded: the `commands` row drops it (M2 4). */
  key: key32Base64url,
};

/** `push.register`'s body, by platform. */
export const pushRegisterBody = z.discriminatedUnion("platform", [
  z
    .strictObject({
      platform: z.literal("apns"),
      token: z
        .string()
        .regex(/^[0-9a-f]+$/u, "lowercase hex")
        .min(PUSH_TOKEN_LIMITS.apnsHexMin)
        .max(PUSH_TOKEN_LIMITS.apnsHexMax),
      ...pushRegisterFields,
    })
    .readonly(),
  z
    .strictObject({
      platform: z.literal("fcm"),
      token: z.string().regex(/^\S+$/u, "no spaces").max(PUSH_TOKEN_LIMITS.fcmMax),
      ...pushRegisterFields,
    })
    .readonly(),
]);

const imageBody = z.strictObject({ image: imageRef }).readonly();
const rolloutBody = z.strictObject({ rollout: rolloutRef }).readonly();
const jobReply = z.strictObject({ job: jobRef }).readonly();
const versionBody = z.strictObject({ version: versionText }).readonly();

/** Version 2's operations: version 1's rows, changed where version 2 changes them, and the new ones. */
export const APP_OPS_V2 = {
  ...APP_OPS,

  // ----- Changed rows -----

  "hub.info": op(APP_OPS["hub.info"], empty, hubInfoV2),
  snapshot: op(APP_OPS.snapshot, APP_OPS.snapshot.body, snapshotObjectV2),
  "device.list": op(
    APP_OPS["device.list"],
    empty,
    z.strictObject({ devices: z.array(deviceObjectV2).readonly() }).readonly(),
  ),
  "device.show": op(
    APP_OPS["device.show"],
    APP_OPS["device.show"].body,
    APP_OPS["device.show"].reply.unwrap().extend({ device: deviceObjectV2 }).readonly(),
  ),
  "device.rename": op(APP_OPS["device.rename"], APP_OPS["device.rename"].body, deviceObjectV2),
  "device.remove": op(APP_OPS["device.remove"], APP_OPS["device.remove"].body, deviceObjectV2),
  "usb.add": op(APP_OPS["usb.add"], APP_OPS["usb.add"].body, deviceObjectV2),
  /** m3-design section 5 (H1): manage system from any client, no longer console only. */
  "site.wifi": op(C("MS", "MS"), APP_OPS["site.wifi"].body, APP_OPS["site.wifi"].reply),
  /**
   * m3-design section 4 (A8): any linked phone, at any time; the reply is always the current key.
   * The hub no longer records the epoch as held when it answers (`backup.keyHeld` does).
   */
  "backup.key": op(
    R("a linked phone (kind phone), at any time", "own"),
    empty,
    APP_OPS["backup.key"].reply,
  ),

  // ----- The phone design (m3-design sections 3 to 6) -----

  /** After the phone has written the key: records `epoch` as held; any other epoch is `invalid {field: "epoch", reason: "range"}`. */
  "backup.keyHeld": op(
    C("the phone itself", "own"),
    z.strictObject({ epoch: z.int().min(0) }).readonly(),
    ok,
  ),
  /**
   * Pairing over Bluetooth (D133): the board's Identity message; the hub makes the device's row,
   * key and counters, written now, and answers the Provision to send. Refused `invalid` with
   * `pairedElsewhere`, `alreadyOurs`, `noWifi` or `badIdentity`; `busy {because: "provisioning"}`.
   */
  "pair.prepare": op(
    C("MS", "MS"),
    z.strictObject({ identity: setupMessageHex(0x02, 22), name: deviceNameValue }).readonly(),
    z
      .strictObject({
        device: deviceRef,
        /** The Provision setup message (§10), base64url without padding. */
        provision: base64urlBytes.min(2).max(Math.ceil((1024 * 4) / 3)),
      })
      .readonly(),
  ),
  /** The board's Provision result: paired (the device), or for refused or not valid, gone (null). */
  "pair.finish": op(
    C("MS", "MS"),
    z.strictObject({ device: deviceRef, result: setupMessageHex(0x04, 3) }).readonly(),
    z.strictObject({ device: deviceObjectV2.nullable() }).readonly(),
  ),
  /** M5: the phone left or arrived (m3-design section 6); the hub's offers are H1's rule. */
  "presence.set": op(
    C("the phone itself", "own"),
    z.strictObject({ away: z.boolean() }).readonly(),
    ok,
  ),

  // ----- The relay design (m4-design section 9) -----

  "push.register": op(
    C("the phone itself (kind phone)", "own"),
    pushRegisterBody,
    z.strictObject({ registered: z.literal(true) }).readonly(),
  ),
  "push.unregister": op(C("the phone itself", "own"), empty, ok),
  /** A test push to this phone, kind `push_test`; `sent` false when it holds no valid target. */
  "push.test": op(
    C("the phone itself", "own"),
    empty,
    z.strictObject({ sent: z.boolean() }).readonly(),
  ),
  "relay.status": op(R("MS", "MS"), empty, relayStatusObject),
  /** `null`: the deployment's default. `ws://` only to a loopback or private address (RD 2). */
  "relay.set": op(
    C("MS", "MS"),
    z.strictObject({ url: relayUrl.nullable() }).readonly(),
    relayStatusObject,
  ),
  "update.offers": op(
    R("MS", "MS"),
    empty,
    z.strictObject({ offer: hubReleaseOfferObject.nullable() }).readonly(),
  ),
  /** Fetches an offered hub release through the relay; staged as `update_staged`, as an upload is. */
  "update.fetch": op(C("MS", "MS"), versionBody, jobReply),

  // ----- The updates design (m3-updates-design section 4) -----

  "firmware.list": op(
    R("MS", "MS"),
    empty,
    z
      .strictObject({
        images: z.array(firmwareImageObject).readonly(),
        devices: z
          .array(
            z
              .strictObject({
                device: deviceRef,
                version: z.string(),
                update: deviceObjectV2.unwrap().shape.update,
              })
              .readonly(),
          )
          .readonly(),
      })
      .readonly(),
  ),
  "firmware.offers": op(
    R("MS", "MS"),
    empty,
    z.strictObject({ offers: z.array(firmwareReleaseOfferObject).readonly() }).readonly(),
  ),
  /** No `notNewer`: an older firmware may be fetched, which is how a bad release is undone. */
  "firmware.fetch": op(C("MS", "MS"), versionBody, jobReply),
  /**
   * An uploaded `.hsnf` file, or an owner's own build (`own`), which needs `confirmOwn` after the
   * console has said what it means (D35, D84); without it, `invalid {field: "confirmOwn", reason: "notConfirmed"}`.
   */
  "firmware.upload": op(
    C("MS, C", "MS", true),
    z
      .strictObject({
        job: jobRef,
        own: z.strictObject({ version: versionText }).readonly().optional(),
        confirmOwn: z.literal(true).optional(),
      })
      .readonly(),
    firmwareImageObject,
  ),
  /** An image a rollout uses is refused `invalid {field: "image", reason: "inUse", refs}`. */
  "firmware.remove": op(C("MS", "MS"), imageBody, ok),
  /** `{job}`, then the header and image as `fileChunk` events, as `backup.export`. */
  "firmware.download": op(R("MS", "MS"), imageBody, jobReply),
  "firmware.bluetooth": op(
    C("MS (the phone build; the console for the bench)", "MS"),
    z.strictObject({ device: deviceRef }).readonly(),
    bluetoothSessionObject,
  ),
  "rollout.start": op(
    C("MS", "MS"),
    z
      .strictObject({
        image: imageRef,
        devices: z
          .union([
            z.literal("all"),
            z
              .array(deviceRef)
              .min(1)
              .refine((ids) => new Set(ids).size === ids.length, "no device twice")
              .readonly(),
          ])
          .optional(),
        pilots: z
          .array(deviceRef)
          .refine((ids) => new Set(ids).size === ids.length, "no device twice")
          .readonly()
          .optional(),
      })
      .readonly(),
    rolloutObject,
  ),
  "rollout.pause": op(C("MS", "MS"), rolloutBody, rolloutObject),
  /** `force` only with `device`: a gateway held as always busy (m3-updates section 5). */
  "rollout.resume": op(
    C("MS", "MS"),
    z
      .strictObject({
        rollout: rolloutRef,
        device: deviceRef.optional(),
        force: z.literal(true).optional(),
      })
      .refine((body) => body.force === undefined || body.device !== undefined, {
        message: "force names a device",
        path: ["force"],
      })
      .readonly(),
    rolloutObject,
  ),
  "rollout.cancel": op(C("MS", "MS"), rolloutBody, rolloutObject),
  "rollout.status": op(
    R("MS", "MS"),
    empty,
    z
      .strictObject({
        rollout: rolloutObject.nullable(),
        devices: z.array(rolloutDeviceObject).readonly(),
      })
      .readonly(),
  ),
} as const;

/** Every operation's name in version 2: version 1's and the new ones. */
export type AppOpNameV2 = keyof typeof APP_OPS_V2;
export const APP_OP_NAMES_V2 = Object.keys(APP_OPS_V2) as readonly AppOpNameV2[];

/** The operations version 2 adds, in the order above. */
export const NEW_OPS_V2 = APP_OP_NAMES_V2.filter((name) => !Object.hasOwn(APP_OPS, name));

/** One operation's body in version 2, by name. */
export type AppOpBodyV2<N extends AppOpNameV2> = z.infer<(typeof APP_OPS_V2)[N]["body"]>;
/** One operation's successful reply body in version 2, by name. */
export type AppOpReplyV2<N extends AppOpNameV2> = z.infer<(typeof APP_OPS_V2)[N]["reply"]>;

/**
 * An operation and its body as the core sees it, in either version: one variant per row of
 * version 2's table. Every version 1 body is the same schema in version 2, so a version 1 `AppOp`
 * is one of these.
 */
export type AppOpV2 = {
  readonly [N in AppOpNameV2]: { readonly op: N; readonly body: AppOpBodyV2<N> };
}[AppOpNameV2];

/**
 * The body fields never recorded (m2-design.md section 4: `commands.args` keeps a request's body
 * "secrets left out"): a module that records a request's body puts its own placeholder in each of
 * these, of the operations of either version that carry one. `site.wifi`'s password, and
 * `push.register`'s push key (RD 5); the key id and token are not secrets and are kept.
 */
export const UNRECORDED_BODY_FIELDS = {
  "site.wifi": ["password"],
  "push.register": ["key"],
} as const satisfies {
  readonly [N in AppOpNameV2]?: readonly (keyof AppOpBodyV2<N> & string)[];
};

/**
 * Push (docs/m4-design.md section 5): what a push says (`PushContent`), the sealed string `h`
 * that carries it to the phone, the targets the hub gives the relay, and the outcomes the push
 * service reports. This design owns the format; the phone design's extension and service read it
 * (m3-design section 6) against the vectors `vectors/relay-push.json`.
 *
 *   h      = "1." keyId (16 hex) "." base64url( nonce (12 bytes) ‖ ChaCha20-Poly1305(key, nonce, aad, padded) )
 *   aad    = the ASCII bytes "hsn-push/1", a zero byte, the key id (8 bytes)
 *   padded = the UTF-8 JSON of PushContent, a byte 0x80, then zero bytes up to 1,280 bytes ‡
 *
 * Every push is 1,280 bytes of plaintext, so every `h` is 1,763 characters. Sealing and opening
 * are B1's (`PushSealer`, `PushOpener`); the schemas and the format are frozen here.
 */
import { z } from "zod";
import { notificationCategory } from "../app/objects.ts";
import { deviceRef, recordSeqValue, wallMs } from "../app/values.ts";
import { IDENTITY_TEXT } from "./phone-path.ts";

/** Where a phone's push token is from (section 5): Apple's service or Google's. */
export const pushPlatform = z.enum(["apns", "fcm"]);
export type PushPlatform = z.infer<typeof pushPlatform>;

/** Which APNs environment the token belongs to (FCM tokens say `production`). */
export const pushEnvironment = z.enum(["production", "development"]);
export type PushEnvironment = z.infer<typeof pushEnvironment>;

/** A push token's bounds by platform ‡ (section 9, `push.register`). */
export const PUSH_TOKEN = {
  /** An APNs device token: 64 to 200 hex digits ‡. */
  apns: { minChars: 64, maxChars: 200 },
  /** An FCM registration token: at most 4,096 characters ‡. */
  fcm: { minChars: 1, maxChars: 4096 },
} as const;

/** Whether `token` has the form `platform`'s tokens have. */
export function pushTokenFits(platform: PushPlatform, token: string): boolean {
  if (platform === "apns")
    return new RegExp(
      `^[0-9a-fA-F]{${PUSH_TOKEN.apns.minChars},${PUSH_TOKEN.apns.maxChars}}$`,
      "u",
    ).test(token);
  return (
    token.length >= PUSH_TOKEN.fcm.minChars &&
    token.length <= PUSH_TOKEN.fcm.maxChars &&
    /^[\x21-\x7e]+$/u.test(token)
  );
}

/** The `h` format's fixed values (section 5). */
export const PUSH_H = {
  /** The format's version, the first part of `h`. */
  version: "1",
  /** A push key: 32 bytes, made by the phone, given in `push.register` (D126). */
  keyBytes: 32,
  /** A key id: 8 bytes, written as 16 hex digits. */
  keyIdBytes: 8,
  /** ChaCha20-Poly1305's nonce: 12 random bytes. */
  nonceBytes: 12,
  /** The authentication tag. */
  tagBytes: 16,
  /** Every push's plaintext, padded to this many bytes ‡. */
  paddedBytes: 1280,
  /** The content's UTF-8 JSON, at most: one byte is the 0x80 mark. */
  maxContentBytes: 1279,
  /** The byte after the content; zeros follow it. */
  padMark: 0x80,
  /** The associated data's label, followed by a zero byte and the key id. */
  aadLabel: "hsn-push/1",
  /** base64url of 12 + 1,280 + 16 bytes, without padding. */
  sealedChars: 1744,
  /** "1." + 16 + "." + 1,744. */
  hChars: 1763,
} as const;

/** A key id inside JSON: 16 lowercase hex digits. */
export const pushKeyIdHex = z.string().regex(/^[0-9a-f]{16}$/u, "16 lowercase hex digits");

/** A push key inside JSON: 32 bytes as base64url without padding, 43 characters. */
export const pushKeyText = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "32 bytes, base64url");

/** `h`'s form: version, key id, sealed bytes. Whether it opens is the opener's question. */
export const pushH = z
  .string()
  .regex(
    new RegExp(`^${PUSH_H.version}\\.[0-9a-f]{16}\\.[A-Za-z0-9_-]{${PUSH_H.sealedChars}}$`, "u"),
    "a sealed push: 1.<key id>.<1,744 base64url characters>",
  );

/** The buttons a push may carry (section 5): Disarm (D76) or a presence offer's Arm away. */
export const PUSH_ACTIONS = ["disarm", "armAway"] as const;
export type PushAction = (typeof PUSH_ACTIONS)[number];

/** A name in a push: the names the hub's own rules allow, at most 64 characters (M2's `displayName`). */
const pushName = z.string().min(1).max(64);

/**
 * What a push says (section 5). Strict: a field this version does not name is refused. The
 * relay's own two alerts (`hub_unreachable`, `hub_back`, D127) carry `n.seq` 0 and `n.atMs` 0
 * ("no time"); the phone takes their time from their arrival.
 */
export const pushContent = z
  .strictObject({
    v: z.literal(1),
    /** The hub's app identity, 26 characters. */
    hub: z.string().regex(IDENTITY_TEXT, "26 characters of base32"),
    /** The notification's fields, without `read` and `delayed`. */
    n: z
      .strictObject({
        seq: recordSeqValue,
        atMs: wallMs,
        clockOk: z.boolean(),
        kind: z.string().min(1).max(64),
        category: notificationCategory,
        critical: z.boolean(),
        device: deviceRef.nullable(),
        cause: recordSeqValue.nullable(),
      })
      .readonly(),
    /** D102: sent more than 60 s after it was raised. */
    delayed: z.boolean(),
    names: z
      .strictObject({
        device: pushName.optional(),
        person: pushName.optional(),
        client: pushName.optional(),
        mode: pushName.optional(),
        schedule: pushName.optional(),
      })
      .readonly(),
    /** The values the kind's text needs. */
    detail: z
      .record(z.string().min(1).max(64), z.union([z.string(), z.number(), z.boolean()]))
      .readonly()
      .optional(),
    /** The buttons: at most one (QR12). */
    actions: z.array(z.enum(PUSH_ACTIONS)).max(1).readonly(),
    /** Any sensor armed when it was raised (D96, O15). */
    armed: z.boolean(),
  })
  .readonly();
export type PushContent = z.infer<typeof pushContent>;

/** The content's UTF-8 JSON, as it is sealed. */
export function pushContentBytes(content: PushContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(content));
}

/** Whether the content fits the padded size: the core refuses to build one that does not. */
export function pushContentFits(content: PushContent): boolean {
  return pushContentBytes(content).length <= PUSH_H.maxContentBytes;
}

/** What the push service answers for one item (section 3, `pushResult`). */
export const pushOutcome = z.enum(["accepted", "badToken", "limited", "failed"]);
export type PushOutcome = z.infer<typeof pushOutcome>;

/**
 * Envelope B's class (section 5, "If S5 fails"): defined, and used only if spike S5 shows the
 * iOS extension cannot raise a push to critical by itself. Not part of any frame until then.
 */
export const pushClass = z.enum(["critical", "ordinary"]);
export type PushClass = z.infer<typeof pushClass>;

/**
 * One phone the relay may push to (section 5): the key id that names it, its token, and the two
 * alerts the hub sealed for it in advance (D127), made again whenever the roster is sent.
 */
export const rosterTarget = z
  .strictObject({
    key: pushKeyIdHex,
    platform: pushPlatform,
    env: pushEnvironment,
    token: z.string().min(1).max(PUSH_TOKEN.fcm.maxChars),
    unreachable: pushH,
    back: pushH,
  })
  .readonly()
  .refine((target) => pushTokenFits(target.platform, target.token), {
    message: "a token of its platform's form",
    path: ["token"],
  });
export type RosterTarget = z.infer<typeof rosterTarget>;

/** A push key and its id, as the shell holds it (`PushKeys`): 32 and 8 bytes. */
export interface PushKey {
  readonly keyId: Uint8Array;
  readonly key: Uint8Array;
}

/**
 * Why sealing failed: a key or nonce of the wrong length, content `pushContent` refuses (the
 * phone would drop it, so it is never sealed), or content over 1,279 bytes.
 */
export type PushSealError = "tooLong" | "badKey" | "badNonce" | "badContent";

/** Why opening failed. */
export type PushOpenError =
  /** Not `1.<16 hex>.<1,744 base64url>`. */
  | "badFormat"
  /** No key for that key id. */
  | "unknownKey"
  /** The tag did not verify. */
  | "decryptFailed"
  /** No 0x80 mark followed only by zeros. */
  | "badPadding"
  /** Not UTF-8 JSON that `pushContent` accepts. */
  | "badContent";

export type PushResult<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Seals content for one phone (B1 implements; the hub's shell calls it). The nonce is random, 12 bytes. */
export interface PushSealer {
  seal(content: PushContent, key: PushKey, nonce: Uint8Array): PushResult<string, PushSealError>;
}

/** Opens `h` (B1 implements, for tests and the stand-ins; the phone has its own in Swift and Kotlin). */
export interface PushOpener {
  open(
    h: string,
    keyFor: (keyId: Uint8Array) => Uint8Array | undefined,
  ): PushResult<PushContent, PushOpenError>;
}

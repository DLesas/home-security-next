/**
 * The relay's links (docs/m4-design.md section 3): the XN handshake's three payloads, the JSON
 * text frames after it, and the binary frames' kinds. A hub link is `/v1/hub`; a relay link
 * (D142) is a relay's own link to the push service on `/v1/relay`, on the same frames with a
 * hub's identity named in each push item. Every schema is strict: a frame this version does not
 * name closes the link with 4400.
 *
 * Not in the first freeze: the `name.*` frames, which come with per-hub names (section 12).
 * The binary frames' codec is B1's (`RelayBinaryCodec`); their kinds and layout are frozen here.
 */
import { z } from "zod";
import { sha256Hex } from "../app/values.ts";
import { RELEASE_PLATFORMS } from "../release/manifests.ts";
import { HUB_STREAM_CLOSE_CODES, PHONE_PATHS, RELAY_LIMITS } from "./constants.ts";
import { IDENTITY_TEXT } from "./phone-path.ts";
import {
  pushEnvironment,
  pushH,
  pushKeyIdHex,
  pushOutcome,
  pushPlatform,
  PUSH_TOKEN,
  pushTokenFits,
  rosterTarget,
} from "./push.ts";

// ----- Small values -----

const u32 = z.int().min(0).max(0xffff_ffff);
/** A stream number, never reused on one link. */
export const streamNumber = z.int().min(0).max(RELAY_LIMITS.maxStream);
/** A program's version: `MAJOR.MINOR.PATCH`, as a release's manifest writes it. */
export const versionText = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u, "MAJOR.MINOR.PATCH");
/** An app identity, 26 characters (`formatIdentity`). */
export const identityText = z.string().regex(IDENTITY_TEXT, "26 characters of base32");
/** A relay link protocol version range `[min, max]`, min at most max. */
const protoRange = z
  .tuple([z.int().min(1), z.int().min(1)])
  .readonly()
  .refine(([min, max]) => min <= max, "min at most max");

/** The roles a relay program may run (section 3). */
export const RELAY_ROLES = ["relay", "push", "names", "releases"] as const;
export const relayRole = z.enum(RELAY_ROLES);

/** The platforms a hub release is made for (M2 section 9): the release manifests' list. */
export const RELEASE_PLATFORM_NAMES = RELEASE_PLATFORMS;
export const releasePlatform = z.enum(RELEASE_PLATFORM_NAMES);

/** The board a firmware release is for (m3-updates-design section 3). */
export const firmwareTarget = z.enum(["esp32s3"]);

/** A firmware release's roles: the protocol's role numbers (1 sensor, 2 siren, 3 gateway), each once. */
const firmwareRoles = z
  .array(z.int().min(1).max(3))
  .min(1)
  .max(3)
  .refine((roles) => new Set(roles).size === roles.length, "no role twice")
  .readonly();

// ----- The handshake's payloads (section 3, messages 1 to 3) -----

/** Message 1, hub → relay (`e`). On a relay link, `relay` names the relay program's version. */
export const relayHello = z.strictObject({ proto: protoRange, hub: versionText }).readonly();
export type RelayHello = z.infer<typeof relayHello>;

/** Message 1 on a relay link (D142), relay → push service. */
export const relayPeerHello = z.strictObject({ proto: protoRange, relay: versionText }).readonly();
export type RelayPeerHello = z.infer<typeof relayPeerHello>;

/** The limits a relay tells a hub in message 2, so the hub stays within them. */
export const relayWelcomeLimits = z
  .strictObject({
    maxRosterBytes: z.int().min(1),
    maxPushItemsPerFrame: z.int().min(1),
    maxReleasePieceBytes: z.int().min(1),
    maxRestartWithinMs: z.int().min(0),
  })
  .readonly();

/** Message 2, relay → hub (`e, ee`); or the socket closes with 4426 when no version is shared. */
export const relayWelcome = z
  .strictObject({
    proto: z.int().min(1),
    relay: versionText,
    roles: z
      .array(relayRole)
      .min(1)
      .refine((roles) => new Set(roles).size === roles.length, "no role twice")
      .readonly(),
    limits: relayWelcomeLimits,
  })
  .readonly();
export type RelayWelcome = z.infer<typeof relayWelcome>;

/** Message 3, hub → relay (`s, se`): empty. The relay then answers `joined`. */
export const relayJoin = z.strictObject({}).readonly();
export type RelayJoin = z.infer<typeof relayJoin>;

// ----- Releases (section 6) -----

/** `hsn-hub-<version>-<platform>.hsnr`. */
const hubReleaseFile = z
  .string()
  .regex(
    /^hsn-hub-(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})-(darwin-arm64|linux-x64|linux-arm64|windows-x64)\.hsnr$/u,
    "hsn-hub-<version>-<platform>.hsnr",
  );
/** `hsn-firmware-<version>.hsnf`. */
const firmwareReleaseFile = z
  .string()
  .regex(
    /^hsn-firmware-(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.hsnf$/u,
    "hsn-firmware-<version>.hsnf",
  );
/** Any release file's name. */
export const releaseFileName = z.union([hubReleaseFile, firmwareReleaseFile]);

/**
 * One release a relay offers (section 6): the newest hub release above `running` for the hub's
 * platform, and the newest firmware above the newest in the hub's store. Sizes are as listed; the
 * hub refuses one over its kind's cap before fetching a byte (`RELAY_LIMITS`).
 */
export const releaseOffer = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("hub"),
      version: versionText,
      platform: releasePlatform,
      file: hubReleaseFile,
      bytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      sha256: sha256Hex,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("firmware"),
      version: versionText,
      target: firmwareTarget,
      roles: firmwareRoles,
      file: firmwareReleaseFile,
      bytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      sha256: sha256Hex,
    })
    .readonly(),
]);
export type ReleaseOffer = z.infer<typeof releaseOffer>;

/** `release.check`'s body: the hub's platform, the version it runs, the newest firmware it holds. */
export const releaseCheck = z
  .strictObject({
    platform: releasePlatform,
    running: versionText,
    firmware: versionText.optional(),
  })
  .readonly();
export type ReleaseCheck = z.infer<typeof releaseCheck>;

/** Why a `release.get` was not answered with bytes. */
export const releaseErrorReason = z.enum(["notFound", "range", "limit", "unavailable"]);

/** What a `limit` frame names (D142's layer 1). */
export const limitWhat = z.enum([
  "newIdentity",
  "upgrades",
  "streams",
  "traffic",
  "pushes",
  "releases",
]);

// ----- Text frames: hub → relay -----

const ping = z.strictObject({ t: z.literal("ping"), n: u32 }).readonly();

/** A stream's close from the hub: `code` is the WebSocket close code for the phone (section 3). */
const hubClose = z
  .strictObject({
    t: z.literal("close"),
    stream: streamNumber,
    code: z
      .int()
      .refine((code) => HUB_STREAM_CLOSE_CODES.includes(code), "a hub's stream close code"),
  })
  .readonly();

/** A stream's close from the relay: the phone's own close code, or the relay's (`PHONE_CLOSE`). */
const relayClose = z
  .strictObject({ t: z.literal("close"), stream: streamNumber, code: z.int().min(1000).max(4999) })
  .readonly();

const roster = z
  .strictObject({
    t: z.literal("roster"),
    rev: z.int().min(0),
    /** The whole set, each time; the frame at most `RELAY_LIMITS.maxRosterBytes`. */
    targets: z
      .array(rosterTarget)
      .refine(
        (targets) => new Set(targets.map((target) => target.key)).size === targets.length,
        "no key id twice",
      )
      .readonly(),
  })
  .readonly();

/** A hub's push item: the outbox row's id, the phone's key id, the sealed content. */
export const hubPushItem = z
  .strictObject({ id: z.int().min(1).max(Number.MAX_SAFE_INTEGER), key: pushKeyIdHex, h: pushH })
  .readonly();

const hubPush = z
  .strictObject({
    t: z.literal("push"),
    items: z.array(hubPushItem).min(1).max(RELAY_LIMITS.maxPushItemsPerFrame).readonly(),
  })
  .readonly();

const restarting = z
  .strictObject({
    t: z.literal("restarting"),
    reason: z.enum(["update", "restore"]),
    withinMs: z.int().min(0).max(RELAY_LIMITS.maxRestartWithinMs),
  })
  .readonly();

const releaseCheckFrame = z
  .strictObject({ t: z.literal("release.check"), ...releaseCheck.unwrap().shape })
  .readonly();

const releaseGet = z
  .strictObject({
    t: z.literal("release.get"),
    /** The request's id, echoed in the kind 2 frame or `release.error`. */
    id: u32,
    file: releaseFileName,
    offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    length: z.int().min(1).max(RELAY_LIMITS.maxReleasePieceBytes),
  })
  .readonly();

/** Every text frame a hub sends its relay. */
export const hubToRelayFrame = z.discriminatedUnion("t", [
  ping,
  hubClose,
  roster,
  hubPush,
  restarting,
  releaseCheckFrame,
  releaseGet,
]);
export type HubToRelayFrame = z.infer<typeof hubToRelayFrame>;

// ----- Text frames: relay → hub -----

const joined = z.strictObject({ t: z.literal("joined"), identity: identityText }).readonly();
const pong = z.strictObject({ t: z.literal("pong"), n: u32 }).readonly();
const open = z
  .strictObject({
    t: z.literal("open"),
    stream: streamNumber,
    path: z.enum(PHONE_PATHS),
    /** The phone's pseudonym: `relay-` and 8 bytes of HMAC-SHA256 of its address, in hex (section 3). */
    peer: z.string().regex(/^relay-[0-9a-f]{16}$/u, "relay- and 16 hex digits"),
  })
  .readonly();
const rosterAck = z.strictObject({ t: z.literal("rosterAck"), rev: z.int().min(0) }).readonly();
const pushResult = z
  .strictObject({
    t: z.literal("pushResult"),
    results: z
      .array(
        z
          .strictObject({ id: z.int().min(1).max(Number.MAX_SAFE_INTEGER), outcome: pushOutcome })
          .readonly(),
      )
      .min(1)
      .max(RELAY_LIMITS.maxPushItemsPerFrame)
      .readonly(),
  })
  .readonly();
const restartingAck = z.strictObject({ t: z.literal("restartingAck") }).readonly();
const releaseOfferFrame = z
  .strictObject({
    t: z.literal("release.offer"),
    /** At most one of each kind. */
    releases: z
      .array(releaseOffer)
      .max(2)
      .refine(
        (releases) => new Set(releases.map((release) => release.kind)).size === releases.length,
        "at most one of each kind",
      )
      .readonly(),
  })
  .readonly();
const releaseError = z
  .strictObject({
    t: z.literal("release.error"),
    id: u32,
    reason: releaseErrorReason,
    retryAfterMs: z.int().min(0).optional(),
  })
  .readonly();
const limit = z
  .strictObject({ t: z.literal("limit"), what: limitWhat, retryAfterMs: z.int().min(0) })
  .readonly();

/** Every text frame a relay sends a hub (and `close` for a stream the phone or relay ended). */
export const relayToHubFrame = z.discriminatedUnion("t", [
  joined,
  pong,
  open,
  relayClose,
  rosterAck,
  pushResult,
  restartingAck,
  releaseOfferFrame,
  releaseError,
  limit,
]);
export type RelayToHubFrame = z.infer<typeof relayToHubFrame>;

// ----- The relay link (D142): a relay and the push service -----

/**
 * A relay's push item to the push service: the hub identity the relay authenticated on that
 * hub's link, and the target in the clear as the hub's roster gave it (section 3).
 */
export const relayPushItem = z
  .strictObject({
    id: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    hub: identityText,
    platform: pushPlatform,
    env: pushEnvironment,
    token: z.string().min(1).max(PUSH_TOKEN.fcm.maxChars),
    h: pushH,
  })
  .readonly()
  .refine((item) => pushTokenFits(item.platform, item.token), {
    message: "a token of its platform's form",
    path: ["token"],
  });
export type RelayPushItem = z.infer<typeof relayPushItem>;

const relayPush = z
  .strictObject({
    t: z.literal("push"),
    items: z.array(relayPushItem).min(1).max(RELAY_LIMITS.maxPushItemsPerFrame).readonly(),
  })
  .readonly();

/** Every text frame a relay sends the push service on its relay link. */
export const relayToPushFrame = z.discriminatedUnion("t", [
  ping,
  relayPush,
  releaseCheckFrame,
  releaseGet,
]);
export type RelayToPushFrame = z.infer<typeof relayToPushFrame>;

/** Every text frame the push service sends a relay; `joined` names the relay's own key's identity. */
export const pushToRelayFrame = z.discriminatedUnion("t", [
  joined,
  pong,
  pushResult,
  releaseOfferFrame,
  releaseError,
  limit,
]);
export type PushToRelayFrame = z.infer<typeof pushToRelayFrame>;

// ----- Binary frames (section 3): byte 0 is the kind -----

/** The binary frames' kinds; any other closes the link with 4400. */
export const RELAY_BINARY_KIND = {
  /** A u32 stream number, little-endian, then exactly one Noise message of a phone's connection. */
  streamData: 1,
  /** A u32 request id (`release.get`'s), little-endian, then the bytes asked, exactly `length`. */
  releasePiece: 2,
} as const;

/** The bytes before a binary frame's payload: the kind and a u32. */
export const RELAY_BINARY_HEADER_BYTES = 5;

/** A binary frame, decoded. */
export type RelayBinaryFrame =
  | {
      readonly kind: typeof RELAY_BINARY_KIND.streamData;
      readonly stream: number;
      /** One Noise message, 1 to 65,535 bytes. */
      readonly message: Uint8Array;
    }
  | {
      readonly kind: typeof RELAY_BINARY_KIND.releasePiece;
      readonly id: number;
      readonly bytes: Uint8Array;
    };

/** Why a binary frame was refused; each closes the link with 4400. */
export type RelayBinaryError =
  /** Fewer than 5 bytes. */
  | "truncated"
  /** A kind other than 1 and 2. */
  | "unknownKind"
  /** A kind 1 frame with no message, or one over 65,535 bytes. */
  | "badLength";

export type RelayFrameResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RelayBinaryError };

/** The binary frames' codec: B1 writes it, against `vectors/relay-frames.json`. Never throws. */
export interface RelayBinaryCodec {
  encode(frame: RelayBinaryFrame): RelayFrameResult<Uint8Array>;
  decode(bytes: Uint8Array): RelayFrameResult<RelayBinaryFrame>;
}

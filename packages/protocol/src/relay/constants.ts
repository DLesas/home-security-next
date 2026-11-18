/**
 * The relay's fixed values (docs/m4-design.md sections 3, 4 and 5), in one place: paths, the
 * link's versions and prologues, close codes, and every limit and time the hub, the phone and the
 * relay share. Values marked ‡ are the design's own provisional choices, each to be set by a
 * measurement or in review; change them here and nowhere else. The relay's own presence clock and
 * D142's layer 1 table are the relay's (`relay/src/core/rules.ts`).
 *
 * Frozen by the joint step 0 (docs/m3-m4-plan.md): changed only through the step 0 owner. The
 * relay link's version 1 stays open to additions until the first release (QR11).
 */
import { FILE_CHUNKS } from "../app/constants.ts";
import { label } from "../app/linking.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const KIB = 1024;

/** The Noise protocol of hub links and relay links (D125): `NOISE_PATTERNS.relay`. */
export const RELAY_NOISE_PATTERN = "Noise_XN_25519_ChaChaPoly_SHA256";

/** The relay link protocol's versions, as `RelayHello.proto` and `RelayWelcome.proto` name them. */
export const RELAY_PROTO = { min: 1, max: 1 } as const;

/** The WebSocket paths on a relay (section 3). */
export const RELAY_PATHS = {
  /** A hub's link: XN with the prologue `hsn-relay/1`. */
  hub: "/v1/hub",
  /** A relay's link to the push service (D142): XN with the prologue `hsn-relay-peer/1`. */
  relay: "/v1/relay",
  /** A phone's stream: `/v1/phone/<identity>/<session | link | restore>` (`formatPhonePath`). */
  phonePrefix: "/v1/phone",
} as const;

/**
 * The prologues' labels (section 3): each is the ASCII label followed by a zero byte
 * (`relayPrologue`). Protocol labels: never renamed with the product (section 2).
 */
export const RELAY_PROLOGUE = {
  /** Hub links, `/v1/hub`. */
  hub: "hsn-relay/1",
  /** Relay links to the push service, `/v1/relay`. */
  peer: "hsn-relay-peer/1",
} as const;

/** A prologue's bytes: the label and a zero byte, fresh each call. */
export function relayPrologue(link: keyof typeof RELAY_PROLOGUE): Uint8Array {
  return label(RELAY_PROLOGUE[link]);
}

/** The paths a phone may name, as `APP_PATHS` names the hub's own listeners. */
export const PHONE_PATHS = ["session", "link", "restore"] as const;
export type PhonePathName = (typeof PHONE_PATHS)[number];

/** Close codes on a hub link and on a relay link (section 3; D142). */
export const RELAY_CLOSE = {
  /** The relay is stopping. */
  stopping: 1001,
  /** A newer link of the same identity replaced this one. */
  replaced: 4001,
  /** A frame the relay cannot read (an unknown binary kind, a text frame no schema accepts). */
  badFrame: 4400,
  /** The handshake was not finished in time (`RELAY_LIMITS.handshakeMs`). */
  handshakeTimeout: 4408,
  /** No shared version. */
  noSharedVersion: 4426,
  /** Over a limit: the hub waits `retryAfterMs`, or `RELAY_LIMITS.limitWaitMs`. */
  overLimit: 4429,
  /**
   * This key is refused by the operator (D142: the push service refusing a relay's key, or a relay
   * a hub's). Not a limit: nothing changes by waiting. The side whose link is closed with it stops
   * reconnecting, never retries on a timer, and reports the refusal once; it tries again only when
   * its configuration changes (a new relay or push URL, a new key) or it is restarted.
   */
  refused: 4403,
} as const;

/** Close codes the relay sends a phone (section 3, "Close codes to the phone"). */
export const PHONE_CLOSE = {
  /** The relay is stopping. */
  stopping: 1001,
  /** The phone sent a text message: the relay carries binary messages only. */
  textMessage: 1003,
  /** A message over 65,535 bytes. */
  tooLarge: 1009,
  /** The hub's channel refused the connection (its `admit` answered 503): try later. */
  tryLater: 1013,
  /** A malformed path or identity. */
  badPath: 4400,
  /** The hub is not connected. */
  hubNotConnected: 4404,
  /** The hub's link closed during the stream, or the stream was idle too long. */
  hubGone: 4410,
  /** Over a limit. */
  overLimit: 4429,
} as const;

/**
 * Closes the hub makes, passed through unchanged in `close {stream, code}`: 1000, 1008 and M2's
 * `CLOSE` codes 4000 to 4004 (section 3).
 */
export const PHONE_CLOSE_FROM_HUB = [1000, 1008, 4000, 4001, 4002, 4003, 4004] as const;

/**
 * The codes a hub may put in its own `close {stream, code}`: its closes passed through, and 1013
 * when its channel's `admit` refused the connection (section 4).
 */
export const HUB_STREAM_CLOSE_CODES: readonly number[] = [
  ...PHONE_CLOSE_FROM_HUB,
  PHONE_CLOSE.tryLater,
].sort((a, b) => a - b);

/** The limits and times the two ends of the relay's links share (sections 3, 4 and 5). */
export const RELAY_LIMITS = {
  /** A stream number: a u32, never reused on one link. */
  maxStream: 0xffff_ffff,
  /** A phone's message, and so a kind 1 frame's Noise message: at most 65,535 bytes. */
  maxPhoneMessageBytes: 65_535,
  /** A `roster` text frame, at most ‡. */
  maxRosterBytes: 128 * KIB,
  /** Items in one `push` frame, at most ‡. */
  maxPushItemsPerFrame: 32,
  /** A `release.get`'s `length`, at most ‡; the hub fetches in pieces of this size. */
  maxReleasePieceBytes: 256 * KIB,
  /** Release pieces in flight on one link, at most ‡ (section 6). */
  maxReleasePiecesInFlight: 4,
  /** `restarting`'s `withinMs`, at most ‡: the grace an announced restart gets. */
  maxRestartWithinMs: 10 * MINUTE,
  /** The hub waits this long for `restartingAck` before its switch goes on ‡ (section 4). */
  restartAckWaitMs: 2 * SECOND,
  /** A stream with no message either way for this long is closed with 4410 ‡. */
  streamIdleMs: 90 * SECOND,
  /** The hub sends `ping` this often ‡ (section 4, D112). */
  hubPingEveryMs: 30 * SECOND,
  /** No `pong` within this long closes the link and reconnects ‡. */
  pongWithinMs: 15 * SECOND,
  /** The relay closes a hub link silent this long ‡ (section 3, "Presence"). */
  silentLinkMs: 75 * SECOND,
  /** Message 3 of the XN handshake must arrive within this long, else 4408 ‡ (D142). */
  handshakeMs: 10 * SECOND,
  /** After `replaced`, a hub that did not reconnect itself waits this long ‡ (section 3). */
  identityInUseWaitMs: 10 * MINUTE,
  /** After `limit` without `retryAfterMs`, 4426 or 4429, the hub waits this long ‡. */
  limitWaitMs: 10 * MINUTE,
  /** A hub release offered through the relay, at most: M2's upload cap (section 6). */
  maxHubReleaseBytes: FILE_CHUNKS.maxUploadBytes,
  /** A firmware release offered through the relay, at most ‡ (m3-updates-design section 10). */
  maxFirmwareReleaseBytes: 8 * KIB * KIB,
  /** A fetch whose link dropped waits this long for the link before failing `unreachable` ‡. */
  fetchResumeWaitMs: 10 * MINUTE,
  /** The hub sends `release.check` when its link opens and this often after ‡. */
  releaseCheckEveryMs: 24 * 60 * MINUTE,
} as const;

/**
 * The hub's back-off after a failure (section 4): 1, 2, 4, 8, 16, 32 s, then every 60 s ‡, each
 * ±20% ‡, reset once a link has lasted 60 s ‡. The cap stays well under the relay's 3 minutes.
 */
export const RELAY_BACKOFF = {
  stepsMs: [1, 2, 4, 8, 16, 32].map((s) => s * SECOND) as readonly number[],
  thenEveryMs: 60 * SECOND,
  jitter: 0.2,
  resetAfterMs: 60 * SECOND,
} as const;

/**
 * The relay's links' XN handshake (docs/m4-design.md section 3, D125, D142): starting either side
 * with the right pattern and prologue, the identity the responder learns from message 3, the three
 * payloads as UTF-8 JSON, and the choice of a shared version.
 *
 *   hub link,   /v1/hub:   hub (initiator, its app static key) ↔ relay (responder, no static key)
 *   relay link, /v1/relay: relay (initiator, its own static key) ↔ push service (responder, none)
 *
 *   1  initiator → responder  e        RelayHello (hub link) or RelayPeerHello (relay link)
 *   2  responder → initiator  e, ee    RelayWelcome, or the socket closes 4426 (`sharedRelayProto`)
 *   3  initiator → responder  s, se    RelayJoin {}; the responder then knows `relayIdentity(rs)`
 *
 * After message 3 neither side splits for use: the link's frames go in the clear inside TLS
 * (D125). Nothing here throws; every refusal is a result.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { z } from "zod";
import { appIdentityBytes, formatIdentity } from "../app/linking.ts";
import {
  type EphemeralKeyPair,
  type Handshake,
  NOISE_PATTERNS,
  type NoiseResult,
  type StaticKey,
} from "../app/noise-interface.ts";
import { NO_STATIC_KEY, startHandshake } from "../app/noise.ts";
import { RELAY_CLOSE, RELAY_PROTO, relayPrologue } from "./constants.ts";
import {
  type RelayHello,
  relayHello,
  type RelayJoin,
  relayJoin,
  type RelayPeerHello,
  relayPeerHello,
  type RelayWelcome,
  relayWelcome,
} from "./frames.ts";

export { NO_STATIC_KEY };

/** Which link: a hub's (`/v1/hub`, `hsn-relay/1`) or a relay's to the push service (`/v1/relay`, `hsn-relay-peer/1`). */
export type RelayLinkKind = "hub" | "relay";

/** The prologue of a link kind: `hsn-relay/1` or `hsn-relay-peer/1`, then a zero byte. */
export function relayLinkPrologue(link: RelayLinkKind): Uint8Array {
  return relayPrologue(link === "hub" ? "hub" : "peer");
}

/**
 * The initiator: a hub with its app static key (the one key of its IK sessions, QR2), or a relay
 * with its own. `ephemeral` is for the vectors only.
 */
export function startRelayInitiator(
  link: RelayLinkKind,
  staticKey: StaticKey,
  ephemeral?: EphemeralKeyPair,
): NoiseResult<Handshake> {
  return startHandshake({
    pattern: NOISE_PATTERNS.relay,
    initiator: true,
    prologue: relayLinkPrologue(link),
    staticKey,
    ...(ephemeral === undefined ? {} : { ephemeral }),
  });
}

/** The responder: the relay on a hub link, the push service on a relay link. It has no static key. */
export function startRelayResponder(
  link: RelayLinkKind,
  ephemeral?: EphemeralKeyPair,
): NoiseResult<Handshake> {
  return startHandshake({
    pattern: NOISE_PATTERNS.relay,
    initiator: false,
    prologue: relayLinkPrologue(link),
    staticKey: NO_STATIC_KEY,
    ...(ephemeral === undefined ? {} : { ephemeral }),
  });
}

/**
 * The identity a static public key proves (D55): the first 16 bytes of its SHA-256, as 26
 * characters of base32 (`appIdentityBytes`, `formatIdentity`). Undefined for a key that is not 32
 * bytes.
 */
export function relayIdentity(staticPublic: Uint8Array): string | undefined {
  if (staticPublic.length !== 32) return undefined;
  return formatIdentity(appIdentityBytes(sha256, staticPublic));
}

/**
 * The identity the responder has proved, once message 3 is read: undefined before, and for a
 * handshake that failed. The relay answers it in `joined {identity}`.
 */
export function provedIdentity(handshake: Handshake): string | undefined {
  if (!handshake.complete) return undefined;
  const remote = handshake.remoteStatic();
  return remote === undefined ? undefined : relayIdentity(remote);
}

// ----- The payloads -----

/** Why a payload was refused: not UTF-8 JSON, or JSON its schema does not accept. */
export type RelayPayloadError = "badJson" | "badPayload";

export type RelayPayloadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RelayPayloadError };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function decodeJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function decodeWith<T>(schema: z.ZodType<T>, bytes: Uint8Array): RelayPayloadResult<T> {
  const json = decodeJson(bytes);
  if (json === undefined) return { ok: false, error: "badJson" };
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "badPayload" };
}

function encodeWith<T>(schema: z.ZodType<T>, value: T): RelayPayloadResult<Uint8Array> {
  if (!schema.safeParse(value).success) return { ok: false, error: "badPayload" };
  return { ok: true, value: encoder.encode(JSON.stringify(value)) };
}

/** Message 1 on a hub link. */
export const decodeRelayHello = (bytes: Uint8Array): RelayPayloadResult<RelayHello> =>
  decodeWith(relayHello, bytes);
export const encodeRelayHello = (value: RelayHello): RelayPayloadResult<Uint8Array> =>
  encodeWith(relayHello, value);

/** Message 1 on a relay link. */
export const decodeRelayPeerHello = (bytes: Uint8Array): RelayPayloadResult<RelayPeerHello> =>
  decodeWith(relayPeerHello, bytes);
export const encodeRelayPeerHello = (value: RelayPeerHello): RelayPayloadResult<Uint8Array> =>
  encodeWith(relayPeerHello, value);

/** Message 2 on either link. */
export const decodeRelayWelcome = (bytes: Uint8Array): RelayPayloadResult<RelayWelcome> =>
  decodeWith(relayWelcome, bytes);
export const encodeRelayWelcome = (value: RelayWelcome): RelayPayloadResult<Uint8Array> =>
  encodeWith(relayWelcome, value);

/** Message 3 on either link: `{}`. */
export const decodeRelayJoin = (bytes: Uint8Array): RelayPayloadResult<RelayJoin> =>
  decodeWith(relayJoin, bytes);
export const encodeRelayJoin = (value: RelayJoin): RelayPayloadResult<Uint8Array> =>
  encodeWith(relayJoin, value);

/**
 * The version both ends speak: the highest in both the initiator's `[min, max]` and ours, or
 * undefined when none is shared, which the responder answers by closing with 4426.
 */
export function sharedRelayProto(
  theirs: readonly [number, number],
  ours: { readonly min: number; readonly max: number } = RELAY_PROTO,
): number | undefined {
  const [min, max] = theirs;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return undefined;
  const high = Math.min(max, ours.max);
  return high >= Math.max(min, ours.min) ? high : undefined;
}

// ----- After a close -----

/** What the side whose link was closed does next (`relay-frames.json`'s `closes`). */
export type RelayReconnect = "backoff" | "wait" | "never";

/**
 * After a hub link or relay link closes with `code`: `never` for 4403 (`refused`: stop, report it
 * once, try again only after a change of configuration or a restart); `wait` for 4001, 4426 and
 * 4429 (`retryAfterMs` when a `limit` gave one, else `RELAY_LIMITS.limitWaitMs` or, after
 * `replaced`, `identityInUseWaitMs`); `backoff` for every other code, and for a link that dropped
 * without one (`RELAY_BACKOFF`).
 */
export function relayCloseReconnect(code: number): RelayReconnect {
  if (code === RELAY_CLOSE.refused) return "never";
  if (
    code === RELAY_CLOSE.replaced ||
    code === RELAY_CLOSE.noSharedVersion ||
    code === RELAY_CLOSE.overLimit
  )
    return "wait";
  return "backoff";
}

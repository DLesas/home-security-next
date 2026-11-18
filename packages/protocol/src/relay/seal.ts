/**
 * Sealing and opening a push (docs/m4-design.md section 5, D126, D127), behind the frozen
 * `PushSealer` and `PushOpener`:
 *
 *   h      = "1." keyId (16 lowercase hex) "." base64url( nonce (12) ‖ ChaCha20-Poly1305(key, nonce, aad, padded) )
 *   aad    = "hsn-push/1", a zero byte, the key id (8 bytes)
 *   padded = the UTF-8 JSON of PushContent, a byte 0x80, then zero bytes up to 1,280 bytes
 *
 * base64url is RFC 4648 section 5 without padding; 1,308 bytes are exactly 1,744 characters, so
 * every `h` is 1,763 characters. Opening refuses, in this order: anything not of that form
 * (`badFormat`, which covers another version, a truncated or oversized `h`, upper-case hex and
 * base64 that is not base64url); a key id with no key, or a key not 32 bytes (`unknownKey`); a tag
 * that does not verify (`decryptFailed`); a plaintext whose last non-zero byte is not 0x80
 * (`badPadding`); and content that is not UTF-8 JSON `pushContent` accepts (`badContent`).
 *
 * Sealing refuses, in this order: a key not 32 bytes or a key id not 8 (`badKey`); a nonce not 12
 * (`badNonce`); content the opener would refuse as `badContent` (`badContent`: the JSON to be
 * sealed is read back and checked against `pushContent` first, so a push the phone would drop is
 * never sent); content over 1,279 bytes (`tooLong`).
 *
 * Also here: the relay's two alerts, which the hub seals in advance for each target (D127), and the
 * push key and key id as `push.register` carries them. Nothing here throws, logs or keeps a key.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { toHex } from "../bytes.ts";
import {
  PUSH_H,
  type PushContent,
  pushContent,
  pushContentBytes,
  pushH,
  pushKeyIdHex,
  pushKeyText,
  type PushKey,
  type PushOpener,
  type PushOpenError,
  type PushResult,
  type PushSealer,
  type PushSealError,
} from "./push.ts";

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// ----- base64url (RFC 4648 section 5, no padding) -----

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. */
export function toBase64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += ALPHABET[(n >>> (18 - 6 * j)) & 63] ?? "";
  }
  return out;
}

/**
 * Reads base64url without padding, exactly as `toBase64url` writes it: undefined for any other
 * character, a length no bytes encode to, or unused low bits that are not zero.
 */
export function fromBase64url(text: string): Uint8Array | undefined {
  if (text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return undefined;
    value = ((value << 6) | digit) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >>> bits) & 0xff;
    }
  }
  return (value & ((1 << bits) - 1)) === 0 ? out : undefined;
}

// ----- The key id and the key, as `push.register` carries them -----

/** A key id's 8 bytes as `h` and `push.register` write them: 16 lowercase hex digits. */
export function formatPushKeyId(keyId: Uint8Array): string | undefined {
  return keyId.length === PUSH_H.keyIdBytes ? toHex(keyId) : undefined;
}

/** A key id from its 16 lowercase hex digits. */
export function parsePushKeyId(text: string): Uint8Array | undefined {
  if (!pushKeyIdHex.safeParse(text).success) return undefined;
  return Uint8Array.from({ length: PUSH_H.keyIdBytes }, (_, i) =>
    Number.parseInt(text.slice(2 * i, 2 * i + 2), 16),
  );
}

/** A push key's 32 bytes as `push.register` carries them: 43 characters of base64url. */
export function formatPushKey(key: Uint8Array): string | undefined {
  return key.length === PUSH_H.keyBytes ? toBase64url(key) : undefined;
}

/** A push key from its 43 characters of base64url; undefined unless exactly as written. */
export function parsePushKey(text: string): Uint8Array | undefined {
  if (!pushKeyText.safeParse(text).success) return undefined;
  const key = fromBase64url(text);
  return key?.length === PUSH_H.keyBytes ? key : undefined;
}

// ----- Sealing -----

/** The associated data: `hsn-push/1`, a zero byte, the key id. */
export function pushAad(keyId: Uint8Array): Uint8Array {
  const label = encoder.encode(PUSH_H.aadLabel);
  const aad = new Uint8Array(label.length + 1 + keyId.length);
  aad.set(label);
  aad.set(keyId, label.length + 1);
  return aad;
}

/** The 1,280-byte plaintext: the content's bytes, 0x80, zeros. Undefined past 1,279 bytes. */
export function padPushContent(contentBytes: Uint8Array): Uint8Array | undefined {
  if (contentBytes.length > PUSH_H.maxContentBytes) return undefined;
  const padded = new Uint8Array(PUSH_H.paddedBytes);
  padded.set(contentBytes);
  padded[contentBytes.length] = PUSH_H.padMark;
  return padded;
}

/**
 * The content's bytes, or undefined when the padding is wrong: the last byte that is not zero must
 * be 0x80; what is before it is the content.
 */
export function unpadPushContent(padded: Uint8Array): Uint8Array | undefined {
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== PUSH_H.padMark) return undefined;
  return padded.slice(0, end);
}

/**
 * The bytes that will be sealed, when the phone would accept them: the content's UTF-8 JSON, read
 * back exactly as the opener reads it and checked against `pushContent`. Undefined for content
 * the phone would drop (a name over 64 UTF-16 units, an unknown action, a missing field, a value
 * JSON cannot carry), which is then never sealed.
 */
function acceptedContentBytes(content: PushContent): Uint8Array | undefined {
  let bytes: Uint8Array;
  try {
    bytes = pushContentBytes(content);
  } catch {
    return undefined;
  }
  return parseContent(bytes) === undefined ? undefined : bytes;
}

function seal(
  content: PushContent,
  key: PushKey,
  nonce: Uint8Array,
): PushResult<string, PushSealError> {
  if (key.key.length !== PUSH_H.keyBytes || key.keyId.length !== PUSH_H.keyIdBytes)
    return { ok: false, error: "badKey" };
  if (nonce.length !== PUSH_H.nonceBytes) return { ok: false, error: "badNonce" };
  const contentBytes = acceptedContentBytes(content);
  if (contentBytes === undefined) return { ok: false, error: "badContent" };
  const padded = padPushContent(contentBytes);
  if (padded === undefined) return { ok: false, error: "tooLong" };
  const sealed = chacha20poly1305(key.key, nonce, pushAad(key.keyId)).encrypt(padded);
  padded.fill(0);
  const body = new Uint8Array(nonce.length + sealed.length);
  body.set(nonce);
  body.set(sealed, nonce.length);
  return { ok: true, value: `${PUSH_H.version}.${toHex(key.keyId)}.${toBase64url(body)}` };
}

// ----- Opening -----

function refused(error: PushOpenError): PushResult<PushContent, PushOpenError> {
  return { ok: false, error };
}

function decrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array) {
  try {
    return chacha20poly1305(key, nonce, aad).decrypt(sealed);
  } catch {
    return undefined;
  }
}

function parseContent(bytes: Uint8Array): PushContent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
  const parsed = pushContent.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function open(
  h: string,
  keyFor: (keyId: Uint8Array) => Uint8Array | undefined,
): PushResult<PushContent, PushOpenError> {
  if (h.length !== PUSH_H.hChars || !pushH.safeParse(h).success) return refused("badFormat");
  const [, keyIdText = "", sealedText = ""] = h.split(".");
  const keyId = parsePushKeyId(keyIdText);
  const body = fromBase64url(sealedText);
  const sealedBytes = PUSH_H.nonceBytes + PUSH_H.paddedBytes + PUSH_H.tagBytes;
  if (keyId === undefined || body?.length !== sealedBytes) return refused("badFormat");
  const key = keyFor(keyId.slice());
  if (key?.length !== PUSH_H.keyBytes) return refused("unknownKey");
  const nonce = body.slice(0, PUSH_H.nonceBytes);
  const padded = decrypt(key, nonce, pushAad(keyId), body.slice(PUSH_H.nonceBytes));
  if (padded === undefined) return refused("decryptFailed");
  const contentBytes = unpadPushContent(padded);
  padded.fill(0);
  if (contentBytes === undefined) return refused("badPadding");
  const content = parseContent(contentBytes);
  contentBytes.fill(0);
  return content === undefined ? refused("badContent") : { ok: true, value: content };
}

/** Seals content for one phone; the hub's shell gives it 12 random bytes as the nonce. */
export const pushSealer: PushSealer = { seal };

/** Opens `h`, for tests and the stand-ins; the phone has its own, against `relay-push.json`. */
export const pushOpener: PushOpener = { open };

// ----- The relay's two alerts (D127) -----

/** The content kinds of the relay's two alerts. */
export const RELAY_ALERT_KINDS = { unreachable: "hub_unreachable", back: "hub_back" } as const;
export type RelayAlert = keyof typeof RELAY_ALERT_KINDS;

/**
 * One of the relay's alerts as the hub seals it in advance (section 5, D127): kind
 * `hub_unreachable` or `hub_back`, category `hub`, `n.seq` 0 and no time (`atMs` 0, `clockOk`
 * false), not critical (the phone decides how loud, D96), no device, cause, names or actions, not
 * delayed. `armed` is the hub's state when it seals them, which the roster carries until it is
 * sent again; the phone takes the alert's time from its arrival.
 */
export function relayAlertContent(alert: RelayAlert, hub: string, armed: boolean): PushContent {
  return {
    v: 1,
    hub,
    n: {
      seq: 0,
      atMs: 0,
      clockOk: false,
      kind: RELAY_ALERT_KINDS[alert],
      category: "hub",
      critical: false,
      device: null,
      cause: null,
    },
    delayed: false,
    names: {},
    actions: [],
    armed,
  };
}

/** A roster target's two sealed alerts. */
export interface SealedRelayAlerts {
  readonly unreachable: string;
  readonly back: string;
}

/**
 * Seals both alerts for one target, each with its own nonce: two equal nonces under one key would
 * let anyone who sees both read them and forge others, so they are refused as `badNonce`. The hub
 * makes them again, with new nonces, whenever it sends the roster.
 */
export function sealRelayAlerts(
  hub: string,
  armed: boolean,
  key: PushKey,
  nonces: { readonly unreachable: Uint8Array; readonly back: Uint8Array },
): PushResult<SealedRelayAlerts, PushSealError> {
  if (
    nonces.unreachable.length === nonces.back.length &&
    nonces.unreachable.every((byte, i) => byte === nonces.back[i])
  )
    return { ok: false, error: "badNonce" };
  const unreachable = seal(relayAlertContent("unreachable", hub, armed), key, nonces.unreachable);
  if (!unreachable.ok) return unreachable;
  const back = seal(relayAlertContent("back", hub, armed), key, nonces.back);
  if (!back.ok) return back;
  return { ok: true, value: { unreachable: unreachable.value, back: back.value } };
}

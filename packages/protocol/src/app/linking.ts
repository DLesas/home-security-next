/**
 * How a link token travels (docs/m2-design.md section 5, "Linking"): the hub's app identity, the
 * 128-bit secret's lookup and pre-shared key, the typed code, the QR code's URL, the link
 * address and the console's address. Pure functions over bytes and text; SHA-256 is passed in,
 * as everywhere in this package, so the browser, the hub and the phone use their own.
 */
import type { Sha256 } from "../crypto/sha256.ts";
import { LINKING } from "./constants.ts";

const encoder = new TextEncoder();

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An ASCII label and the zero byte after it, as every prologue and derivation starts. */
export function label(text: string): Uint8Array {
  return concat(encoder.encode(text), new Uint8Array([0]));
}

/** The prologue of each purpose (section 5, "Prologues"). */
export const PROLOGUE = {
  /** `hsn-session/1`, 0, then the hub's app identity (16 bytes): see `sessionPrologue`. */
  session: "hsn-session/1",
  link: "hsn-link/1",
  restore: "hsn-restore/1",
} as const;

/** A session's prologue: the label, a zero byte and the hub's app identity's 16 bytes. */
export function sessionPrologue(identity: Uint8Array): Uint8Array {
  return concat(label(PROLOGUE.session), identity);
}

/** The link and restore prologues: the label and a zero byte. */
export function linkPrologue(purpose: "link" | "restore"): Uint8Array {
  return label(PROLOGUE[purpose]);
}

// ----- The hub's app identity: 16 bytes of SHA-256 of its static key, as base32 -----

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The hub's app identity's 16 bytes: the first 16 bytes of SHA-256 of its static public key. */
export function appIdentityBytes(sha256: Sha256, staticPublic: Uint8Array): Uint8Array {
  return sha256(staticPublic).slice(0, 16);
}

/** 16 bytes as 26 characters of lower-case base32 without padding (RFC 4648). */
export function formatIdentity(identity: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of identity) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? "";
  return out;
}

/** The 16 bytes of an identity's text, or undefined when it is not 26 base32 characters. */
export function parseIdentity(text: string): Uint8Array | undefined {
  if (!/^[a-z2-7]{26}$/u.test(text)) return undefined;
  const out = new Uint8Array(16);
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const ch of text) {
    value = ((value << 5) | BASE32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8 && at < 16) {
      out[at++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  // The last 2 bits are padding and must be zero.
  return (value & ((1 << bits) - 1)) === 0 ? out : undefined;
}

// ----- A 128-bit secret: its pre-shared key and lookup -----

/** A 128-bit secret's pre-shared key: SHA-256 of `hsn-link/1`, a zero byte, and the secret. */
export function secretPsk(sha256: Sha256, secret: Uint8Array): Uint8Array {
  return sha256(concat(label("hsn-link/1"), secret));
}

/**
 * The lookup `LinkHello` carries for a 128-bit secret: the first 4 bytes of SHA-256 of
 * `hsn-find/1`, a zero byte, and the secret, as 8 hex digits.
 */
export function secretLookup(sha256: Sha256, secret: Uint8Array): string {
  return [...sha256(concat(label("hsn-find/1"), secret)).slice(0, LINKING.lookupBytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ----- The typed code: XXXX-XXXX-XXXX in Crockford base32 -----

/** Crockford's alphabet, and its five extra check symbols for 32 to 36. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_SYMBOLS = "*~$=U";

/** A typed code's parts. */
export interface TypedCode {
  /** The token id: 20 bits, chosen by the core among those not in use. */
  readonly tokenId: number;
  /** The secret: 35 bits. */
  readonly secret: bigint;
}

const TOKEN_ID_BITS = 20;
const SECRET_BITS = 35;

/** Reads a typed code, as a person types it: case, spaces, dashes and Crockford's look-alikes forgiven. */
export function parseTypedCode(text: string): TypedCode | undefined {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/gu, "")
    .replace(/[IL]/gu, "1")
    .replace(/O/gu, "0");
  const chars = LINKING.typedTokenIdChars + LINKING.typedSecretChars;
  if (clean.length !== chars + 1) return undefined;
  let value = 0n;
  for (const ch of clean.slice(0, chars)) {
    const digit = CROCKFORD.indexOf(ch);
    if (digit < 0) return undefined;
    value = value * 32n + BigInt(digit);
  }
  const check = clean.slice(chars);
  const expected = checkSymbol(value);
  if (check !== expected) return undefined;
  return {
    tokenId: Number(value >> BigInt(SECRET_BITS)),
    secret: value & ((1n << BigInt(SECRET_BITS)) - 1n),
  };
}

function checkSymbol(value: bigint): string {
  const n = Number(value % 37n);
  return n < 32 ? (CROCKFORD[n] ?? "") : (CHECK_SYMBOLS[n - 32] ?? "");
}

/** Writes a typed code as `XXXX-XXXX-XXXX`, or undefined when a part is out of range. */
export function formatTypedCode(code: TypedCode): string | undefined {
  const idOk =
    Number.isInteger(code.tokenId) && code.tokenId >= 0 && code.tokenId < 2 ** TOKEN_ID_BITS;
  const secretOk = code.secret >= 0n && code.secret < 1n << BigInt(SECRET_BITS);
  if (!idOk || !secretOk) return undefined;
  let value = (BigInt(code.tokenId) << BigInt(SECRET_BITS)) | code.secret;
  const all = value;
  let digits = "";
  for (let i = 0; i < LINKING.typedTokenIdChars + LINKING.typedSecretChars; i++) {
    digits = (CROCKFORD[Number(value & 31n)] ?? "") + digits;
    value >>= 5n;
  }
  const text = digits + checkSymbol(all);
  return `${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8, 12)}`;
}

/** The typed code's token id as `LinkHello.find` carries it: its 4 characters. */
export function typedLookup(tokenId: number): string {
  let value = tokenId;
  let out = "";
  for (let i = 0; i < LINKING.typedTokenIdChars; i++) {
    out = (CROCKFORD[value & 31] ?? "") + out;
    value >>>= 5;
  }
  return out;
}

/** The typed code's secret as the pre-shared key's input: 5 bytes, big-endian, top 5 bits zero. */
export function typedSecretBytes(secret: bigint): Uint8Array {
  const out = new Uint8Array(LINKING.typedSecretBytes);
  let value = secret;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/**
 * A typed code's pre-shared key, made as a 128-bit secret's from the 5 bytes (section 5): SHA-256
 * of `hsn-link/1`, a zero byte, and the 5 bytes.
 */
export function typedPsk(sha256: Sha256, secret: bigint): Uint8Array {
  return secretPsk(sha256, typedSecretBytes(secret));
}

// ----- The QR code, the link address and the console's address -----

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64url(text: string, length: number): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return undefined;
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  const out = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return out.length === length ? out : undefined;
}

/** What a QR code carries (section 5, "A QR code"). */
export interface LinkQr {
  readonly identity: string;
  readonly secret: Uint8Array;
  readonly addresses: readonly string[];
  readonly port: number;
  /** The certificate's SHA-256, 32 bytes. */
  readonly fingerprint: Uint8Array;
  /**
   * Version 2 (docs/m4-design.md section 9): `r=`, the hub's relay, only when it is not the
   * deployment's default. The prefix stays `/1`: a parser ignores parameters it does not know.
   */
  readonly relay?: string;
}

/**
 * `hsn://link/1?h=<identity>&s=<secret>&a=<addresses>&p=<port>&c=<fingerprint>[&r=<relay>]`,
 * or with `hsn://restore/1` for a restore token (section 9), which names the new hub's own app
 * key. `r=` is percent-encoded, and written only when given.
 */
export function formatLinkQr(qr: LinkQr, purpose: "link" | "restore" = "link"): string {
  const relay = qr.relay === undefined ? "" : `&r=${encodeURIComponent(qr.relay)}`;
  return `${qrPrefix(purpose)}?h=${qr.identity}&s=${base64url(qr.secret)}&a=${qr.addresses.join(",")}&p=${qr.port}&c=${base64url(qr.fingerprint)}${relay}`;
}

function qrPrefix(purpose: "link" | "restore"): string {
  return purpose === "link" ? LINKING.qrPrefix : LINKING.restoreQrPrefix;
}

export function parseLinkQr(
  text: string,
  purpose: "link" | "restore" = "link",
): LinkQr | undefined {
  const prefix = qrPrefix(purpose);
  if (!text.startsWith(`${prefix}?`)) return undefined;
  const params = new URLSearchParams(text.slice(prefix.length + 1));
  const identity = params.get("h") ?? "";
  const secret = fromBase64url(params.get("s") ?? "", LINKING.secretBytes);
  const fingerprint = fromBase64url(params.get("c") ?? "", 32);
  const port = Number(params.get("p"));
  const addresses = (params.get("a") ?? "").split(",").filter((a) => a !== "");
  if (parseIdentity(identity) === undefined || secret === undefined || fingerprint === undefined)
    return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || addresses.length === 0)
    return undefined;
  // An empty `r=` is read as none, as a version 1 parser ignored it.
  const relay = params.get("r");
  return relay === null || relay === ""
    ? { identity, secret, addresses, port, fingerprint }
    : { identity, secret, addresses, port, fingerprint, relay };
}

/** `https://<address>:<port>/#link=<identity>.<secret>`: the fragment never reaches a server. */
export function formatLinkAddress(
  address: string,
  port: number,
  identity: string,
  secret: Uint8Array,
): string {
  return `https://${address}:${port}/#${LINKING.linkFragment}=${identity}.${base64url(secret)}`;
}

/** A link address's fragment (`link=<identity>.<secret>`, without the `#`). */
export function parseLinkFragment(
  fragment: string,
): { readonly identity: string; readonly secret: Uint8Array } | undefined {
  const prefix = `${LINKING.linkFragment}=`;
  if (!fragment.startsWith(prefix)) return undefined;
  const [identity = "", secretText = "", ...rest] = fragment.slice(prefix.length).split(".");
  const secret = fromBase64url(secretText, LINKING.secretBytes);
  if (rest.length > 0 || parseIdentity(identity) === undefined || secret === undefined)
    return undefined;
  return { identity, secret };
}

/** The console's address, `http://127.0.0.1:<port>/#console=<secret>`, which `hsn open` opens. */
export function formatConsoleAddress(port: number, secret: Uint8Array): string {
  return `http://127.0.0.1:${port}/#${LINKING.consoleFragment}=${base64url(secret)}`;
}

export function parseConsoleFragment(fragment: string): Uint8Array | undefined {
  const prefix = `${LINKING.consoleFragment}=`;
  return fragment.startsWith(prefix)
    ? fromBase64url(fragment.slice(prefix.length), LINKING.secretBytes)
    : undefined;
}

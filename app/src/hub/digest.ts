/**
 * What linking derives from a secret (m2-design.md section 5, "Linking"), with Web Crypto's
 * SHA-256, which the browser has and which is asynchronous. The protocol package's own functions
 * (`secretPsk`, `secretLookup`, `typedPsk`, `appIdentityBytes`) take a synchronous SHA-256; these
 * are the same derivations over the same labels, and `test/digest.test.ts` checks each against
 * those functions and the vectors, so the two cannot drift apart.
 */
import { formatIdentity, label, LINKING, typedSecretBytes } from "@hsn/protocol/app";

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", concat(data)));
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A 128-bit secret's pre-shared key: SHA-256 of `hsn-link/1`, a zero byte, and the secret. */
export function pskOfSecret(secret: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(label("hsn-link/1"), secret));
}

/** A 128-bit secret's lookup: the first 4 bytes of SHA-256 of `hsn-find/1`, 0, the secret, as hex. */
export async function lookupOfSecret(secret: Uint8Array): Promise<string> {
  return toHex((await sha256(concat(label("hsn-find/1"), secret))).slice(0, LINKING.lookupBytes));
}

/** A typed code's pre-shared key: as a 128-bit secret's, from its 5 bytes. */
export function pskOfTypedSecret(secret: bigint): Promise<Uint8Array> {
  return pskOfSecret(typedSecretBytes(secret));
}

/** The hub's app identity from its static key: 16 bytes of SHA-256, as 26 characters of base32. */
export async function identityOf(staticPublic: Uint8Array): Promise<string> {
  return formatIdentity((await sha256(staticPublic)).slice(0, 16));
}

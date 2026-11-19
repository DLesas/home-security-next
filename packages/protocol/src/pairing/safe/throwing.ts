/**
 * The calls of pairing's code that can throw, each wrapped once so that nothing else in
 * `src/pairing/` needs a `try` (docs/m3-m4-plan.md, rule 3): noble's AES-GCM, which throws on a
 * tag that does not verify; `JSON.parse`; and the platform's random number generator, which noble
 * reaches through `crypto.getRandomValues` and which throws where there is none. None of them is
 * given or returns anything to log: a failure is undefined, never the error's text.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";

/** AES-256-GCM, no associated data, the 16-byte tag after the ciphertext. */
export function gcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return gcm(key, nonce).encrypt(plaintext);
}

/** The plaintext, or undefined when the tag does not verify. */
export function gcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
): Uint8Array | undefined {
  try {
    return gcm(key, nonce).decrypt(sealed);
  } catch {
    return undefined;
  }
}

/** The value, or undefined when the text is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Random bytes from the platform, or undefined when it has no generator. */
export function random(length: number): Uint8Array | undefined {
  try {
    return randomBytes(length);
  } catch {
    return undefined;
  }
}

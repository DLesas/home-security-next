/**
 * The client's key, per platform (m3-design.md section 2, "Keys and storage on the phone"):
 * made, and used for Noise's Diffie-Hellman. `keys.web.ts` holds a non-extractable Web Crypto key
 * (spike K1); `keys.native.ts` will hold 32 bytes in the phone's secure store, its
 * Diffie-Hellman by `@noble/curves` (P2, wave 1). Metro loads one of them in place of this file;
 * tsc and Bun's tests read this one, which binds the web build's (`split.ts`).
 *
 * Each platform's record store is its own (`indexedDbRecordStore` in `keys.web.ts`), made by its
 * `hub/start` file; shared code takes it as a `RecordStore`.
 */
import type { ClientKeys } from "./client-key";
import type * as phone from "./keys.native";
import type { Implements } from "./split";
import * as web from "./keys.web";

/**
 * The private half of the client's key on this platform: a `CryptoKey` in a browser, the 32
 * bytes of an X25519 private key on a phone. tsc and Bun's tests see the web build's.
 */
export type PlatformSecret = web.PlatformSecret;

/** Both platforms' files export `ClientKeys`, each over its own secret. */
export type Platforms = readonly [
  Implements<ClientKeys<web.PlatformSecret>, typeof web>,
  Implements<ClientKeys<phone.PlatformSecret>, typeof phone>,
];

export const { makeClientKey, staticKeyOf }: ClientKeys<PlatformSecret> = web;

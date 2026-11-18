/**
 * The phone's key (m3-design.md section 2, "Keys and storage on the phone"), the phone's side of
 * `keys.ts`. Not built yet: P2 builds it in wave 1 (a 32-byte X25519 key per hub from
 * `@noble/curves` and `crypto.getRandomValues`, kept in expo-secure-store as `hub.<identity>.key`,
 * readable after the first unlock, on this device only). Until then it makes no key, so a phone
 * cannot link, and touches nothing on the phone.
 */
import type { StaticKey } from "@hsn/protocol/app";
import type { ClientKeyPair, KeyFault } from "./client-key";
import { NOT_BUILT, type Outcome } from "./split";

/** The phone's private half: the 32 bytes of an X25519 private key. */
export type PlatformSecret = Uint8Array;

/** Refuses: `notBuilt`. */
export function makeClientKey(): Promise<Outcome<ClientKeyPair<Uint8Array>, KeyFault>> {
  return Promise.resolve(NOT_BUILT);
}

/**
 * Refuses: its Diffie-Hellman is all zeros, which the Noise code refuses (`allZeroDh`). Never
 * reached while `makeClientKey` makes no key.
 */
export function staticKeyOf(pair: ClientKeyPair<Uint8Array>): StaticKey {
  return { publicKey: pair.publicKey, dh: () => Promise.resolve(new Uint8Array(32)) };
}

/**
 * The phone's key (m3-design.md section 2, "Keys and storage on the phone"), the phone's side of
 * `keys.ts`: a 32-byte X25519 private key per hub, made from `crypto.getRandomValues` (on a phone,
 * expo-crypto's: the system's secure generator, installed at the entry by `random-start.ts`), its
 * Diffie-Hellman by the protocol package's `x25519StaticKey` over `@noble/curves`. The bytes are
 * kept by the vault (`vault.ts`) in the phone's secure store, never anywhere else; nothing here
 * logs or keeps them.
 */
import { type StaticKey, x25519StaticKey } from "@hsn/protocol/app";
import type { ClientKeyPair, KeyFault } from "./client-key";
import type { Outcome } from "./split";

/** The phone's private half: the 32 bytes of an X25519 private key. */
export type PlatformSecret = Uint8Array;

/** Where the key's random bytes come from: `crypto.getRandomValues`, or a stand-in in tests. */
export type FillRandom = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array;

function systemRandom(bytes: Uint8Array<ArrayBuffer>): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}

/** The key pair of 32 private bytes, or undefined when they are not an X25519 key's 32 bytes. */
export function keyPairOf(privateKey: Uint8Array): ClientKeyPair<Uint8Array> | undefined {
  const key = x25519StaticKey(privateKey);
  return key.ok ? { privateKey: privateKey.slice(), publicKey: key.value.publicKey } : undefined;
}

/**
 * Makes a new static key for one hub. A random source that is missing, or that answers all zeros
 * or the same bytes twice (a stand-in left in place, not a generator), refuses: `failed`.
 */
export function makeClientKey(
  fill: FillRandom = systemRandom,
): Promise<Outcome<ClientKeyPair<Uint8Array>, KeyFault>> {
  const scope = globalThis as { readonly crypto?: { readonly getRandomValues?: unknown } };
  if (typeof scope.crypto?.getRandomValues !== "function" && fill === systemRandom)
    return Promise.resolve({ ok: false, fault: "failed" });
  const first = fill(new Uint8Array(32));
  const second = fill(new Uint8Array(32));
  const same = first.every((b, i) => b === second[i]);
  second.fill(0);
  if (first.length !== 32 || same || first.every((b) => b === 0)) {
    first.fill(0);
    return Promise.resolve({ ok: false, fault: "failed" });
  }
  const pair = keyPairOf(first);
  first.fill(0);
  return Promise.resolve(
    pair === undefined ? { ok: false, fault: "failed" } : { ok: true, value: pair },
  );
}

/**
 * The key as the Noise code's `StaticKey`. A private half that is not 32 bytes (a record read
 * wrong) gives a Diffie-Hellman of all zeros, which the Noise code refuses (`allZeroDh`).
 */
export function staticKeyOf(pair: ClientKeyPair<Uint8Array>): StaticKey {
  const key = x25519StaticKey(pair.privateKey);
  return key.ok
    ? { publicKey: pair.publicKey, dh: (theirs) => key.value.dh(theirs) }
    : { publicKey: pair.publicKey, dh: () => Promise.resolve(new Uint8Array(32)) };
}

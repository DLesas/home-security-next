/**
 * What linking derives from a secret (m2-design.md section 5, "Linking") over any asynchronous
 * SHA-256: the same derivations over the same labels as the protocol package's `secretPsk`,
 * `secretLookup`, `typedPsk` and `appIdentityBytes`. The phone's file (`digest.native.ts`) gives it
 * the system's SHA-256; `test/phone-digest.test.ts` checks it against the protocol package's
 * functions and the vectors, with no stand-in for the phone's modules.
 */
import { formatIdentity, label, LINKING, typedSecretBytes } from "@hsn/protocol/app";
import type { Digests } from "./digest-types";
import { toHex } from "./hex";

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The derivations over `hash`, which is given a copy of its input in a buffer of its own. */
export function digestsOver(hash: (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>): Digests {
  const sha256 = (data: Uint8Array) => hash(concat(data));
  const pskOfSecret = (secret: Uint8Array) => sha256(concat(label("hsn-link/1"), secret));
  return {
    sha256,
    pskOfSecret,
    lookupOfSecret: async (secret) =>
      toHex((await sha256(concat(label("hsn-find/1"), secret))).slice(0, LINKING.lookupBytes)),
    pskOfTypedSecret: (secret) => pskOfSecret(typedSecretBytes(secret)),
    identityOf: async (staticPublic) => formatIdentity((await sha256(staticPublic)).slice(0, 16)),
    toHex,
  };
}

/** What the phone's SHA-256 needs of expo-crypto's native module (`ExpoCrypto`, expo-crypto 58.0.8). */
export interface CryptoModule {
  readonly digestAsync?: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
  readonly digest?: (algorithm: string, output: Uint8Array, data: Uint8Array) => void;
}

/**
 * SHA-256 through expo-crypto's native module, as its own `digest` calls it (read in expo-crypto
 * 58.0.8's `build/Crypto.js`): `digestAsync` where the module has it, else the synchronous `digest`
 * into a 32-byte output. The module is reached through `globalThis.expo.modules` rather than by
 * importing expo-crypto, whose types would widen `process.env` in every program the platform split
 * brings this file into (docs/spikes/P0-phone-build.md, "Found on the way"). A phone without the
 * module refuses each digest.
 */
export function moduleSha256(
  module: CryptoModule | undefined,
): (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array> {
  return async (data) => {
    if (typeof module?.digestAsync === "function")
      return new Uint8Array(await module.digestAsync("SHA-256", data));
    if (typeof module?.digest !== "function")
      return Promise.reject(new Error("expo-crypto's native module is not in this build"));
    const output = new Uint8Array(32);
    module.digest("SHA-256", output, data);
    return output;
  };
}

/**
 * What linking derives from a secret, the phone's side of `digest.ts` (m3-design.md section 2).
 * Not built yet: P2 builds it in wave 1, over the protocol package's `secretPsk`, `secretLookup`,
 * `typedPsk` and `appIdentityBytes` with `@noble/hashes`' SHA-256. Until then every derivation
 * refuses: its promise is rejected, with no argument read. None is reached while the phone makes
 * no key (`platform/keys.native.ts`), since linking makes the key first.
 */
import { NOT_BUILT_MESSAGE } from "../platform/split";
import type { Digests } from "./digest-types";
import { toHex } from "./hex";

export { toHex };

function notBuilt<T>(): Promise<T> {
  return Promise.reject(new Error(NOT_BUILT_MESSAGE));
}

export const sha256: Digests["sha256"] = () => notBuilt();
export const pskOfSecret: Digests["pskOfSecret"] = () => notBuilt();
export const lookupOfSecret: Digests["lookupOfSecret"] = () => notBuilt();
export const pskOfTypedSecret: Digests["pskOfTypedSecret"] = () => notBuilt();
export const identityOf: Digests["identityOf"] = () => notBuilt();

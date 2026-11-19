/**
 * What linking derives from a secret (m2-design.md section 5, "Linking"), the phone's side of
 * `digest.ts`: `digest-over.ts`'s derivations with the phone's own SHA-256, expo-crypto's native
 * module (the system's: CommonCrypto on iOS, `MessageDigest` on Android ‡), reached as
 * `moduleSha256` says. The design named `@noble/hashes` here; the app cannot import it without
 * adding it as a dependency (it reaches the app only inside `@hsn/protocol`), and expo-crypto is
 * already the phone's random source.
 */
import type { Digests } from "./digest-types";
import { type CryptoModule, digestsOver, moduleSha256 } from "./digest-over";
import { toHex } from "./hex";

export { toHex };

const expoCrypto = (
  globalThis as { readonly expo?: { readonly modules?: { readonly ExpoCrypto?: CryptoModule } } }
).expo?.modules?.ExpoCrypto;

export const { sha256, pskOfSecret, lookupOfSecret, pskOfTypedSecret, identityOf }: Digests =
  digestsOver(moduleSha256(expoCrypto));

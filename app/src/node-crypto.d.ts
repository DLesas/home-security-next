/**
 * `@hsn/protocol/app`'s `linking.ts` takes the type `Sha256` from `crypto/sha256.ts`, a file that
 * also imports `node:crypto` for the hub's own SHA-256. The app imports only the type, which the
 * bundle never loads, but the type check reads the file: this declares just what it uses, so the
 * app's type check needs no Node types (which would let Node's globals into the app unseen).
 */
declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: Uint8Array): { digest(): Uint8Array };
  };
}

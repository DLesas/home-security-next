/**
 * The interface of `digest.ts`'s pair, apart from it: in the phone's type check
 * (`tsconfig.native.json`) `./digest` is the phone's file.
 */

export interface Digests {
  readonly sha256: (data: Uint8Array) => Promise<Uint8Array>;
  /** A 128-bit secret's pre-shared key: SHA-256 of `hsn-link/1`, a zero byte, and the secret. */
  readonly pskOfSecret: (secret: Uint8Array) => Promise<Uint8Array>;
  /** A 128-bit secret's lookup: the first 4 bytes of SHA-256 of `hsn-find/1`, 0, the secret, as hex. */
  readonly lookupOfSecret: (secret: Uint8Array) => Promise<string>;
  /** A typed code's pre-shared key: as a 128-bit secret's, from its 5 bytes. */
  readonly pskOfTypedSecret: (secret: bigint) => Promise<Uint8Array>;
  /** The hub's app identity from its static key: 16 bytes of SHA-256, as 26 characters of base32. */
  readonly identityOf: (staticPublic: Uint8Array) => Promise<string>;
  readonly toHex: (bytes: Uint8Array) => string;
}

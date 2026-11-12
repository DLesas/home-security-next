/** A fixed P-256 key pair for the pairing vectors, and later for firmware-signature tests. */
import { createECDH } from "node:crypto";
import { fromHex } from "../../src/index.ts";

/** The private key of RFC 6979 appendix A.2.5, so the public key can be checked against it. */
export const signingPrivateKey = fromHex(
  "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721",
);

/** Section 9's 64 bytes: X then Y, big-endian, without the leading 0x04. */
export function signingPublicKey(privateKey: Uint8Array): Uint8Array {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const uncompressed = new Uint8Array(ecdh.getPublicKey(null, "uncompressed"));
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) throw new Error("unexpected key");
  return uncompressed.slice(1);
}

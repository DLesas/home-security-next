/**
 * `node:crypto` behind results, for the push role: reading the publisher's keys, signing JWTs,
 * hashing. Keys are read and used here and never leave as text; an error keeps only
 * the library's code (`safe/thrown.ts`), never its message, which could quote a key's form.
 */
import { createHash, createPrivateKey, type KeyObject, sign } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import type { PushError } from "../errors.ts";
import { errorFrom } from "./thrown.ts";

const ORIGIN = "push/safe/crypto";

/** A private key from PEM text; the text is not kept. */
export function privateKeyFromPem(pem: string, what: string): Result<KeyObject, PushError> {
  try {
    return ok(createPrivateKey({ key: pem, format: "pem" }));
  } catch (thrown) {
    return err(errorFrom("credentials", ORIGIN, `read ${what}`, thrown, "codeOnly"));
  }
}

/**
 * Signs `input` with SHA-256: ES256 as JOSE writes it (r ‖ s, 64 bytes, RFC 7518 3.4 ‡) for a
 * P-256 key, RS256 (PKCS #1 v1.5) for an RSA key.
 */
export function signSha256(
  input: Uint8Array,
  key: KeyObject,
  alg: "ES256" | "RS256",
): Result<Uint8Array, PushError> {
  try {
    const signature =
      alg === "ES256"
        ? sign("sha256", input, { key, dsaEncoding: "ieee-p1363" })
        : sign("sha256", input, key);
    return ok(new Uint8Array(signature));
  } catch (thrown) {
    return err(errorFrom("crypto", ORIGIN, `sign a JWT (${alg})`, thrown, "codeOnly"));
  }
}

/** SHA-256, for the relay identity of a proved key (`appIdentityBytes`). Does not throw on bytes. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

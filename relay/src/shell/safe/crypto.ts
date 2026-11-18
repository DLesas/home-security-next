/**
 * `node:crypto` behind results, for the relay's shell: random bytes (the pseudonym's secret, the
 * relay's own static key) and HMAC-SHA256 (the phone's pseudonym, section 3 "The peer").
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Result } from "neverthrow";
import type { RelayError } from "../errors.ts";
import { attempt } from "./attempt.ts";

const ORIGIN = "shell/safe/crypto";

export function random(bytes: number): Result<Uint8Array, RelayError> {
  return attempt("crypto", ORIGIN, "random bytes", () => new Uint8Array(randomBytes(bytes)));
}

export function hmacSha256(key: Uint8Array, text: string): Result<Uint8Array, RelayError> {
  return attempt(
    "crypto",
    ORIGIN,
    "HMAC-SHA256",
    () => new Uint8Array(createHmac("sha256", key).update(text, "utf8").digest()),
  );
}

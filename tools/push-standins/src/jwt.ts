/**
 * Reading and checking a JWT on the stand-ins' side: written apart from the push role's own
 * signing code, so a mistake in one is not repeated in the other. ES256 signatures are JOSE's
 * raw r ‖ s (64 bytes, RFC 7518 3.4 ‡), RS256 PKCS #1 v1.5 with SHA-256.
 */
import { createPublicKey, verify } from "node:crypto";
import { fail, ok, type Result } from "./result.ts";
import { attempt, parseJson } from "./safe/attempt.ts";

export interface DecodedJwt {
  readonly header: Readonly<Record<string, unknown>>;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64urlJson(part: string): Result<Readonly<Record<string, unknown>>, string> {
  if (!/^[A-Za-z0-9_-]+$/u.test(part)) return fail("not base64url");
  const parsed = parseJson(Buffer.from(part, "base64url").toString("utf8"));
  if (!parsed.ok) return fail("not JSON");
  return isRecord(parsed.value) ? ok(parsed.value) : fail("not a JSON object");
}

/** Splits and decodes a JWT; checks nothing but its form. */
export function decodeJwt(text: string): Result<DecodedJwt, string> {
  const parts = text.split(".");
  if (parts.length !== 3) return fail("not three parts");
  const [head = "", body = "", sig = ""] = parts;
  const header = base64urlJson(head);
  if (!header.ok) return fail(`header: ${header.error}`);
  const claims = base64urlJson(body);
  if (!claims.ok) return fail(`claims: ${claims.error}`);
  if (!/^[A-Za-z0-9_-]*$/u.test(sig)) return fail("signature: not base64url");
  return ok({
    header: header.value,
    claims: claims.value,
    signingInput: `${head}.${body}`,
    signature: new Uint8Array(Buffer.from(sig, "base64url")),
  });
}

/** Whether `jwt`'s signature verifies under `publicPem` with `alg`. */
export function signatureVerifies(
  jwt: DecodedJwt,
  alg: "ES256" | "RS256",
  publicPem: string,
): boolean {
  if (jwt.header.alg !== alg) return false;
  if (alg === "ES256" && jwt.signature.length !== 64) return false;
  const checked = attempt(() =>
    verify(
      "sha256",
      Buffer.from(jwt.signingInput),
      alg === "ES256"
        ? { key: createPublicKey(publicPem), dsaEncoding: "ieee-p1363" }
        : createPublicKey(publicPem),
      jwt.signature,
    ),
  );
  return checked.ok && checked.value;
}

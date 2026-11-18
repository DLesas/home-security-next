/**
 * The two JWTs, checked with the stand-ins' own reader (written apart from the signer): their
 * headers, claims and signatures, the provider token's life and its renewal's edges.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { ApnsProviderToken, googleAssertion, JWT_RULES } from "../../src/push/jwt.ts";
import { toPushOutcome } from "../../src/push/outcomes.ts";
import { decodeJwt, signatureVerifies } from "../../../tools/push-standins/src/index.ts";
import { must } from "./helpers.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0, 500);

function ec() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    key: privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

describe("the APNs provider token", () => {
  test("ES256 over {alg, kid} and {iss, iat}; iat in whole seconds", () => {
    const { key, publicPem } = ec();
    const tokens = new ApnsProviderToken({ keyId: "KEYID12345", teamId: "TEAMID1234", key });
    const text = tokens.current(T0)._unsafeUnwrap();
    const jwt = must(decodeJwt(text));
    expect(jwt.header).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(jwt.claims).toEqual({ iss: "TEAMID1234", iat: Math.floor(T0 / 1000) });
    expect(signatureVerifies(jwt, "ES256", publicPem)).toBe(true);
    expect(signatureVerifies(jwt, "ES256", ec().publicPem)).toBe(false);
    expect(tokens.issuedMs).toBe(Math.floor(T0 / 1000) * 1000);
  });

  test("kept for 40 minutes from its iat, replaced at 40", () => {
    const tokens = new ApnsProviderToken({
      keyId: "KEYID12345",
      teamId: "TEAMID1234",
      key: ec().key,
    });
    const first = tokens.current(T0)._unsafeUnwrap();
    const issued = Math.floor(T0 / 1000) * 1000;
    expect(tokens.current(issued + JWT_RULES.apnsRefreshMs - 1)._unsafeUnwrap()).toBe(first);
    const second = tokens.current(issued + JWT_RULES.apnsRefreshMs)._unsafeUnwrap();
    expect(second).not.toBe(first);
    expect(JWT_RULES.apnsRefreshMs).toBe(40 * MINUTE);
  });

  test("renewal after Apple calls it expired: refused under 20 minutes old, made at 20", () => {
    const tokens = new ApnsProviderToken({
      keyId: "KEYID12345",
      teamId: "TEAMID1234",
      key: ec().key,
    });
    const first = tokens.current(T0)._unsafeUnwrap();
    const issued = Math.floor(T0 / 1000) * 1000;
    expect(tokens.renewAfterExpired(issued + 20 * MINUTE - 1).isErr()).toBe(true);
    expect(tokens.current(issued + 20 * MINUTE - 1)._unsafeUnwrap()).toBe(first);
    const renewed = tokens.renewAfterExpired(issued + 20 * MINUTE)._unsafeUnwrap();
    expect(renewed).not.toBe(first);
    expect(tokens.current(issued + 20 * MINUTE + 1)._unsafeUnwrap()).toBe(renewed);
  });
});

describe("the Google assertion", () => {
  test("RS256 over {alg, typ, kid} and {iss, scope, aud, iat, exp = iat + 3600}", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const text = googleAssertion(
      {
        clientEmail: "sa@p.iam.gserviceaccount.com",
        privateKeyId: "kid1",
        key: privateKey,
        tokenUri: "https://oauth2.example/token",
      },
      T0,
    )._unsafeUnwrap();
    const jwt = must(decodeJwt(text));
    const iat = Math.floor(T0 / 1000);
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid1" });
    expect(jwt.claims).toEqual({
      iss: "sa@p.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.example/token",
      iat,
      exp: iat + 3600,
    });
    expect(signatureVerifies(jwt, "RS256", publicKey.export({ type: "spki", format: "pem" }))).toBe(
      true,
    );
  });
});

describe("outcomes on the link", () => {
  test("each of the design's outcomes", () => {
    expect(toPushOutcome({ kind: "delivered" })).toBe("accepted");
    expect(toPushOutcome({ kind: "tokenInvalid" })).toBe("badToken");
    expect(toPushOutcome({ kind: "retryLater", why: "rateLimited" })).toBe("limited");
    for (const why of ["unavailable", "timeout", "connection", "credentials"] as const) {
      expect(toPushOutcome({ kind: "retryLater", why })).toBe("failed");
    }
    expect(toPushOutcome({ kind: "dropped", why: "badRequest" })).toBe("failed");
  });
});

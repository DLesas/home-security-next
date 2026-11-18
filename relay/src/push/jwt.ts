/**
 * The two JWTs the push role signs (docs/m4-design.md section 5, "To Apple and Google"), with
 * `node:crypto` and no library:
 *
 * - **APNs provider token**: ES256 with the publisher's APNs key, header `{alg, kid}` (the key
 *   id), claims `{iss, iat}` (the team id, the time in seconds) ‡. Kept and reused, refreshed every
 *   40 minutes (the design's value); Apple refuses one older than an hour (`ExpiredProviderToken`)
 *   and one renewed sooner than 20 minutes after the last (`TooManyProviderTokenUpdates`) ‡.
 * - **Google OAuth assertion**: RS256 with the service account's key, header `{alg, typ, kid}`,
 *   claims `{iss, scope, aud, iat, exp}`, the scope `firebase.messaging`, the audience the token
 *   endpoint, at most an hour ‡. Exchanged for an access token (`fcm.ts`).
 *
 * A JWT is a bearer secret: it is sent and never logged.
 */
import type { KeyObject } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import { type PushError, pushError } from "./errors.ts";
import { signSha256 } from "./safe/crypto.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The JWTs' times. */
export const JWT_RULES = {
  /** A provider token is replaced this often (the design's value). */
  apnsRefreshMs: 40 * MINUTE,
  /** Apple refuses a renewal sooner than this after the last ‡. */
  apnsMinRenewMs: 20 * MINUTE,
  /** A Google assertion's life, `exp - iat`, at most ‡. */
  googleAssertionS: 3600,
  /** The scope FCM needs ‡. */
  googleScope: "https://www.googleapis.com/auth/firebase.messaging",
} as const;

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const part = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** A signed compact JWT. */
export function signJwt(
  header: Readonly<Record<string, string>>,
  claims: Readonly<Record<string, string | number>>,
  key: KeyObject,
  alg: "ES256" | "RS256",
): Result<string, PushError> {
  const input = `${part({ ...header, alg })}.${part(claims)}`;
  return signSha256(new TextEncoder().encode(input), key, alg).map(
    (signature) => `${input}.${base64url(signature)}`,
  );
}

export interface ApnsSigner {
  /** Ten characters, from the Apple account ‡. */
  readonly teamId: string;
  /** Ten characters, the APNs key's id ‡. */
  readonly keyId: string;
  /** The APNs key, P-256. */
  readonly key: KeyObject;
}

/** The provider token, made when needed and kept for `apnsRefreshMs`. */
export class ApnsProviderToken {
  private token: { readonly text: string; readonly issuedMs: number } | undefined;

  constructor(private readonly signer: ApnsSigner) {}

  private make(nowMs: number): Result<string, PushError> {
    const iat = Math.floor(nowMs / SECOND);
    return signJwt(
      { kid: this.signer.keyId },
      { iss: this.signer.teamId, iat },
      this.signer.key,
      "ES256",
    ).map((text) => {
      this.token = { text, issuedMs: iat * SECOND };
      return text;
    });
  }

  /** The token to send now: the kept one, or a new one when it is 40 minutes old or there is none. */
  current(nowMs: number): Result<string, PushError> {
    const token = this.token;
    if (token !== undefined && nowMs - token.issuedMs < JWT_RULES.apnsRefreshMs) {
      return ok(token.text);
    }
    return this.make(nowMs);
  }

  /**
   * Apple answered `ExpiredProviderToken`: a new token, unless the kept one is younger than
   * Apple's 20 minutes, in which case renewing would be refused too and the clocks disagree.
   */
  renewAfterExpired(nowMs: number): Result<string, PushError> {
    const token = this.token;
    if (token !== undefined && nowMs - token.issuedMs < JWT_RULES.apnsMinRenewMs) {
      return err(
        pushError(
          "credentials",
          "push/jwt",
          "APNs called a provider token expired that is less than 20 minutes old: check this host's clock",
        ),
      );
    }
    return this.make(nowMs);
  }

  /** When the kept token was made, for tests and the log. */
  get issuedMs(): number | undefined {
    return this.token?.issuedMs;
  }
}

export interface GoogleAccount {
  readonly clientEmail: string;
  readonly privateKeyId: string;
  readonly key: KeyObject;
  /** The token endpoint, from the service account file; also the assertion's audience ‡. */
  readonly tokenUri: string;
}

/** A fresh OAuth assertion for the token endpoint. */
export function googleAssertion(account: GoogleAccount, nowMs: number): Result<string, PushError> {
  const iat = Math.floor(nowMs / SECOND);
  return signJwt(
    { typ: "JWT", kid: account.privateKeyId },
    {
      iss: account.clientEmail,
      scope: JWT_RULES.googleScope,
      aud: account.tokenUri,
      iat,
      exp: iat + JWT_RULES.googleAssertionS,
    },
    account.key,
    "RS256",
  );
}

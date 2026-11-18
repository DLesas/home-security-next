/**
 * The FCM sender (docs/m4-design.md section 5, "To Apple and Google"): Google's HTTP v1 send
 * with an OAuth access token from the service account (`fetch`, no library).
 *
 * - **The request** ‡: `POST <origin>/v1/projects/<project>/messages:send`, `Authorization: Bearer
 *   <access token>`, body `{"message": {"token": "…", "data": {"h": "…"}, "android": {"priority":
 *   "HIGH", "ttl": "86400s"}}}`: data only, so the app's own code runs before anything is shown.
 * - **The access token** comes from the service account's `token_uri` for a signed assertion
 *   (`jwt.ts`), is kept until 5 minutes ‡ before its `expires_in`, is fetched once for any number
 *   of pushes waiting on it, and after a 401 is fetched again and the push sent once more.
 * - **Google's `Retry-After`** on 429 and 503 pauses every send for that long ‡: pushes meanwhile
 *   are `retryLater` without asking Google.
 * - Every failure is an outcome (`outcomes.ts`); nothing here throws or rejects. The access token
 *   is a bearer secret: sent, never logged.
 */
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { FcmAccount } from "./credentials.ts";
import { type PushError, pushError } from "./errors.ts";
import { googleAssertion } from "./jwt.ts";
import type { PushLog } from "./log.ts";
import {
  fcmOutcome,
  googleErrorParts,
  retryAfterMs,
  retryLater,
  type ServiceOutcome,
} from "./outcomes.ts";
import { fetchText } from "./safe/fetch.ts";
import { parseJson } from "./safe/json.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Google's FCM service ‡. */
export const FCM_ORIGIN = "https://fcm.googleapis.com";

/** The sender's own values ‡. */
export const FCM_RULES = {
  requestTimeoutMs: 10 * SECOND,
  tokenTimeoutMs: 10 * SECOND,
  /** An access token is replaced this long before Google says it expires. */
  refreshMarginMs: 5 * MINUTE,
  /** How long Google keeps trying an absent phone: the design's 24 hours ‡. */
  ttl: "86400s",
  grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
} as const;

/** The body of one push. */
export function fcmBody(token: string, h: string): string {
  return JSON.stringify({
    message: { token, data: { h }, android: { priority: "HIGH", ttl: FCM_RULES.ttl } },
  });
}

export interface FcmSettings {
  readonly account: FcmAccount;
  readonly origin: string;
  /** A certificate authority to trust instead of the system's: the stand-in's (tests only). */
  readonly ca?: string;
  readonly now: () => number;
  readonly log: PushLog;
  /** `FCM_RULES.requestTimeoutMs` and `tokenTimeoutMs` unless given (tests). */
  readonly timeoutMs?: number;
}

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().regex(/^bearer$/iu),
});

const ORIGIN = "push/fcm";

/** The access token: kept, renewed before it expires, fetched once for every push waiting on it. */
export class GoogleAccessToken {
  private token: { readonly text: string; readonly expiresMs: number } | undefined;
  private pending: Promise<Result<string, PushError>> | undefined;

  constructor(private readonly settings: FcmSettings) {}

  current(): Promise<Result<string, PushError>> {
    const token = this.token;
    if (token !== undefined && this.settings.now() < token.expiresMs - FCM_RULES.refreshMarginMs) {
      return Promise.resolve(ok(token.text));
    }
    this.pending ??= this.fetch().then((result) => {
      this.pending = undefined;
      return result;
    });
    return this.pending;
  }

  /** Google refused `text`: forget it, so the next push fetches another. */
  invalidate(text: string): void {
    if (this.token?.text === text) this.token = undefined;
  }

  private async fetch(): Promise<Result<string, PushError>> {
    const { account, now, log } = this.settings;
    const startedMs = now();
    const assertion = googleAssertion(account, startedMs);
    if (assertion.isErr()) return err(assertion.error);
    const answer = await fetchText(account.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: FCM_RULES.grantType,
        assertion: assertion.value,
      }).toString(),
      timeoutMs: this.settings.timeoutMs ?? FCM_RULES.tokenTimeoutMs,
      ...(this.settings.ca === undefined ? {} : { ca: this.settings.ca }),
    });
    if (answer.isErr()) {
      return err(
        pushError("service", ORIGIN, "reach Google's token endpoint", { why: answer.error.kind }),
      );
    }
    if (answer.value.status !== 200) {
      return err(
        pushError("credentials", ORIGIN, "Google's token endpoint refused the service account", {
          status: answer.value.status,
        }),
      );
    }
    const parsed = parseJson(answer.value.body, "service", ORIGIN, "the token endpoint's answer")
      .map((json) => tokenAnswer.safeParse(json))
      .andThen((result) =>
        result.success
          ? ok(result.data)
          : err(pushError("service", ORIGIN, "the token endpoint's answer has no access token")),
      );
    if (parsed.isErr()) return err(parsed.error);
    this.token = {
      text: parsed.value.access_token,
      expiresMs: startedMs + parsed.value.expires_in * SECOND,
    };
    log.write("info", "credentialsRenewed", { service: "fcm", lifetimeS: parsed.value.expires_in });
    return ok(parsed.value.access_token);
  }
}

export interface FcmTarget {
  readonly token: string;
  readonly h: string;
}

export class FcmClient {
  private readonly tokens: GoogleAccessToken;
  private pausedUntilMs = 0;
  private readonly url: string;

  constructor(private readonly settings: FcmSettings) {
    this.tokens = new GoogleAccessToken(settings);
    this.url = `${settings.origin}/v1/projects/${settings.account.projectId}/messages:send`;
  }

  /** Sends one push and resolves with what Google's answer means. Never rejects. */
  async send(target: FcmTarget): Promise<ServiceOutcome> {
    const { now, log } = this.settings;
    if (now() < this.pausedUntilMs) return retryLater("rateLimited");
    for (let attempt = 0; ; attempt += 1) {
      const access = await this.tokens.current();
      if (access.isErr()) {
        log.write("error", "credentialsFailed", { service: "fcm" }, access.error);
        return retryLater("credentials");
      }
      const answer = await fetchText(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${access.value}`,
          "content-type": "application/json; charset=UTF-8",
        },
        body: fcmBody(target.token, target.h),
        timeoutMs: this.settings.timeoutMs ?? FCM_RULES.requestTimeoutMs,
        ...(this.settings.ca === undefined ? {} : { ca: this.settings.ca }),
      });
      if (answer.isErr()) {
        return retryLater(answer.error.kind === "timeout" ? "timeout" : "connection");
      }
      const { status, headers, body } = answer.value;
      if (status === 401 && attempt === 0) {
        this.tokens.invalidate(access.value);
        continue;
      }
      if (status === 429 || status === 503) {
        const wait = retryAfterMs(headers.get("retry-after"), now());
        if (wait !== undefined) this.pausedUntilMs = now() + wait;
      }
      if (status === 401 || status === 403) {
        log.write("error", "credentialsFailed", { service: "fcm", status });
      }
      const parts =
        status === 200
          ? { fcmCode: undefined, badFields: [] }
          : googleErrorParts(
              parseJson(body, "service", ORIGIN, "FCM's answer").unwrapOr(undefined),
            );
      return fcmOutcome(status, parts);
    }
  }
}

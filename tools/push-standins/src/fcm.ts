/**
 * A stand-in for Google's FCM HTTP v1 service and its OAuth token endpoint, on loopback over TLS
 * with a certificate made for the test. The token endpoint checks the service account's RS256
 * assertion against a test key and hands out bearer tokens; the send endpoint checks the bearer
 * and the message as Google documents them ‡, and answers as scripted, with Google's error shapes
 * ‡. Everything received is recorded. What it imitates and what it does not is in this
 * workspace's README.
 */
import { randomBytes } from "node:crypto";
import { decodeJwt, type DecodedJwt, signatureVerifies } from "./jwt.ts";
import { fail, ok, type Result } from "./result.ts";
import { attempt, parseJson } from "./safe/attempt.ts";

const SECOND = 1000;

/** The facts the stand-in checks, as Google documents them ‡. */
export const FCM_FACTS = {
  grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
  scope: "https://www.googleapis.com/auth/firebase.messaging",
  /** An assertion's `exp - iat`, at most ‡. */
  maxAssertionLifetimeS: 3600,
  /** An access token's life, as the token endpoint states it in `expires_in` ‡. */
  accessTokenLifetimeS: 3599,
  /** A data message's `data`, at most ‡. */
  maxDataBytes: 4096,
  /** A registration token's form: the stand-in's own approximation of real tokens ‡. */
  token: /^[A-Za-z0-9_:-]{20,4096}$/u,
  /** `android.priority` values ‡. */
  priorities: ["NORMAL", "HIGH"],
  /** `android.ttl`: a duration in seconds, as protobuf's JSON writes it ‡. */
  ttl: /^\d+(\.\d{1,9})?s$/u,
} as const;

/** One send request as received. */
export interface FcmReceived {
  readonly atMs: number;
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: string;
  /** The body, when it was JSON. */
  readonly json: unknown;
  /** `message.token`, when present. */
  readonly token: string | undefined;
  /** Set once the stand-in has answered: the status, or how it did not. */
  answered: number | "stalled" | "dropped" | undefined;
}

/** One token request as received. */
export interface FcmTokenRequest {
  readonly atMs: number;
  readonly grantType: string | null;
  /** The assertion as sent, and decoded when it could be. */
  readonly assertionText: string | null;
  readonly assertion: DecodedJwt | undefined;
  answered: number | "stalled" | undefined;
}

/** A scripted answer for a send that passed every check. */
export type FcmScript =
  | {
      readonly kind: "error";
      readonly status: number;
      /** google.rpc's status name: `QUOTA_EXCEEDED`'s HTTP 429 is `RESOURCE_EXHAUSTED` ‡. */
      readonly errorStatus: string;
      /** FCM's own code in the details, if any: `UNREGISTERED`, `QUOTA_EXCEEDED`, `UNAVAILABLE`, `INTERNAL`. */
      readonly fcmCode?: string;
      readonly retryAfterS?: number;
    }
  | { readonly kind: "stall" }
  /** Close every connection without answering: a connection lost mid-request. */
  | { readonly kind: "drop" };

export interface FcmStandInOptions {
  readonly tls: { readonly key: string; readonly cert: string };
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyId: string;
  /** The service account key's public half, SPKI PEM. */
  readonly publicKeyPem: string;
  /** `expires_in` of each access token; `FCM_FACTS.accessTokenLifetimeS` when not given. */
  readonly accessTokenLifetimeS?: number;
  readonly now?: () => number;
  /** Called for each send that passed every check; `undefined` answers 200. */
  readonly script?: (request: FcmReceived) => FcmScript | undefined;
  /** Called for each token request that passed every check: `stall`, or `refuse` (400 `invalid_grant`). */
  readonly tokenScript?: (request: FcmTokenRequest) => "stall" | "refuse" | undefined;
}

export interface FcmStandIn {
  readonly origin: string;
  /** `<origin>/token`, for the service account file's `token_uri`. */
  readonly tokenUri: string;
  readonly received: readonly FcmReceived[];
  readonly tokenRequests: readonly FcmTokenRequest[];
  /** Access tokens handed out so far. */
  readonly issued: readonly string[];
  /** From now on, `token` answers 404 `UNREGISTERED`. */
  unregister(token: string): void;
  /** Forgets every access token handed out, so each answers 401 from now on. */
  revokeAccessTokens(): void;
  /** Closes every open connection and listens again on the same port. */
  dropConnections(): void;
  close(): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8" };

function googleError(
  code: number,
  status: string,
  message: string,
  details: readonly unknown[] = [],
  retryAfterS?: number,
): Response {
  return new Response(JSON.stringify({ error: { code, message, status, details } }), {
    status: code,
    headers:
      retryAfterS === undefined
        ? JSON_HEADERS
        : { ...JSON_HEADERS, "retry-after": String(retryAfterS) },
  });
}

const fcmError = (errorCode: string) => ({
  "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
  errorCode,
});

const badField = (field: string, description: string) => ({
  "@type": "type.googleapis.com/google.rpc.BadRequest",
  fieldViolations: [{ field, description }],
});

const invalid = (field: string, description: string) =>
  googleError(400, "INVALID_ARGUMENT", description, [
    fcmError("INVALID_ARGUMENT"),
    badField(field, description),
  ]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Google's answer for a send's message, or undefined when it passes ‡. */
function checkMessage(json: unknown, unregistered: ReadonlySet<string>): Response | undefined {
  const message = isRecord(json) ? json.message : undefined;
  if (!isRecord(message))
    return googleError(400, "INVALID_ARGUMENT", "Request contains an invalid argument.");
  const token = message.token;
  if (typeof token !== "string" || !FCM_FACTS.token.test(token)) {
    return invalid("message.token", "Invalid registration token");
  }
  const data = message.data;
  if (data !== undefined) {
    if (!isRecord(data) || !Object.values(data).every((v) => typeof v === "string")) {
      return invalid("message.data", "Invalid value: every data value is a string");
    }
    const bytes = Object.entries(data).reduce(
      (n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)),
      0,
    );
    if (bytes > FCM_FACTS.maxDataBytes) return invalid("message.data", "Message is too big");
  }
  const android = message.android;
  if (android !== undefined) {
    if (!isRecord(android)) return invalid("message.android", "Invalid value");
    const priority = android.priority;
    if (priority !== undefined && !FCM_FACTS.priorities.some((p) => p === priority)) {
      return invalid("message.android.priority", "Invalid value");
    }
    const ttl = android.ttl;
    if (ttl !== undefined && (typeof ttl !== "string" || !FCM_FACTS.ttl.test(ttl))) {
      return invalid("message.android.ttl", "Invalid duration");
    }
  }
  if (unregistered.has(token)) {
    return googleError(404, "NOT_FOUND", "Requested entity was not found.", [
      fcmError("UNREGISTERED"),
    ]);
  }
  return undefined;
}

/** Starts the stand-in on 127.0.0.1 and a free port. */
export function startFcmStandIn(options: FcmStandInOptions): Result<FcmStandIn, string> {
  const now = options.now ?? Date.now;
  const received: FcmReceived[] = [];
  const tokenRequests: FcmTokenRequest[] = [];
  const issued: string[] = [];
  const accessTokens = new Map<string, number>();
  const unregistered = new Set<string>();
  const stalled: (() => void)[] = [];
  const sendPath = `/v1/projects/${options.projectId}/messages:send`;
  let origin = "";
  let messages = 0;

  const unstall = () => {
    for (const release of stalled.splice(0)) release();
  };
  const stall = () =>
    new Promise<Response>((resolve) => {
      stalled.push(() => {
        resolve(new Response(null, { status: 503 }));
      });
    });

  async function token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const assertion = form.get("assertion");
    const decoded = assertion === null ? undefined : decodeJwt(assertion);
    const record: FcmTokenRequest = {
      atMs: now(),
      grantType: form.get("grant_type"),
      assertionText: assertion,
      assertion: decoded?.ok === true ? decoded.value : undefined,
      answered: undefined,
    };
    tokenRequests.push(record);
    const refuse = (description: string) => {
      record.answered = 400;
      return new Response(
        JSON.stringify({ error: "invalid_grant", error_description: description }),
        {
          status: 400,
          headers: JSON_HEADERS,
        },
      );
    };
    if (request.method !== "POST") return refuse("Bad request.");
    if (record.grantType !== FCM_FACTS.grantType) return refuse("Invalid grant_type.");
    const jwt = record.assertion;
    if (jwt === undefined || !signatureVerifies(jwt, "RS256", options.publicKeyPem)) {
      return refuse("Invalid JWT Signature.");
    }
    const { iss, scope, aud, iat, exp } = jwt.claims;
    const kid = jwt.header.kid;
    const nowS = record.atMs / SECOND;
    if (kid !== undefined && kid !== options.privateKeyId) return refuse("Invalid JWT Signature.");
    if (iss !== options.clientEmail) return refuse("Invalid issuer.");
    if (typeof scope !== "string" || !scope.split(" ").includes(FCM_FACTS.scope)) {
      return refuse("Invalid OAuth scope or ID token audience provided.");
    }
    if (aud !== `${origin}/token`) return refuse("Invalid JWT audience.");
    if (typeof iat !== "number" || typeof exp !== "number") return refuse("Invalid JWT.");
    if (exp - iat > FCM_FACTS.maxAssertionLifetimeS || iat > nowS + 60 || exp <= nowS) {
      return refuse(
        "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.",
      );
    }
    const scripted = options.tokenScript?.(record);
    if (scripted === "stall") {
      record.answered = "stalled";
      return stall();
    }
    if (scripted === "refuse") return refuse("Invalid grant: account not found");
    const lifetimeS = options.accessTokenLifetimeS ?? FCM_FACTS.accessTokenLifetimeS;
    const access = `ya29.standin-${randomBytes(24).toString("base64url")}`;
    accessTokens.set(access, record.atMs + lifetimeS * SECOND);
    issued.push(access);
    record.answered = 200;
    return new Response(
      JSON.stringify({ access_token: access, expires_in: lifetimeS, token_type: "Bearer" }),
      { status: 200, headers: JSON_HEADERS },
    );
  }

  async function send(request: Request, path: string): Promise<Response> {
    const body = await request.text();
    const parsed = parseJson(body);
    const json = parsed.ok ? parsed.value : undefined;
    const message = isRecord(json) ? json.message : undefined;
    const tokenValue = isRecord(message) ? message.token : undefined;
    const record: FcmReceived = {
      atMs: now(),
      method: request.method,
      path,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body,
      json,
      token: typeof tokenValue === "string" ? tokenValue : undefined,
      answered: undefined,
    };
    received.push(record);
    const answer = (response: Response) => {
      record.answered = response.status;
      return response;
    };
    if (request.method !== "POST" || path !== sendPath) {
      return answer(googleError(404, "NOT_FOUND", "Requested entity was not found."));
    }
    const bearer = /^Bearer (.+)$/u.exec(record.authorization ?? "")?.[1];
    const expires = bearer === undefined ? undefined : accessTokens.get(bearer);
    if (expires === undefined || expires <= record.atMs) {
      return answer(
        googleError(
          401,
          "UNAUTHENTICATED",
          "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
        ),
      );
    }
    if (!parsed.ok) {
      return answer(googleError(400, "INVALID_ARGUMENT", "Invalid JSON payload received."));
    }
    const refusal = checkMessage(json, unregistered);
    if (refusal !== undefined) return answer(refusal);
    const scripted = options.script?.(record);
    if (scripted?.kind === "stall") {
      record.answered = "stalled";
      return stall();
    }
    if (scripted?.kind === "drop") {
      record.answered = "dropped";
      queueMicrotask(() => {
        handle.dropConnections();
      });
      return stall();
    }
    if (scripted?.kind === "error") {
      const details = scripted.fcmCode === undefined ? [] : [fcmError(scripted.fcmCode)];
      return answer(
        googleError(
          scripted.status,
          scripted.errorStatus,
          "Scripted error.",
          details,
          scripted.retryAfterS,
        ),
      );
    }
    messages += 1;
    return answer(
      new Response(
        JSON.stringify({ name: `projects/${options.projectId}/messages/0:${messages}%standin` }),
        { status: 200, headers: JSON_HEADERS },
      ),
    );
  }

  const serve = (port: number) =>
    attempt(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        tls: { key: options.tls.key, cert: options.tls.cert },
        fetch(request) {
          const path = new URL(request.url).pathname;
          return path === "/token" ? token(request) : send(request, path);
        },
      }),
    );

  const first = serve(0);
  if (!first.ok) return fail(`listen: ${first.error}`);
  let server = first.value;
  const port = server.port ?? 0;
  origin = `https://127.0.0.1:${port}`;

  const handle: FcmStandIn = {
    origin,
    tokenUri: `${origin}/token`,
    received,
    tokenRequests,
    issued,
    unregister(t: string) {
      unregistered.add(t);
    },
    revokeAccessTokens() {
      accessTokens.clear();
    },
    dropConnections() {
      void server.stop(true);
      unstall();
      const again = serve(port);
      if (again.ok) server = again.value;
    },
    async close() {
      unstall();
      await server.stop(true);
    },
  };
  return ok(handle);
}

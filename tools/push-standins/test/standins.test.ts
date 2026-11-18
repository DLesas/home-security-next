/**
 * The stand-ins themselves, driven by hand-made requests: each check answers as the README says,
 * scripts and recordings work, and a JWT signed with the wrong key is refused. The push role's
 * own clients are tested against them in relay/test/push/.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import http2 from "node:http2";
import {
  type ApnsScript,
  type ApnsStandIn,
  type ApnsTestKey,
  type FcmScript,
  type FcmStandIn,
  type FcmTestAccount,
  type LoopbackTls,
  loopbackTls,
  makeApnsTestKey,
  makeFcmTestAccount,
  startApnsStandIn,
  startFcmStandIn,
} from "../src/index.ts";

const TOPIC = "invalid.hsn.app";
const TOKEN = "ab".repeat(32);

function must<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) expect(result.error).toBe("no error");
  return (result as { value: T }).value;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function es256(
  key: ApnsTestKey,
  claims: Record<string, unknown>,
  kid = key.keyId,
  pem = key.privatePem,
): string {
  const input = `${b64({ alg: "ES256", kid })}.${b64(claims)}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: createPrivateKey(pem),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

function rs256(
  account: FcmTestAccount,
  claims: Record<string, unknown>,
  pem = account.privatePem,
): string {
  const input = `${b64({ alg: "RS256", typ: "JWT", kid: account.privateKeyId })}.${b64(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), createPrivateKey(pem)).toString("base64url")}`;
}

let tls: LoopbackTls;
let apnsKey: ApnsTestKey;
let account: FcmTestAccount;
let nowMs = Date.UTC(2026, 10, 18, 12);
const open: { close(): Promise<void> }[] = [];

beforeAll(() => {
  tls = must(loopbackTls(Date.now()));
  apnsKey = must(makeApnsTestKey());
  account = must(makeFcmTestAccount());
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  nowMs = Date.UTC(2026, 10, 18, 12);
});

async function apns(script?: (n: number) => ApnsScript | undefined): Promise<ApnsStandIn> {
  let n = 0;
  const standIn = must(
    await startApnsStandIn({
      tls,
      keyId: apnsKey.keyId,
      teamId: apnsKey.teamId,
      publicKeyPem: apnsKey.publicPem,
      topic: TOPIC,
      now: () => nowMs,
      ...(script === undefined ? {} : { script: () => script(++n) }),
    }),
  );
  open.push(standIn);
  return standIn;
}

interface Answer {
  status: number | string;
  reason?: string;
  body: string;
  headers: http2.IncomingHttpHeaders;
}

function post(
  origin: string,
  headers: Record<string, string>,
  body: string,
  path = `/3/device/${TOKEN}`,
  method = "POST",
): Promise<Answer> {
  return new Promise((resolve) => {
    const session = http2.connect(origin, { ca: tls.cert });
    session.on("error", () => undefined);
    const request = session.request({ ":method": method, ":path": path, ...headers });
    let got: http2.IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      session.destroy();
      resolve({ status: "timeout", body: "", headers: {} });
    }, 400);
    request.on("response", (h) => (got = h));
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("error", () => undefined);
    request.on("close", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString();
      const reason = text === "" ? undefined : (JSON.parse(text) as { reason?: string }).reason;
      session.close();
      resolve({
        status: Number(got[":status"] ?? Number.NaN) || `closed ${request.rstCode}`,
        ...(reason === undefined ? {} : { reason }),
        body: text,
        headers: got,
      });
    });
    request.end(body);
  });
}

/** One token per `iat`: ES256 signatures differ each time, and a new token counts as an update. */
const tokens = new Map<number, string>();
function providerToken(): string {
  const iat = Math.floor(nowMs / 1000);
  const made = tokens.get(iat) ?? es256(apnsKey, { iss: apnsKey.teamId, iat });
  tokens.set(iat, made);
  return made;
}
/** Headers without one of them. */
function without(headers: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
}

const good = () => ({
  authorization: `bearer ${providerToken()}`,
  "apns-topic": TOPIC,
  "apns-push-type": "alert",
  "apns-priority": "10",
  "apns-expiration": "0",
});
const BODY = JSON.stringify({ aps: { alert: { "loc-key": "push.placeholder" } }, h: "x" });

describe("the APNs stand-in", () => {
  test("accepts a well-formed push, answers apns-id, records it", async () => {
    const s = await apns();
    const answer = await post(s.origin, good(), BODY);
    expect(answer.status).toBe(200);
    expect(typeof answer.headers["apns-id"]).toBe("string");
    expect(s.received).toHaveLength(1);
    expect(s.received[0]?.deviceToken).toBe(TOKEN);
    expect(s.received[0]?.headers["apns-topic"]).toBe(TOPIC);
    expect(s.received[0]?.headers.authorization).toBeUndefined();
    expect(s.received[0]?.jwt?.claims.iss).toBe(apnsKey.teamId);
    expect(s.received[0]?.answered).toEqual({ kind: "status", status: 200 });
  });

  const refusals: [
    string,
    (h: Record<string, string>) => Record<string, string>,
    number,
    string,
  ][] = [
    ["no token", (h) => without(h, "authorization"), 403, "MissingProviderToken"],
    [
      "a wrong key",
      (h) => ({
        ...h,
        authorization: `bearer ${es256(apnsKey, { iss: apnsKey.teamId, iat: Math.floor(nowMs / 1000) }, apnsKey.keyId, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }))}`,
      }),
      403,
      "InvalidProviderToken",
    ],
    [
      "a wrong kid",
      (h) => ({
        ...h,
        authorization: `bearer ${es256(apnsKey, { iss: apnsKey.teamId, iat: Math.floor(nowMs / 1000) }, "ZZZZZZZZZZ")}`,
      }),
      403,
      "InvalidProviderToken",
    ],
    [
      "a wrong team",
      (h) => ({
        ...h,
        authorization: `bearer ${es256(apnsKey, { iss: "ZZZZZZZZZZ", iat: Math.floor(nowMs / 1000) })}`,
      }),
      403,
      "InvalidProviderToken",
    ],
    [
      "an hour and a second old",
      (h) => ({
        ...h,
        authorization: `bearer ${es256(apnsKey, { iss: apnsKey.teamId, iat: Math.floor(nowMs / 1000) - 3601 })}`,
      }),
      403,
      "ExpiredProviderToken",
    ],
    ["no topic", (h) => without(h, "apns-topic"), 400, "MissingTopic"],
    ["another topic", (h) => ({ ...h, "apns-topic": "other.app" }), 400, "BadTopic"],
    ["no push type", (h) => without(h, "apns-push-type"), 400, "InvalidPushType"],
    ["priority 7", (h) => ({ ...h, "apns-priority": "7" }), 400, "BadPriority"],
    ["a bad expiration", (h) => ({ ...h, "apns-expiration": "soon" }), 400, "BadExpirationDate"],
    ["a bad apns-id", (h) => ({ ...h, "apns-id": "nope" }), 400, "BadMessageId"],
  ];
  for (const [what, change, status, reason] of refusals) {
    test(`refuses ${what}: ${status} ${reason}`, async () => {
      const s = await apns();
      const answer = await post(s.origin, change(good()), BODY);
      expect([answer.status, answer.reason]).toEqual([status, reason]);
    });
  }

  test("an hour-old token is still accepted", async () => {
    const s = await apns();
    const h = {
      ...good(),
      authorization: `bearer ${es256(apnsKey, { iss: apnsKey.teamId, iat: Math.floor(nowMs / 1000) - 3600 })}`,
    };
    expect((await post(s.origin, h, BODY)).status).toBe(200);
  });

  test("refuses a new token sooner than 20 minutes after the last, accepts one at 20", async () => {
    const s = await apns();
    expect((await post(s.origin, good(), BODY)).status).toBe(200);
    nowMs += 20 * 60_000 - 1000;
    expect(await post(s.origin, good(), BODY)).toMatchObject({
      status: 429,
      reason: "TooManyProviderTokenUpdates",
    });
    nowMs += 1000;
    expect((await post(s.origin, good(), BODY)).status).toBe(200);
  });

  test("checks the token, the path, the method and the body", async () => {
    const s = await apns();
    expect(await post(s.origin, good(), BODY, "/3/device/xyz")).toMatchObject({
      status: 400,
      reason: "BadDeviceToken",
    });
    expect(await post(s.origin, good(), BODY, "/3/other")).toMatchObject({
      status: 404,
      reason: "BadPath",
    });
    expect(await post(s.origin, good(), "", undefined, "PUT")).toMatchObject({
      status: 405,
      reason: "MethodNotAllowed",
    });
    expect(await post(s.origin, good(), "")).toMatchObject({ status: 400, reason: "PayloadEmpty" });
    expect(await post(s.origin, good(), "{}")).toMatchObject({
      status: 400,
      reason: "StandInBadPayload",
    });
    const big = JSON.stringify({ aps: {}, h: "x".repeat(4096 - 17) });
    expect(Buffer.byteLength(big)).toBe(4096);
    expect((await post(s.origin, good(), big)).status).toBe(200);
    const over = JSON.stringify({ aps: {}, h: "x".repeat(4096 - 16) });
    expect(await post(s.origin, good(), over)).toMatchObject({
      status: 413,
      reason: "PayloadTooLarge",
    });
  });

  test("an unregistered token answers 410 with its time", async () => {
    const s = await apns();
    s.unregister(TOKEN);
    const answer = await post(s.origin, good(), BODY);
    expect(answer.status).toBe(410);
    expect(JSON.parse(answer.body)).toEqual({ reason: "Unregistered", timestamp: nowMs });
  });

  test("scripts: a status, a stall, a reset, a drop", async () => {
    const scripts: ApnsScript[] = [
      { kind: "status", status: 429, reason: "TooManyRequests" },
      { kind: "status", status: 500, reason: "InternalServerError" },
      { kind: "stall" },
      { kind: "reset" },
      { kind: "drop" },
    ];
    const s = await apns((n) => scripts[n - 1]);
    expect(await post(s.origin, good(), BODY)).toMatchObject({
      status: 429,
      reason: "TooManyRequests",
    });
    expect(await post(s.origin, good(), BODY)).toMatchObject({
      status: 500,
      reason: "InternalServerError",
    });
    expect((await post(s.origin, good(), BODY)).status).toBe("timeout");
    expect(String((await post(s.origin, good(), BODY)).status)).toStartWith("closed");
    expect(String((await post(s.origin, good(), BODY)).status)).toStartWith("closed");
    expect(s.received.map((r) => r.answered?.kind)).toEqual([
      "status",
      "status",
      "stalled",
      "reset",
      "dropped",
    ]);
  });
});

function fcm(script?: (n: number) => FcmScript | undefined): Promise<FcmStandIn> {
  let n = 0;
  const standIn = must(
    startFcmStandIn({
      tls,
      projectId: account.projectId,
      clientEmail: account.clientEmail,
      privateKeyId: account.privateKeyId,
      publicKeyPem: account.publicPem,
      now: () => nowMs,
      ...(script === undefined ? {} : { script: () => script(++n) }),
    }),
  );
  open.push(standIn);
  return Promise.resolve(standIn);
}

async function accessToken(s: FcmStandIn, claims?: Record<string, unknown>): Promise<Response> {
  const iat = Math.floor(nowMs / 1000);
  const assertion = rs256(
    account,
    claims ?? {
      iss: account.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: s.tokenUri,
      iat,
      exp: iat + 3600,
    },
  );
  return fetch(s.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    tls: { ca: tls.cert },
  });
}

function sendFcm(s: FcmStandIn, bearer: string, message: unknown): Promise<Response> {
  return fetch(`${s.origin}/v1/projects/${account.projectId}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ message }),
    tls: { ca: tls.cert },
  });
}

const FCM_TOKEN = "fcm-token-".padEnd(40, "x");
const MESSAGE = {
  token: FCM_TOKEN,
  data: { h: "x" },
  android: { priority: "HIGH", ttl: "86400s" },
};

describe("the FCM stand-in", () => {
  test("hands out a token for a good assertion and accepts a send with it", async () => {
    const s = await fcm();
    const answer = await accessToken(s);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3599);
    const sent = await sendFcm(s, body.access_token, MESSAGE);
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { name: string }).name).toStartWith(
      `projects/${account.projectId}/messages/`,
    );
    expect(s.received[0]?.token).toBe(FCM_TOKEN);
  });

  test("refuses an assertion with the wrong key, scope, audience or lifetime", async () => {
    const s = await fcm();
    const iat = Math.floor(nowMs / 1000);
    const base = {
      iss: account.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: s.tokenUri,
      iat,
      exp: iat + 3600,
    };
    for (const claims of [
      { ...base, scope: "https://www.googleapis.com/auth/cloud-platform.read-only" },
      { ...base, aud: "https://oauth2.googleapis.com/token" },
      { ...base, exp: iat + 3601 },
      { ...base, iss: "someone@else" },
      { ...base, exp: iat - 1, iat: iat - 100 },
    ]) {
      const answer = await accessToken(s, claims);
      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { error: string }).error).toBe("invalid_grant");
    }
    const wrongKey = rs256(
      account,
      base,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    );
    const answer = await fetch(s.tokenUri, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: wrongKey,
      }).toString(),
      tls: { ca: tls.cert },
    });
    expect(answer.status).toBe(400);
  });

  test("answers Google's error shapes", async () => {
    const s = await fcm();
    expect((await sendFcm(s, "nope", MESSAGE)).status).toBe(401);
    const access = ((await (await accessToken(s)).json()) as { access_token: string }).access_token;
    const badToken = await sendFcm(s, access, { ...MESSAGE, token: "not a token" });
    expect(badToken.status).toBe(400);
    expect(await badToken.json()).toMatchObject({
      error: {
        status: "INVALID_ARGUMENT",
        details: [
          { errorCode: "INVALID_ARGUMENT" },
          { fieldViolations: [{ field: "message.token" }] },
        ],
      },
    });
    expect((await sendFcm(s, access, { ...MESSAGE, data: { h: 1 } })).status).toBe(400);
    expect((await sendFcm(s, access, { ...MESSAGE, data: { h: "x".repeat(4095) } })).status).toBe(
      200,
    );
    expect((await sendFcm(s, access, { ...MESSAGE, data: { h: "x".repeat(4096) } })).status).toBe(
      400,
    );
    expect((await sendFcm(s, access, { ...MESSAGE, android: { priority: "URGENT" } })).status).toBe(
      400,
    );
    s.unregister(FCM_TOKEN);
    const gone = await sendFcm(s, access, MESSAGE);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({
      error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] },
    });
    s.revokeAccessTokens();
    expect(
      (await sendFcm(s, access, { ...MESSAGE, token: "another-token-".padEnd(30, "y") })).status,
    ).toBe(401);
  });

  test("an access token expires at its expires_in", async () => {
    const s = await fcm();
    const access = ((await (await accessToken(s)).json()) as { access_token: string }).access_token;
    nowMs += 3599_000 - 1;
    expect((await sendFcm(s, access, MESSAGE)).status).toBe(200);
    nowMs += 1;
    expect((await sendFcm(s, access, MESSAGE)).status).toBe(401);
  });

  test("scripts: 429 with Retry-After, 503, a stall, a drop", async () => {
    const scripts: FcmScript[] = [
      {
        kind: "error",
        status: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        fcmCode: "QUOTA_EXCEEDED",
        retryAfterS: 30,
      },
      { kind: "error", status: 503, errorStatus: "UNAVAILABLE", fcmCode: "UNAVAILABLE" },
      { kind: "stall" },
      { kind: "drop" },
    ];
    const s = await fcm((n) => scripts[n - 1]);
    const access = ((await (await accessToken(s)).json()) as { access_token: string }).access_token;
    const limited = await sendFcm(s, access, MESSAGE);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect((await sendFcm(s, access, MESSAGE)).status).toBe(503);
    const stalled = await Promise.race([
      sendFcm(s, access, MESSAGE).then(() => "answered"),
      Bun.sleep(300).then(() => "stalled"),
    ]);
    expect(stalled).toBe("stalled");
    const dropped = await sendFcm(s, access, MESSAGE).then(
      () => "answered",
      () => "lost",
    );
    expect(dropped).toBe("lost");
    // It listens again on the same port.
    expect((await sendFcm(s, access, MESSAGE)).status).toBe(200);
  });
});

describe("the loopback certificate", () => {
  test("is accepted by node:crypto every time (its serial is minimal DER)", () => {
    // A zero first byte came once in 128 serials before; 1,000 tries miss it once in 2,500 runs.
    for (let i = 0; i < 1000; i += 1) {
      const made = must(loopbackTls(Date.now()));
      const certificate = new X509Certificate(made.cert);
      expect(certificate.checkHost("localhost")).toBe("localhost");
    }
  });
});

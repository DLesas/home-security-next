/**
 * The FCM sender against the FCM stand-in: the request exactly as section 5 has it, the OAuth
 * assertion's claims, the access token's reuse, renewal before it expires and after a 401, every
 * answer of Google's mapped to its outcome, `Retry-After`, a lost connection and a stall.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFcmAccount } from "../../src/push/credentials.ts";
import { FcmClient, fcmBody } from "../../src/push/fcm.ts";
import {
  fcmOutcome,
  googleErrorParts,
  retryAfterMs,
  toPushOutcome,
} from "../../src/push/outcomes.ts";
import type { FcmScript } from "../../../tools/push-standins/src/index.ts";
import { fcmToken, memoryLog, REPO, sealedH, type StandIns, standIns } from "./helpers.ts";

const SECOND = 1000;
let open: StandIns | undefined;
const clock = { ms: Date.UTC(2026, 10, 18, 12) };

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function setUp(
  options: {
    script?: (n: number) => FcmScript | undefined;
    tokenScript?: "stall" | "refuse";
  } = {},
) {
  clock.ms = Date.UTC(2026, 10, 18, 12);
  const s = await standIns({
    fcmNow: () => clock.ms,
    ...(options.script === undefined ? {} : { fcm: (n) => options.script?.(n) }),
  });
  open = s;
  const account = readFcmAccount(s.fcmAccountPath, {
    programFolder: REPO,
    uid: process.getuid?.(),
  })._unsafeUnwrap();
  const log = memoryLog();
  const client = new FcmClient({
    account,
    origin: s.fcm.origin,
    ca: s.tls.cert,
    now: () => clock.ms,
    log,
    timeoutMs: 300,
  });
  const send = (n: number) => client.send({ token: fcmToken(n), h: sealedH(n) });
  return { s, client, send, log };
}

describe("the request", () => {
  test("is exactly section 5's, with the stand-in's access token", async () => {
    const { s, send } = await setUp();
    expect(await send(1)).toEqual({ kind: "delivered" });
    const request = s.fcm.received[0];
    expect(request?.path).toBe(`/v1/projects/${s.account.projectId}/messages:send`);
    expect(request?.authorization).toBe(`Bearer ${s.fcm.issued[0] ?? "none"}`);
    expect(request?.contentType).toBe("application/json; charset=UTF-8");
    expect(request?.json).toEqual({
      message: {
        token: fcmToken(1),
        data: { h: sealedH(1) },
        android: { priority: "HIGH", ttl: "86400s" },
      },
    });
    expect(request?.body).toBe(fcmBody(fcmToken(1), sealedH(1)));
  });

  test("the assertion: RS256, the service account's key id, its claims exactly", async () => {
    const { s, send } = await setUp();
    await send(1);
    const assertion = s.fcm.tokenRequests[0]?.assertion;
    const iat = Math.floor(clock.ms / SECOND);
    expect(s.fcm.tokenRequests[0]?.grantType).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(assertion?.header).toEqual({ alg: "RS256", typ: "JWT", kid: s.account.privateKeyId });
    expect(assertion?.claims).toEqual({
      iss: s.account.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: s.fcm.tokenUri,
      iat,
      exp: iat + 3600,
    });
  });
});

describe("the access token", () => {
  test("is fetched once for many pushes, even at once", async () => {
    const { s, send } = await setUp();
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map((n) => send(n)));
    expect(outcomes.every((o) => o.kind === "delivered")).toBe(true);
    await send(6);
    expect(s.fcm.tokenRequests).toHaveLength(1);
    expect(new Set(s.fcm.received.map((r) => r.authorization)).size).toBe(1);
  });

  test("is replaced 5 minutes before it expires, not a millisecond sooner", async () => {
    const { s, send } = await setUp();
    await send(1);
    clock.ms += (3599 - 300) * SECOND - 1;
    await send(2);
    expect(s.fcm.tokenRequests).toHaveLength(1);
    clock.ms += 1;
    await send(3);
    expect(s.fcm.tokenRequests).toHaveLength(2);
    expect(s.fcm.received[2]?.authorization).toBe(`Bearer ${s.fcm.issued[1] ?? "none"}`);
  });

  test("after a 401 a new one is fetched and the push sent once more", async () => {
    const { s, send, log } = await setUp();
    await send(1);
    s.fcm.revokeAccessTokens();
    expect(await send(2)).toEqual({ kind: "delivered" });
    expect(s.fcm.tokenRequests).toHaveLength(2);
    expect(s.fcm.received.map((r) => r.answered)).toEqual([200, 401, 200]);
    expect(log.text().match(/"credentialsRenewed"/gu)).toHaveLength(2);
  });

  test("a token endpoint that refuses: retryLater credentials, logged", async () => {
    const { s } = await setUp();
    const account = readFcmAccount(s.fcmAccountPath, {
      programFolder: REPO,
      uid: process.getuid?.(),
    })._unsafeUnwrap();
    const log = memoryLog();
    // A service account whose client_email the stand-in does not know.
    const client = new FcmClient({
      account: { ...account, clientEmail: "someone@else.iam.gserviceaccount.com" },
      origin: s.fcm.origin,
      ca: s.tls.cert,
      now: () => clock.ms,
      log,
      timeoutMs: 300,
    });
    expect(await client.send({ token: fcmToken(1), h: sealedH(1) })).toEqual({
      kind: "retryLater",
      why: "credentials",
    });
    expect(s.fcm.received).toHaveLength(0);
    expect(log.text()).toContain('"credentialsFailed"');
    expect(log.text()).toContain('"status":400');
  });

  test("a token endpoint that is gone: retryLater credentials", async () => {
    const { s, client } = await setUp();
    await s.fcm.close();
    expect(await client.send({ token: fcmToken(1), h: sealedH(1) })).toEqual({
      kind: "retryLater",
      why: "credentials",
    });
  });
});

describe("every answer of Google's", () => {
  const scripted: [string, FcmScript, string][] = [
    [
      "429 QUOTA_EXCEEDED",
      { kind: "error", status: 429, errorStatus: "RESOURCE_EXHAUSTED", fcmCode: "QUOTA_EXCEEDED" },
      "retryLater rateLimited limited",
    ],
    [
      "503 UNAVAILABLE",
      { kind: "error", status: 503, errorStatus: "UNAVAILABLE", fcmCode: "UNAVAILABLE" },
      "retryLater unavailable failed",
    ],
    [
      "500 INTERNAL",
      { kind: "error", status: 500, errorStatus: "INTERNAL", fcmCode: "INTERNAL" },
      "retryLater unavailable failed",
    ],
    [
      "404 UNREGISTERED",
      { kind: "error", status: 404, errorStatus: "NOT_FOUND", fcmCode: "UNREGISTERED" },
      "tokenInvalid - badToken",
    ],
    [
      "404 without UNREGISTERED",
      { kind: "error", status: 404, errorStatus: "NOT_FOUND" },
      "dropped notFound failed",
    ],
    [
      "400 INVALID_ARGUMENT, not the token",
      { kind: "error", status: 400, errorStatus: "INVALID_ARGUMENT", fcmCode: "INVALID_ARGUMENT" },
      "dropped badRequest failed",
    ],
    [
      "403 SENDER_ID_MISMATCH",
      {
        kind: "error",
        status: 403,
        errorStatus: "PERMISSION_DENIED",
        fcmCode: "SENDER_ID_MISMATCH",
      },
      "dropped wrongApp failed",
    ],
    [
      "403 THIRD_PARTY_AUTH_ERROR",
      {
        kind: "error",
        status: 403,
        errorStatus: "PERMISSION_DENIED",
        fcmCode: "THIRD_PARTY_AUTH_ERROR",
      },
      "retryLater credentials failed",
    ],
  ];
  for (const [what, script, expected] of scripted) {
    test(`${what}: ${expected}`, async () => {
      const { send } = await setUp({ script: () => script });
      const outcome = await send(1);
      const why = "why" in outcome ? outcome.why : "-";
      expect(`${outcome.kind} ${why} ${toPushOutcome(outcome)}`).toBe(expected);
    });
  }

  test("a token Google unregistered: 404 UNREGISTERED, badToken", async () => {
    const { s, send } = await setUp();
    s.fcm.unregister(fcmToken(2));
    expect(await send(2)).toEqual({ kind: "tokenInvalid" });
  });

  test("a malformed token: 400 INVALID_ARGUMENT on message.token, badToken", async () => {
    const { client } = await setUp();
    expect(await client.send({ token: "not a token", h: sealedH(1) })).toEqual({
      kind: "tokenInvalid",
    });
  });

  test("Retry-After pauses every send for that long, not longer", async () => {
    const { s, send } = await setUp({
      script: (n) =>
        n === 1
          ? {
              kind: "error",
              status: 429,
              errorStatus: "RESOURCE_EXHAUSTED",
              fcmCode: "QUOTA_EXCEEDED",
              retryAfterS: 30,
            }
          : undefined,
    });
    expect((await send(1)).kind).toBe("retryLater");
    clock.ms += 30 * SECOND - 1;
    expect(await send(2)).toEqual({ kind: "retryLater", why: "rateLimited" });
    expect(s.fcm.received).toHaveLength(1);
    clock.ms += 1;
    expect(await send(3)).toEqual({ kind: "delivered" });
  });

  test("a connection lost mid-request: retryLater, and the next push goes through", async () => {
    const { send } = await setUp({ script: (n) => (n === 1 ? { kind: "drop" } : undefined) });
    expect(await send(1)).toEqual({ kind: "retryLater", why: "connection" });
    expect(await send(2)).toEqual({ kind: "delivered" });
  });

  test("a stalled answer: retryLater timeout", async () => {
    const { send } = await setUp({ script: (n) => (n === 1 ? { kind: "stall" } : undefined) });
    expect(await send(1)).toEqual({ kind: "retryLater", why: "timeout" });
    expect(await send(2)).toEqual({ kind: "delivered" });
  });

  test("the pure mapping and its parsing", () => {
    expect(fcmOutcome(400, { fcmCode: "INVALID_ARGUMENT", badFields: ["message.token"] })).toEqual({
      kind: "tokenInvalid",
    });
    expect(fcmOutcome(400, { fcmCode: undefined, badFields: ["message.data"] })).toEqual({
      kind: "dropped",
      why: "badRequest",
    });
    expect(fcmOutcome(401, { fcmCode: undefined, badFields: [] })).toEqual({
      kind: "retryLater",
      why: "credentials",
    });
    expect(fcmOutcome(302, { fcmCode: undefined, badFields: [] })).toEqual({
      kind: "dropped",
      why: "other",
    });
    expect(
      googleErrorParts({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "UNREGISTERED",
            },
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [{ field: "message.token" }],
            },
            "junk",
          ],
        },
      }),
    ).toEqual({ fcmCode: "UNREGISTERED", badFields: ["message.token"] });
    expect(googleErrorParts("not an error")).toEqual({ fcmCode: undefined, badFields: [] });
    expect(retryAfterMs("30", 0)).toBe(30_000);
    expect(retryAfterMs("Wed, 18 Nov 2026 12:00:30 GMT", Date.UTC(2026, 10, 18, 12))).toBe(30_000);
    expect(retryAfterMs("soon", 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });
});

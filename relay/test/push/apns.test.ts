/**
 * The APNs sender against the APNs stand-in: the request exactly as section 5 has it, every
 * answer of Apple's mapped to its outcome, the provider token's claims, reuse, renewal at 40
 * minutes and after `ExpiredProviderToken`, and the two environments.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { ApnsClient, apnsBody } from "../../src/push/apns.ts";
import { readApnsKey } from "../../src/push/credentials.ts";
import { ApnsProviderToken, type ApnsSigner } from "../../src/push/jwt.ts";
import { apnsOutcome, toPushOutcome } from "../../src/push/outcomes.ts";
import { type ApnsScript, startApnsStandIn } from "../../../tools/push-standins/src/index.ts";
import {
  apnsToken,
  memoryLog,
  must,
  REPO,
  sealedH,
  type StandIns,
  standIns,
  TOPIC,
} from "./helpers.ts";

const MINUTE = 60_000;
let open: StandIns | undefined;
const clients: ApnsClient[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const close of closers.splice(0)) await close();
  await open?.close();
  open = undefined;
});

/** A clock both the sender and the stand-in read, so a test can move them together or apart. */
const clocks = { client: Date.UTC(2026, 10, 18, 12), apple: Date.UTC(2026, 10, 18, 12) };

async function setUp(
  options: {
    script?: (token: string | undefined) => ApnsScript | undefined;
    topic?: string;
    signer?: ApnsSigner;
  } = {},
) {
  clocks.client = Date.UTC(2026, 10, 18, 12);
  clocks.apple = clocks.client;
  const s = await standIns({
    apnsNow: () => clocks.apple,
    ...(options.script === undefined
      ? {}
      : { apns: (_n, request) => options.script?.(request.deviceToken) }),
  });
  open = s;
  const signer =
    options.signer ??
    readApnsKey(s.apnsKeyPath, s.apnsKey.keyId, s.apnsKey.teamId, {
      programFolder: REPO,
      uid: process.getuid?.(),
    })._unsafeUnwrap();
  const tokens = new ApnsProviderToken(signer);
  const log = memoryLog();
  const client = new ApnsClient({
    tokens,
    topic: options.topic ?? TOPIC,
    origins: { production: s.apns.origin, development: "https://127.0.0.1:1" },
    ca: s.tls.cert,
    now: () => clocks.client,
    log,
    requestTimeoutMs: 300,
  });
  clients.push(client);
  const send = (n: number) =>
    client.send({ env: "production", token: apnsToken(n), h: sealedH(n) });
  return { s, client, send, log, tokens };
}

describe("the request", () => {
  test("is exactly section 5's: path, headers, body", async () => {
    const { s, send } = await setUp();
    expect((await send(7)).kind).toBe("delivered");
    const request = s.apns.received[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe(`/3/device/${apnsToken(7)}`);
    const headers = Object.fromEntries(
      Object.entries(request?.headers ?? {}).filter(([name]) => name !== "date"),
    );
    expect(headers).toEqual({
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(clocks.client / 1000) + 86_400),
      "content-type": "application/json",
    });
    expect(request?.headers["apns-collapse-id"]).toBeUndefined();
    expect(JSON.parse(request?.body ?? "")).toEqual({
      aps: { alert: { "loc-key": "push.placeholder" }, "mutable-content": 1, sound: "default" },
      h: sealedH(7),
    });
    expect(request?.body).toBe(apnsBody(sealedH(7)));
  });

  test("a development token goes to the sandbox, a production one to production", async () => {
    const { s } = await setUp();
    const sandbox = must(
      await startApnsStandIn({
        tls: s.tls,
        keyId: s.apnsKey.keyId,
        teamId: s.apnsKey.teamId,
        publicKeyPem: s.apnsKey.publicPem,
        topic: TOPIC,
        now: () => clocks.apple,
      }),
    );
    closers.push(() => sandbox.close());
    const signer = readApnsKey(s.apnsKeyPath, s.apnsKey.keyId, s.apnsKey.teamId, {
      programFolder: REPO,
      uid: process.getuid?.(),
    })._unsafeUnwrap();
    const client = new ApnsClient({
      tokens: new ApnsProviderToken(signer),
      topic: TOPIC,
      origins: { production: s.apns.origin, development: sandbox.origin },
      ca: s.tls.cert,
      now: () => clocks.client,
      log: memoryLog(),
    });
    clients.push(client);
    expect(
      (await client.send({ env: "development", token: apnsToken(1), h: sealedH(1) })).kind,
    ).toBe("delivered");
    expect(
      (await client.send({ env: "production", token: apnsToken(2), h: sealedH(2) })).kind,
    ).toBe("delivered");
    expect(sandbox.received.map((r) => r.deviceToken)).toEqual([apnsToken(1)]);
    expect(s.apns.received.map((r) => r.deviceToken)).toEqual([apnsToken(2)]);
  });
});

describe("every answer of Apple's", () => {
  const scripted: [string, ApnsScript, string][] = [
    [
      "429 TooManyRequests",
      { kind: "status", status: 429, reason: "TooManyRequests" },
      "retryLater rateLimited limited",
    ],
    [
      "500 InternalServerError",
      { kind: "status", status: 500, reason: "InternalServerError" },
      "retryLater unavailable failed",
    ],
    [
      "503 ServiceUnavailable",
      { kind: "status", status: 503, reason: "ServiceUnavailable" },
      "retryLater unavailable failed",
    ],
    [
      "400 BadDeviceToken",
      { kind: "status", status: 400, reason: "BadDeviceToken" },
      "tokenInvalid - badToken",
    ],
    [
      "400 DeviceTokenNotForTopic",
      { kind: "status", status: 400, reason: "DeviceTokenNotForTopic" },
      "dropped wrongApp failed",
    ],
    [
      "400 BadPriority",
      { kind: "status", status: 400, reason: "BadPriority" },
      "dropped badRequest failed",
    ],
    [
      "413 PayloadTooLarge",
      { kind: "status", status: 413, reason: "PayloadTooLarge" },
      "dropped payloadTooLarge failed",
    ],
    ["404 BadPath", { kind: "status", status: 404, reason: "BadPath" }, "dropped notFound failed"],
    [
      "403 InvalidProviderToken",
      { kind: "status", status: 403, reason: "InvalidProviderToken" },
      "retryLater credentials failed",
    ],
    [
      "410 Unregistered",
      { kind: "status", status: 410, reason: "Unregistered" },
      "tokenInvalid - badToken",
    ],
    ["200", { kind: "status", status: 200 }, "delivered - accepted"],
  ];
  for (const [what, script, expected] of scripted) {
    test(`${what}: ${expected}`, async () => {
      const { send } = await setUp({ script: () => script });
      const outcome = await send(1);
      const why = "why" in outcome ? outcome.why : "-";
      expect(`${outcome.kind} ${why} ${toPushOutcome(outcome)}`).toBe(expected);
    });
  }

  test("a token Apple unregistered: 410, badToken", async () => {
    const { s, send } = await setUp();
    s.apns.unregister(apnsToken(3));
    expect(await send(3)).toEqual({ kind: "tokenInvalid" });
    expect((await send(4)).kind).toBe("delivered");
  });

  test("the wrong topic: Apple's BadTopic, dropped", async () => {
    const { send } = await setUp({ topic: "other.app" });
    expect(await send(1)).toEqual({ kind: "dropped", why: "topic" });
  });

  test("a key Apple does not know: 403, retryLater credentials, logged as an error", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const s0 = await standIns();
    const signer = {
      keyId: s0.apnsKey.keyId,
      teamId: s0.apnsKey.teamId,
      key: createPrivateKey(other.export({ type: "pkcs8", format: "pem" })),
    };
    await s0.close();
    const { send, log } = await setUp({ signer });
    expect(await send(1)).toEqual({ kind: "retryLater", why: "credentials" });
    expect(log.text()).toContain('"credentialsFailed"');
  });

  test("the pure mapping, for the answers the stand-in does not script", () => {
    expect(apnsOutcome(410, "ExpiredToken")).toEqual({ kind: "tokenInvalid" });
    expect(apnsOutcome(400, undefined)).toEqual({ kind: "dropped", why: "badRequest" });
    expect(apnsOutcome(405, "MethodNotAllowed")).toEqual({ kind: "dropped", why: "notFound" });
    expect(apnsOutcome(400, "MissingTopic")).toEqual({ kind: "dropped", why: "topic" });
    expect(apnsOutcome(400, "TopicDisallowed")).toEqual({ kind: "dropped", why: "topic" });
    expect(apnsOutcome(429, "TooManyProviderTokenUpdates")).toEqual({
      kind: "retryLater",
      why: "rateLimited",
    });
    expect(apnsOutcome(502, undefined)).toEqual({ kind: "retryLater", why: "unavailable" });
    expect(apnsOutcome(301, undefined)).toEqual({ kind: "dropped", why: "other" });
  });
});

describe("the provider token", () => {
  test("ES256 with the key id; claims exactly the team and the time; verified by the stand-in", async () => {
    const { s, send } = await setUp();
    expect((await send(1)).kind).toBe("delivered");
    const jwt = s.apns.received[0]?.jwt;
    expect(jwt?.header).toEqual({ alg: "ES256", kid: s.apnsKey.keyId });
    expect(jwt?.claims).toEqual({ iss: s.apnsKey.teamId, iat: Math.floor(clocks.client / 1000) });
    expect(jwt?.signature).toHaveLength(64);
  });

  test("is reused, and replaced at 40 minutes, not a millisecond before", async () => {
    const { s, send } = await setUp();
    await send(1);
    clocks.client += 40 * MINUTE - 1;
    clocks.apple = clocks.client;
    await send(2);
    clocks.client += 1;
    clocks.apple = clocks.client;
    expect((await send(3)).kind).toBe("delivered");
    const auth = s.apns.received.map((r) => r.authorization);
    expect(auth[1]).toBe(auth[0]);
    expect(auth[2]).not.toBe(auth[0]);
    expect(s.apns.received[2]?.jwt?.claims.iat).toBe(Math.floor(clocks.client / 1000));
  });

  test("after ExpiredProviderToken it is renewed once and the push sent again", async () => {
    const { s, send, log } = await setUp();
    await send(1);
    // Thirty minutes on this host, an hour and a minute at Apple: Apple calls the token expired.
    clocks.client += 30 * MINUTE;
    clocks.apple += 61 * MINUTE;
    expect((await send(2)).kind).toBe("delivered");
    expect(s.apns.received.map((r) => r.answered)).toEqual([
      { kind: "status", status: 200 },
      { kind: "status", status: 403, reason: "ExpiredProviderToken" },
      { kind: "status", status: 200 },
    ]);
    expect(s.apns.received[2]?.jwt?.claims.iat).toBe(Math.floor(clocks.client / 1000));
    expect(log.text()).toContain('"credentialsRenewed"');
  });

  test("is not renewed when Apple calls a token under 20 minutes old expired: the clocks disagree", async () => {
    const { s, send, log } = await setUp();
    await send(1);
    clocks.client += 20 * MINUTE - 1000;
    clocks.apple += 61 * MINUTE;
    expect(await send(2)).toEqual({ kind: "retryLater", why: "credentials" });
    expect(s.apns.received).toHaveLength(2);
    expect(log.text()).toContain("check this host's clock");
  });

  test("renewed after ExpiredProviderToken at exactly 20 minutes", async () => {
    const { s, send } = await setUp();
    await send(1);
    clocks.client += 20 * MINUTE;
    clocks.apple += 61 * MINUTE;
    expect((await send(2)).kind).toBe("delivered");
    expect(s.apns.received).toHaveLength(3);
  });

  test("Apple's refusal of a token renewed too often: limited (two senders with one key)", async () => {
    const { s, send } = await setUp();
    await send(1);
    // A second sender with its own provider token for the same key, a minute later: Apple sees
    // the key's token change within 20 minutes ‡.
    const signer = readApnsKey(s.apnsKeyPath, s.apnsKey.keyId, s.apnsKey.teamId, {
      programFolder: REPO,
      uid: process.getuid?.(),
    })._unsafeUnwrap();
    const second = new ApnsClient({
      tokens: new ApnsProviderToken(signer),
      topic: TOPIC,
      origins: { production: s.apns.origin, development: s.apns.origin },
      ca: s.tls.cert,
      now: () => clocks.client,
      log: memoryLog(),
    });
    clients.push(second);
    clocks.client += MINUTE;
    clocks.apple += MINUTE;
    expect(await second.send({ env: "production", token: apnsToken(2), h: sealedH(2) })).toEqual({
      kind: "retryLater",
      why: "rateLimited",
    });
  });
});

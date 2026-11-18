/**
 * The relay's frozen values and schemas (docs/m4-design.md sections 3, 5 and 6): every constant
 * pinned, every frame accepted as the design writes it and refused with any field missing, any
 * extra field, any wrong type, and each bound off by one.
 */
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { NOISE_PATTERNS } from "../app/noise-interface.ts";
import {
  HUB_STREAM_CLOSE_CODES,
  PHONE_CLOSE,
  PHONE_CLOSE_FROM_HUB,
  PHONE_PATHS,
  PUSH_ACTIONS,
  PUSH_H,
  PUSH_TOKEN,
  RELAY_BACKOFF,
  RELAY_BINARY_HEADER_BYTES,
  RELAY_BINARY_KIND,
  RELAY_CLOSE,
  RELAY_LIMITS,
  RELAY_NOISE_PATTERN,
  RELAY_PATHS,
  RELAY_PROLOGUE,
  RELAY_PROTO,
  RELAY_ROLES,
  RELAY_VECTOR_FILES,
  formatPhonePath,
  hubToRelayFrame,
  parsePhonePath,
  pushClass,
  pushContent,
  pushContentFits,
  pushEnvironment,
  pushH,
  pushOutcome,
  pushPlatform,
  pushToRelayFrame,
  pushTokenFits,
  relayBinaryFrameVector,
  relayHello,
  relayJoin,
  relayPeerHello,
  relayPrologue,
  relayPushVector,
  relayToHubFrame,
  relayToPushFrame,
  relayWelcome,
  releaseCheck,
  releaseOffer,
  rosterTarget,
} from "./index.ts";

const IDENTITY = "abcdefghijklmnopqrstuvwxyz";
const KEY_ID = "0011223344556677";
const H = `1.${KEY_ID}.${"A".repeat(PUSH_H.sealedChars)}`;
const APNS_TOKEN = "ab".repeat(32);

const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

/** The object without one key. */
const omit = (value: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

/**
 * A good value is accepted; with any required field left out, any field given a value of the
 * wrong type, or one extra field, it is refused.
 */
function checkStrict(
  schema: z.ZodType,
  good: Readonly<Record<string, unknown>>,
  optional: readonly string[] = [],
): void {
  expect(accepts(schema, good)).toBe(true);
  for (const key of Object.keys(good)) {
    const without = omit(good, key);
    expect({ key, accepted: accepts(schema, without) }).toEqual({
      key,
      accepted: optional.includes(key),
    });
    if (key !== "t") {
      const wrong = typeof good[key] === "symbol" ? 0 : Symbol("wrong");
      expect({ key, accepted: accepts(schema, { ...good, [key]: wrong }) }).toEqual({
        key,
        accepted: false,
      });
    }
  }
  expect(accepts(schema, { ...good, extra: 1 })).toBe(false);
}

describe("constants", () => {
  test("paths, versions, prologues and the pattern", () => {
    expect(RELAY_PATHS).toEqual({ hub: "/v1/hub", relay: "/v1/relay", phonePrefix: "/v1/phone" });
    expect(RELAY_PROTO).toEqual({ min: 1, max: 1 });
    expect(PHONE_PATHS).toEqual(["session", "link", "restore"]);
    expect(RELAY_PROLOGUE).toEqual({ hub: "hsn-relay/1", peer: "hsn-relay-peer/1" });
    expect(Buffer.from(relayPrologue("hub")).toString("hex")).toBe(
      Buffer.from("hsn-relay/1\0").toString("hex"),
    );
    expect(Buffer.from(relayPrologue("peer")).toString("hex")).toBe(
      Buffer.from("hsn-relay-peer/1\0").toString("hex"),
    );
    expect(RELAY_NOISE_PATTERN).toBe("Noise_XN_25519_ChaChaPoly_SHA256");
    expect(NOISE_PATTERNS.relay).toBe(RELAY_NOISE_PATTERN);
    expect(RELAY_ROLES).toEqual(["relay", "push", "names", "releases"]);
  });

  test("close codes", () => {
    expect(RELAY_CLOSE).toEqual({
      stopping: 1001,
      replaced: 4001,
      badFrame: 4400,
      handshakeTimeout: 4408,
      noSharedVersion: 4426,
      overLimit: 4429,
      refused: 4403,
    });
    expect(PHONE_CLOSE).toEqual({
      stopping: 1001,
      textMessage: 1003,
      tooLarge: 1009,
      tryLater: 1013,
      badPath: 4400,
      hubNotConnected: 4404,
      hubGone: 4410,
      overLimit: 4429,
    });
    expect(PHONE_CLOSE_FROM_HUB).toEqual([1000, 1008, 4000, 4001, 4002, 4003, 4004]);
    expect(HUB_STREAM_CLOSE_CODES).toEqual([1000, 1008, 1013, 4000, 4001, 4002, 4003, 4004]);
  });

  test("limits and times", () => {
    expect(RELAY_LIMITS).toEqual({
      maxStream: 4_294_967_295,
      maxPhoneMessageBytes: 65_535,
      maxRosterBytes: 131_072,
      maxPushItemsPerFrame: 32,
      maxReleasePieceBytes: 262_144,
      maxReleasePiecesInFlight: 4,
      maxRestartWithinMs: 600_000,
      restartAckWaitMs: 2_000,
      streamIdleMs: 90_000,
      hubPingEveryMs: 30_000,
      pongWithinMs: 15_000,
      silentLinkMs: 75_000,
      handshakeMs: 10_000,
      identityInUseWaitMs: 600_000,
      limitWaitMs: 600_000,
      maxHubReleaseBytes: 268_435_456,
      maxFirmwareReleaseBytes: 8_388_608,
      fetchResumeWaitMs: 600_000,
      releaseCheckEveryMs: 86_400_000,
    });
    expect(RELAY_BACKOFF).toEqual({
      stepsMs: [1000, 2000, 4000, 8000, 16_000, 32_000],
      thenEveryMs: 60_000,
      jitter: 0.2,
      resetAfterMs: 60_000,
    });
    expect(RELAY_BINARY_KIND).toEqual({ streamData: 1, releasePiece: 2 });
    expect(RELAY_BINARY_HEADER_BYTES).toBe(5);
    expect(RELAY_VECTOR_FILES).toEqual({
      push: "relay-push.json",
      xn: "relay-xn.json",
      frames: "relay-frames.json",
    });
  });

  test("the h format's sizes follow from each other", () => {
    expect(PUSH_H).toEqual({
      version: "1",
      keyBytes: 32,
      keyIdBytes: 8,
      nonceBytes: 12,
      tagBytes: 16,
      paddedBytes: 1280,
      maxContentBytes: 1279,
      padMark: 0x80,
      aadLabel: "hsn-push/1",
      sealedChars: 1744,
      hChars: 1763,
    });
    const sealed = PUSH_H.nonceBytes + PUSH_H.paddedBytes + PUSH_H.tagBytes;
    expect(Buffer.alloc(sealed).toString("base64url").length).toBe(PUSH_H.sealedChars);
    expect(2 + 2 * PUSH_H.keyIdBytes + 1 + PUSH_H.sealedChars).toBe(PUSH_H.hChars);
    expect(H.length).toBe(PUSH_H.hChars);
  });

  test("enums", () => {
    expect(pushPlatform.options).toEqual(["apns", "fcm"]);
    expect(pushEnvironment.options).toEqual(["production", "development"]);
    expect(pushOutcome.options).toEqual(["accepted", "badToken", "limited", "failed"]);
    expect(pushClass.options).toEqual(["critical", "ordinary"]);
    expect(PUSH_ACTIONS).toEqual(["disarm", "armAway"]);
    expect(PUSH_TOKEN).toEqual({
      apns: { minChars: 64, maxChars: 200 },
      fcm: { minChars: 1, maxChars: 4096 },
    });
  });
});

describe("the phone path", () => {
  test("formats and reads back", () => {
    for (const path of PHONE_PATHS) {
      const text = formatPhonePath({ identity: IDENTITY, path });
      expect(text).toBe(`/v1/phone/${IDENTITY}/${path}`);
      expect(parsePhonePath(text ?? "")).toEqual({ identity: IDENTITY, path });
    }
  });

  test("refuses anything else", () => {
    expect(formatPhonePath({ identity: "short", path: "session" })).toBeUndefined();
    for (const text of [
      `/v1/phone/${IDENTITY}`,
      `/v1/phone/${IDENTITY}/`,
      `/v1/phone/${IDENTITY}/session/`,
      `/v1/phone/${IDENTITY}/sessions`,
      `/v1/phone/${IDENTITY.toUpperCase()}/session`,
      `/v1/phone/${IDENTITY.slice(1)}/session`,
      `/v1/phone/${IDENTITY}a/session`,
      `/v1/phone/abcdefghijklmnopqrstuvwxy1/session`,
      `/v2/phone/${IDENTITY}/session`,
      `x/v1/phone/${IDENTITY}/session`,
      `/v1/hub`,
    ])
      expect(parsePhonePath(text)).toBeUndefined();
  });
});

const content = {
  v: 1,
  hub: IDENTITY,
  n: {
    seq: 4_294_967_297,
    atMs: 1_700_000_000_000,
    clockOk: true,
    kind: "countdown",
    category: "countdown",
    critical: true,
    device: 7,
    cause: 4_294_967_296,
  },
  delayed: false,
  names: { device: "front-door", person: "Ana" },
  detail: { seconds: 30 },
  actions: ["disarm"],
  armed: true,
} as const;

describe("PushContent", () => {
  test("is strict at every level", () => {
    checkStrict(pushContent, content, ["detail"]);
    checkStrict(pushContent.unwrap().shape.n, content.n);
    expect(accepts(pushContent, { ...content, names: { ...content.names, extra: "x" } })).toBe(
      false,
    );
  });

  test("its values", () => {
    const bad: readonly Record<string, unknown>[] = [
      { v: 2 },
      { hub: IDENTITY.slice(1) },
      { hub: `${IDENTITY}a` },
      { actions: ["disarm", "armAway"] },
      { actions: ["arm"] },
      { names: { device: "x".repeat(65) } },
      { names: { device: "" } },
      { detail: { nested: { a: 1 } } },
      { n: { ...content.n, category: "nope" } },
      { n: { ...content.n, seq: -1 } },
      { n: { ...content.n, device: 0 } },
      { n: { ...content.n, kind: "" } },
    ];
    for (const change of bad)
      expect({ change, accepted: accepts(pushContent, { ...content, ...change }) }).toEqual({
        change,
        accepted: false,
      });
    for (const change of [
      { actions: [] },
      { actions: ["armAway"] },
      { names: {} },
      { names: { device: "x".repeat(64) } },
      // The relay's own alerts: seq 0 and no time (D127).
      { n: { ...content.n, seq: 0, atMs: 0, kind: "hub_unreachable", device: null, cause: null } },
    ])
      expect(accepts(pushContent, { ...content, ...change })).toBe(true);
  });

  test("fits at 1,279 bytes and not at 1,280", () => {
    const base = pushContent.parse({ ...content, detail: { pad: "" } });
    const baseBytes = new TextEncoder().encode(JSON.stringify(base)).length;
    const sized = (bytes: number) =>
      pushContent.parse({ ...content, detail: { pad: "x".repeat(bytes - baseBytes) } });
    expect(pushContentFits(sized(1279))).toBe(true);
    expect(pushContentFits(sized(1280))).toBe(false);
  });
});

describe("tokens and h", () => {
  test("tokens by platform", () => {
    expect(pushTokenFits("apns", "a".repeat(64))).toBe(true);
    expect(pushTokenFits("apns", "F".repeat(200))).toBe(true);
    expect(pushTokenFits("apns", "a".repeat(63))).toBe(false);
    expect(pushTokenFits("apns", "a".repeat(201))).toBe(false);
    expect(pushTokenFits("apns", `${"a".repeat(63)}g`)).toBe(false);
    expect(pushTokenFits("fcm", "x")).toBe(true);
    expect(pushTokenFits("fcm", "x".repeat(4096))).toBe(true);
    expect(pushTokenFits("fcm", "")).toBe(false);
    expect(pushTokenFits("fcm", "x".repeat(4097))).toBe(false);
    expect(pushTokenFits("fcm", "a b")).toBe(false);
  });

  test("h's form", () => {
    expect(accepts(pushH, H)).toBe(true);
    expect(accepts(pushH, `${H}A`)).toBe(false);
    expect(accepts(pushH, H.slice(0, -1))).toBe(false);
    expect(accepts(pushH, `2${H.slice(1)}`)).toBe(false);
    expect(accepts(pushH, H.replace(KEY_ID, KEY_ID.toUpperCase().replace("0", "A")))).toBe(false);
    expect(accepts(pushH, `${H.slice(0, -1)}=`)).toBe(false);
  });

  test("a roster target", () => {
    const target = {
      key: KEY_ID,
      platform: "apns",
      env: "production",
      token: APNS_TOKEN,
      unreachable: H,
      back: H,
    };
    checkStrict(rosterTarget, target);
    expect(accepts(rosterTarget, { ...target, key: "001122334455667" })).toBe(false);
    expect(accepts(rosterTarget, { ...target, token: "not hex" })).toBe(false);
    expect(accepts(rosterTarget, { ...target, platform: "fcm", token: "not hex" })).toBe(false);
    expect(accepts(rosterTarget, { ...target, platform: "fcm", token: "fcm-token:1" })).toBe(true);
    expect(accepts(rosterTarget, { ...target, env: "test" })).toBe(false);
  });
});

describe("the handshake's payloads", () => {
  test("hello, peer hello, welcome, join", () => {
    checkStrict(relayHello, { proto: [1, 1], hub: "0.1.0" });
    checkStrict(relayPeerHello, { proto: [1, 2], relay: "1.0.0" });
    expect(accepts(relayHello, { proto: [2, 1], hub: "0.1.0" })).toBe(false);
    expect(accepts(relayHello, { proto: [0, 1], hub: "0.1.0" })).toBe(false);
    expect(accepts(relayHello, { proto: [1, 1, 1], hub: "0.1.0" })).toBe(false);
    expect(accepts(relayHello, { proto: [1, 1], hub: "0.1" })).toBe(false);
    expect(accepts(relayHello, { proto: [1, 1], hub: "01.1.0" })).toBe(false);
    const limits = {
      maxRosterBytes: 131_072,
      maxPushItemsPerFrame: 32,
      maxReleasePieceBytes: 262_144,
      maxRestartWithinMs: 600_000,
    };
    const welcome = { proto: 1, relay: "1.0.0", roles: ["relay", "releases"], limits };
    checkStrict(relayWelcome, welcome);
    checkStrict(relayWelcome.unwrap().shape.limits, limits);
    expect(accepts(relayWelcome, { ...welcome, roles: [] })).toBe(false);
    expect(accepts(relayWelcome, { ...welcome, roles: ["relay", "relay"] })).toBe(false);
    expect(accepts(relayWelcome, { ...welcome, roles: ["mail"] })).toBe(false);
    expect(accepts(relayJoin, {})).toBe(true);
    expect(accepts(relayJoin, { s: 1 })).toBe(false);
  });
});

const hubOffer = {
  kind: "hub",
  version: "1.2.3",
  platform: "linux-arm64",
  file: "hsn-hub-1.2.3-linux-arm64.hsnr",
  bytes: 112_000_000,
  sha256: "0".repeat(64),
};
const firmwareOffer = {
  kind: "firmware",
  version: "1.4.0",
  target: "esp32s3",
  roles: [1, 2, 3],
  file: "hsn-firmware-1.4.0.hsnf",
  bytes: 1_500_000,
  sha256: "f".repeat(64),
};

describe("releases", () => {
  test("offers of both kinds", () => {
    checkStrict(releaseOffer, hubOffer);
    checkStrict(releaseOffer, firmwareOffer);
    expect(accepts(releaseOffer, { ...hubOffer, kind: "firmware" })).toBe(false);
    expect(accepts(releaseOffer, { ...hubOffer, file: "hsn-firmware-1.2.3.hsnf" })).toBe(false);
    expect(accepts(releaseOffer, { ...hubOffer, platform: "windows-arm64" })).toBe(false);
    expect(accepts(releaseOffer, { ...hubOffer, bytes: 0 })).toBe(false);
    expect(accepts(releaseOffer, { ...hubOffer, sha256: "0".repeat(63) })).toBe(false);
    expect(accepts(releaseOffer, { ...firmwareOffer, roles: [1, 1] })).toBe(false);
    expect(accepts(releaseOffer, { ...firmwareOffer, roles: [0] })).toBe(false);
    expect(accepts(releaseOffer, { ...firmwareOffer, roles: [4] })).toBe(false);
    expect(accepts(releaseOffer, { ...firmwareOffer, roles: [] })).toBe(false);
    expect(accepts(releaseOffer, { ...firmwareOffer, target: "esp32" })).toBe(false);
    expect(accepts(releaseOffer, { ...firmwareOffer, file: "hsn-firmware-1.4.0.hsnr" })).toBe(
      false,
    );
  });

  test("a check", () => {
    checkStrict(releaseCheck, { platform: "darwin-arm64", running: "0.1.0", firmware: "1.0.0" }, [
      "firmware",
    ]);
  });
});

/** Each frame of section 3's table, as the design writes it. */
const hubFrames = {
  ping: { t: "ping", n: 7 },
  close: { t: "close", stream: 3, code: 1013 },
  roster: {
    t: "roster",
    rev: 2,
    targets: [
      {
        key: KEY_ID,
        platform: "apns",
        env: "development",
        token: APNS_TOKEN,
        unreachable: H,
        back: H,
      },
    ],
  },
  push: { t: "push", items: [{ id: 1, key: KEY_ID, h: H }] },
  restarting: { t: "restarting", reason: "update", withinMs: 600_000 },
  check: { t: "release.check", platform: "linux-x64", running: "0.1.0" },
  get: { t: "release.get", id: 9, file: hubOffer.file, offset: 0, length: 262_144 },
} as const;

const relayFrames = {
  joined: { t: "joined", identity: IDENTITY },
  pong: { t: "pong", n: 7 },
  open: { t: "open", stream: 4_294_967_295, path: "link", peer: "relay-0011223344556677" },
  close: { t: "close", stream: 0, code: 4404 },
  rosterAck: { t: "rosterAck", rev: 2 },
  pushResult: { t: "pushResult", results: [{ id: 1, outcome: "badToken" }] },
  restartingAck: { t: "restartingAck" },
  offer: { t: "release.offer", releases: [hubOffer, firmwareOffer] },
  error: { t: "release.error", id: 9, reason: "limit", retryAfterMs: 3_600_000 },
  limit: { t: "limit", what: "newIdentity", retryAfterMs: 0 },
} as const;

describe("hub link frames", () => {
  test("hub → relay: each strict", () => {
    for (const frame of Object.values(hubFrames))
      checkStrict(hubToRelayFrame, frame, frame.t === "release.check" ? ["firmware"] : []);
    expect(accepts(hubToRelayFrame, { ...hubFrames.check, firmware: "1.0.0" })).toBe(true);
    expect(accepts(hubToRelayFrame, { t: "joined", identity: IDENTITY })).toBe(false);
    expect(accepts(hubToRelayFrame, { t: "name.claim", name: "x" })).toBe(false);
  });

  test("hub → relay: bounds", () => {
    const item = hubFrames.push.items[0];
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ ...item, id: i + 1 }));
    expect(accepts(hubToRelayFrame, { t: "push", items: items(32) })).toBe(true);
    expect(accepts(hubToRelayFrame, { t: "push", items: items(33) })).toBe(false);
    expect(accepts(hubToRelayFrame, { t: "push", items: [] })).toBe(false);
    expect(accepts(hubToRelayFrame, { t: "push", items: [{ ...item, id: 0 }] })).toBe(false);
    expect(accepts(hubToRelayFrame, { ...hubFrames.get, length: 262_145 })).toBe(false);
    expect(accepts(hubToRelayFrame, { ...hubFrames.get, length: 0 })).toBe(false);
    expect(accepts(hubToRelayFrame, { ...hubFrames.get, file: "other.bin" })).toBe(false);
    expect(accepts(hubToRelayFrame, { ...hubFrames.restarting, withinMs: 600_001 })).toBe(false);
    expect(accepts(hubToRelayFrame, { ...hubFrames.restarting, reason: "upgrade" })).toBe(false);
    expect(accepts(hubToRelayFrame, { ...hubFrames.ping, n: 4_294_967_296 })).toBe(false);
    for (const code of [1000, 1008, 1013, 4000, 4004])
      expect(accepts(hubToRelayFrame, { ...hubFrames.close, code })).toBe(true);
    for (const code of [1001, 4005, 4404, 4429])
      expect(accepts(hubToRelayFrame, { ...hubFrames.close, code })).toBe(false);
    expect(accepts(hubToRelayFrame, { ...hubFrames.close, stream: 4_294_967_296 })).toBe(false);
    expect(accepts(hubToRelayFrame, { ...hubFrames.close, stream: -1 })).toBe(false);
    const twice = {
      ...hubFrames.roster,
      targets: [hubFrames.roster.targets[0], hubFrames.roster.targets[0]],
    };
    expect(accepts(hubToRelayFrame, twice)).toBe(false);
  });

  test("relay → hub: each strict", () => {
    for (const frame of Object.values(relayFrames))
      checkStrict(relayToHubFrame, frame, frame.t === "release.error" ? ["retryAfterMs"] : []);
    expect(accepts(relayToHubFrame, hubFrames.push)).toBe(false);
  });

  test("relay → hub: values", () => {
    expect(accepts(relayToHubFrame, { ...relayFrames.open, peer: "relay-001122334455667" })).toBe(
      false,
    );
    expect(accepts(relayToHubFrame, { ...relayFrames.open, peer: "0011223344556677" })).toBe(false);
    expect(accepts(relayToHubFrame, { ...relayFrames.open, path: "hub" })).toBe(false);
    expect(accepts(relayToHubFrame, { ...relayFrames.close, code: 999 })).toBe(false);
    expect(accepts(relayToHubFrame, { ...relayFrames.close, code: 5000 })).toBe(false);
    expect(accepts(relayToHubFrame, { ...relayFrames.offer, releases: [] })).toBe(true);
    expect(accepts(relayToHubFrame, { ...relayFrames.offer, releases: [hubOffer, hubOffer] })).toBe(
      false,
    );
    expect(accepts(relayToHubFrame, { ...relayFrames.error, reason: "gone" })).toBe(false);
    expect(accepts(relayToHubFrame, { ...relayFrames.limit, what: "everything" })).toBe(false);
    expect(
      accepts(relayToHubFrame, { ...relayFrames.pushResult, results: [{ id: 1, outcome: "ok" }] }),
    ).toBe(false);
    expect(accepts(relayToHubFrame, { ...relayFrames.pushResult, results: [] })).toBe(false);
  });
});

describe("relay link frames (D142)", () => {
  const item = {
    id: 1,
    hub: IDENTITY,
    platform: "fcm",
    env: "production",
    token: "fcm:token",
    h: H,
  } as const;

  test("relay → push service", () => {
    checkStrict(relayToPushFrame, { t: "push", items: [item] });
    const parsed = relayToPushFrame.parse({ t: "push", items: [item] });
    expect(parsed.t === "push" ? parsed.items[0] : undefined).toEqual(item);
    for (const key of Object.keys(item)) {
      expect(accepts(relayToPushFrame, { t: "push", items: [omit(item, key)] })).toBe(false);
    }
    expect(accepts(relayToPushFrame, { t: "push", items: [{ ...item, class: "critical" }] })).toBe(
      false,
    );
    expect(accepts(relayToPushFrame, { t: "push", items: [{ ...item, platform: "apns" }] })).toBe(
      false,
    );
    expect(accepts(relayToPushFrame, hubFrames.push)).toBe(false);
    expect(accepts(relayToPushFrame, hubFrames.check)).toBe(true);
    expect(accepts(relayToPushFrame, hubFrames.get)).toBe(true);
    expect(accepts(relayToPushFrame, hubFrames.roster)).toBe(false);
    expect(accepts(relayToPushFrame, hubFrames.restarting)).toBe(false);
  });

  test("push service → relay", () => {
    for (const frame of [
      relayFrames.joined,
      relayFrames.pong,
      relayFrames.pushResult,
      relayFrames.offer,
      relayFrames.error,
      relayFrames.limit,
    ])
      expect(accepts(pushToRelayFrame, frame)).toBe(true);
    for (const frame of [relayFrames.open, relayFrames.close, relayFrames.rosterAck])
      expect(accepts(pushToRelayFrame, frame)).toBe(false);
  });
});

describe("vector formats", () => {
  test("a sealed push vector's sizes", () => {
    const vector = {
      name: "countdown",
      key: "00".repeat(32),
      keyId: KEY_ID,
      nonce: "00".repeat(12),
      content,
      contentJson: "7b7d",
      aad: "00",
      padded: "00".repeat(1280),
      sealed: "00".repeat(1308),
      h: H,
    };
    expect(accepts(relayPushVector, vector)).toBe(true);
    expect(accepts(relayPushVector, { ...vector, padded: "00".repeat(1279) })).toBe(false);
    expect(accepts(relayPushVector, { ...vector, nonce: "00".repeat(11) })).toBe(false);
    expect(accepts(relayPushVector, { ...vector, sealed: "00".repeat(1307) })).toBe(false);
  });

  test("a binary frame vector holds a frame or an error", () => {
    const frame = { kind: 1, stream: 1, message: "00" };
    expect(accepts(relayBinaryFrameVector, { name: "a", bytes: "0101000000" + "00", frame })).toBe(
      true,
    );
    expect(accepts(relayBinaryFrameVector, { name: "b", bytes: "03", expect: "unknownKind" })).toBe(
      true,
    );
    expect(accepts(relayBinaryFrameVector, { name: "c", bytes: "03" })).toBe(false);
    expect(
      accepts(relayBinaryFrameVector, { name: "d", bytes: "03", frame, expect: "truncated" }),
    ).toBe(false);
  });
});

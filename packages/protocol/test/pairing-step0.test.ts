/**
 * Pairing over Bluetooth's frozen values and formats (docs/m3-design.md sections 5 and 10, item
 * 4), and the record kinds the joint step 0 adds (docs/m3-m4-plan.md). The implementations are
 * P3's; these pin what they and the board (F1) must agree on.
 */
import { describe, expect, test } from "bun:test";
import {
  PAIR_ADVERT,
  PAIR_PROTOCOL_LABEL,
  PAIR_QR,
  PAIRING_CODE,
  PAIRING_SECURITY,
  pairingAdvertVectorFile,
  pairingBoardQrVectorFile,
  pairingCodeVectorFile,
  pairingSecurity2VectorFile,
  pairingSrpVectorFile,
  pairVersion,
  PROTOCOMM,
} from "../src/pairing/index.ts";
import {
  ALL_DECISION_KINDS,
  DECISION_KINDS,
  M2_HUB_EVENTS,
  M3M4_DECISION_KINDS,
  PACKET_BENCH_ACTIONS,
  M3M4_HUB_EVENTS,
} from "../src/records.ts";
import { BLUETOOTH_UPDATE } from "../src/update/index.ts";

describe("pairing's constants", () => {
  test("the board's QR code, the code and the window", () => {
    expect(PAIR_QR).toEqual({ prefix: "hsn://pair/1", codeParam: "c", chipParam: "d" });
    expect(PAIRING_CODE).toEqual({
      secretChars: 7,
      secretBits: 35,
      checkChars: 1,
      groups: [4, 4],
      maxTries: 5,
      windowMs: 120_000,
    });
    expect(PAIRING_CODE.secretChars * 5).toBe(PAIRING_CODE.secretBits);
  });

  test("protocomm's endpoints and security 2, as ESP-IDF v6.1.1 has them", () => {
    expect(PROTOCOMM.endpoints).toEqual({
      protoVersion: { name: "proto-ver", uuid16: 0xff53 },
      session: { name: "prov-session", uuid16: 0xff51 },
      setup: { name: "hsn-setup", uuid16: 0xff60 },
    });
    expect(PROTOCOMM.serviceUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    // Pairing's service is not the update's (D138).
    expect(PROTOCOMM.serviceUuid).not.toBe(BLUETOOTH_UPDATE.serviceUuid);
    expect(PAIRING_SECURITY).toEqual({
      version: 2,
      srpGroupBits: 3072,
      srpHash: "SHA-512",
      username: "hsn",
      aesKeyBytes: 32,
      nonceBytes: 12,
      sessionIdBytes: 8,
      tagBytes: 16,
      firstCounter: 1,
    });
    expect(PAIRING_SECURITY.sessionIdBytes + 4).toBe(PAIRING_SECURITY.nonceBytes);
  });

  test("the advertisement: a name apart from an update window's, 8 bytes of service data", () => {
    expect(PAIR_ADVERT).toEqual({
      namePrefix: "hsn-pair-",
      nameHexDigits: 4,
      serviceDataFormat: 1,
      serviceDataBytes: 8,
    });
    expect(1 + 1 + 6).toBe(PAIR_ADVERT.serviceDataBytes);
  });

  test("proto-ver's answer", () => {
    const good = {
      v: PAIR_PROTOCOL_LABEL,
      role: 2,
      chip: "a1b2c3d4e5f6",
      firmware: "1.2.3",
      sec: 2,
    };
    expect(PAIR_PROTOCOL_LABEL).toBe("hsn-pair/1");
    expect(pairVersion.safeParse(good).success).toBe(true);
    expect(pairVersion.safeParse({ ...good, v: "hsn-pair/2" }).success).toBe(false);
    expect(pairVersion.safeParse({ ...good, chip: "A1B2C3D4E5F6" }).success).toBe(false);
    expect(pairVersion.safeParse({ ...good, chip: "a1b2c3d4e5" }).success).toBe(false);
    expect(pairVersion.safeParse({ ...good, sec: 1 }).success).toBe(false);
    expect(pairVersion.safeParse({ ...good, role: 256 }).success).toBe(false);
    expect(pairVersion.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });
});

describe("pairing's vector file formats", () => {
  const header = { schemaVersion: 1, description: "test" };
  test("the code and the board's QR code", () => {
    const code = {
      name: "a",
      text: "abcd-efgh",
      code: "ABCDEFGH",
      shown: "ABCD-EFGH",
      secret: "1",
    };
    expect(pairingCodeVectorFile.safeParse({ ...header, cases: [code] }).success).toBe(true);
    expect(pairingCodeVectorFile.safeParse({ ...header, cases: [] }).success).toBe(false);
    expect(
      pairingCodeVectorFile.safeParse({ ...header, cases: [{ ...code, code: "ABCDEFG" }] }).success,
    ).toBe(false);
    expect(
      pairingBoardQrVectorFile.safeParse({
        ...header,
        cases: [{ name: "a", text: "x", qr: { code: "ABCDEFGH", chipId: "a1b2c3d4e5f6" } }],
      }).success,
    ).toBe(true);
    expect(
      pairingAdvertVectorFile.safeParse({
        ...header,
        cases: [{ name: "a", serviceData: "0101a1b2c3d4e5f6", advert: null }],
      }).success,
    ).toBe(true);
    expect(
      pairingAdvertVectorFile.safeParse({
        ...header,
        cases: [{ name: "a", serviceData: "0g", advert: null }],
      }).success,
    ).toBe(false);
  });

  test("SRP and security 2 name their ESP-IDF source", () => {
    const srp = {
      name: "a",
      username: "hsn",
      password: "ABCDEFGH",
      salt: "00",
      verifier: "00",
      clientPrivate: "00",
      clientPublic: "00",
      devicePrivate: "00",
      devicePublic: "00",
      u: "00",
      sessionKey: "00",
      clientProof: "00",
      deviceProof: "00",
    };
    expect(
      pairingSrpVectorFile.safeParse({ ...header, source: "v6.1.1", cases: [srp] }).success,
    ).toBe(true);
    expect(pairingSrpVectorFile.safeParse({ ...header, cases: [srp] }).success).toBe(false);
    const { u, ...noU } = srp;
    expect(u).toBe("00");
    expect(
      pairingSrpVectorFile.safeParse({ ...header, source: "v6.1.1", cases: [noU] }).success,
    ).toBe(false);
    const message = { direction: "toBoard", nonce: "00", plaintext: "00", sealed: "00" };
    const exchange = {
      name: "a",
      srpCase: "a",
      command0: "00",
      response0: "00",
      command1: "00",
      response1: "00",
      nonce: "00",
      messages: [message],
    };
    expect(
      pairingSecurity2VectorFile.safeParse({ ...header, source: "v6.1.1", cases: [exchange] })
        .success,
    ).toBe(true);
    expect(
      pairingSecurity2VectorFile.safeParse({
        ...header,
        source: "v6.1.1",
        cases: [{ ...exchange, messages: [{ ...message, direction: "up" }] }],
      }).success,
    ).toBe(false);
  });
});

describe("the joint step 0's record kinds", () => {
  test("decisions: new, distinct snake-case names, after M2's", () => {
    expect(M3M4_DECISION_KINDS).toEqual([
      "push_registered",
      "push_unregistered",
      "push_target_invalid",
      "update_offered",
      "firmware_added",
      "firmware_removed",
      "rollout_started",
      "rollout_resumed",
      "rollout_done",
      "rollout_cancelled",
      "rollout_paused",
      "firmware_release_offered",
      "firmware_held",
      "firmware_device_offered",
      "firmware_session_opened",
      "firmware_verified",
      "firmware_installing",
      "firmware_on_trial",
      "firmware_confirmed",
      "firmware_refused",
      "firmware_rolled_back",
      "firmware_reminder",
      "key_change_sent",
      "key_changed",
      // The bench's names for packet records (hub-design section 11), never decision rows.
      "firmware_offer",
      "firmware_query",
      "firmware_status",
      "old_key_packet",
    ]);
    expect(PACKET_BENCH_ACTIONS).toEqual([
      "firmware_offer",
      "firmware_query",
      "firmware_status",
      "old_key_packet",
    ]);
    expect(new Set(ALL_DECISION_KINDS).size).toBe(ALL_DECISION_KINDS.length);
    expect(ALL_DECISION_KINDS.slice(0, DECISION_KINDS.length)).toEqual([...DECISION_KINDS]);
    for (const kind of M3M4_DECISION_KINDS) {
      expect(kind).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
      expect((DECISION_KINDS as readonly string[]).includes(kind)).toBe(false);
    }
    // m3-updates-design section 4: every firmware record starts `firmware_` or `rollout_`.
    const updates = M3M4_DECISION_KINDS.filter(
      (k) => k.startsWith("firmware_") || k.startsWith("rollout_"),
    );
    expect(updates).toHaveLength(21);
  });

  test("hub events: their levels and classes", () => {
    expect(M3M4_HUB_EVENTS).toEqual({
      relay_link: { level: "info", durability: "routine" },
      relay_unreachable: { level: "warning", durability: "now" },
      relay_reachable: { level: "info", durability: "routine" },
      relay_identity_in_use: { level: "warning", durability: "now" },
      push_dropped: { level: "info", durability: "routine" },
      firmware_file_refused: { level: "warning", durability: "routine" },
      firmware_store_damaged: { level: "critical", durability: "now" },
    });
    for (const code of Object.keys(M3M4_HUB_EVENTS))
      expect(Object.hasOwn(M2_HUB_EVENTS, code)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  concatBytes,
  decodePairingData,
  decodeSetupMessage,
  encodePairingData,
  encodeSetupMessage,
  fromHex,
  hubIdentity,
  nodeSha256,
  isSetupMessage,
  type PairingData,
  type SetupMessage,
  SetupType,
  toHex,
  wifiBytes,
} from "../src/index.ts";

const pairing: PairingData = {
  address: 0x1a2b3c4d,
  key: fromHex("000102030405060708090a0b0c0d0e0f"),
  // SHA-256 of the 64 key bytes, first 8 bytes, computed outside this package.
  hubIdentity: fromHex("c422e7070cb1cb45"),
  firmwareSigningKey: new Uint8Array(64).fill(0x42),
  siteChannel: 1,
  allowedDataRateMask: 0x24,
  wifiName: wifiBytes("home"),
  wifiPassword: wifiBytes("secret12"),
};

// Section 9, field by field.
const pairingHex =
  "01" +
  "4d3c2b1a" +
  "000102030405060708090a0b0c0d0e0f" +
  "c422e7070cb1cb45" +
  "42".repeat(64) +
  "01" +
  "24" +
  "04" +
  "686f6d65" +
  "08" +
  "7365637265743132";

describe("pairing data", () => {
  test("hand-assembled layout", () => {
    expect(toHex(encodePairingData(pairing))).toBe(pairingHex);
    expect(decodePairingData(fromHex(pairingHex))).toEqual({ ok: true, value: pairing });
  });

  test("Wi-Fi name and password may be empty, at their limits, or any bytes", () => {
    for (const [wifiName, wifiPassword] of [
      ["", ""],
      ["6e".repeat(32), "70".repeat(64)],
      ["ff00c3", "c328"],
    ] as const) {
      const data = { ...pairing, wifiName: fromHex(wifiName), wifiPassword: fromHex(wifiPassword) };
      expect(decodePairingData(encodePairingData(data))).toEqual({ ok: true, value: data });
    }
  });

  test("typed names are UTF-8, and limits count bytes, not characters", () => {
    expect(toHex(wifiBytes("Café"))).toBe("436166c3a9");
    expect(() => encodePairingData({ ...pairing, wifiName: wifiBytes("é".repeat(17)) })).toThrow(
      RangeError,
    );
    expect(() => encodePairingData({ ...pairing, wifiPassword: new Uint8Array(65) })).toThrow(
      RangeError,
    );
    expect(() => encodePairingData({ ...pairing, key: new Uint8Array(15) })).toThrow(RangeError);
    expect(() => encodePairingData({ ...pairing, address: 0 })).toThrow(RangeError);
  });

  test("truncated at every length", () => {
    const bytes = fromHex(pairingHex);
    for (let length = 0; length < bytes.length; length++) {
      expect(decodePairingData(bytes.subarray(0, length))).toEqual({
        ok: false,
        error: { code: "truncated" },
      });
    }
  });

  test("invalid fields are reported", () => {
    const bytes = fromHex(pairingHex);
    const withByte = (index: number, value: number) => {
      const copy = bytes.slice();
      copy[index] = value;
      return copy;
    };
    const nameAt = 1 + 4 + 16 + 8 + 64 + 2;
    expect(decodePairingData(withByte(0, 2))).toEqual({ ok: false, error: { code: "badVersion" } });
    expect(decodePairingData(concatBytes(fromHex("01ffffffff"), bytes.subarray(5)))).toEqual({
      ok: false,
      error: { code: "badAddress" },
    });
    expect(decodePairingData(withByte(nameAt, 33))).toEqual({
      ok: false,
      error: { code: "badLength" },
    });
    expect(
      decodePairingData(
        concatBytes(bytes.subarray(0, nameAt), fromHex("0041"), new Uint8Array(65)),
      ),
    ).toEqual({
      ok: false,
      error: { code: "badLength" },
    });
  });

  test("hub identity is the first 8 bytes of SHA-256 over the 64 key bytes", () => {
    // Expected values computed outside this package.
    expect(toHex(hubIdentity(new Uint8Array(64)))).toBe("f5a5fd42d16a2030");
    expect(toHex(hubIdentity(pairing.firmwareSigningKey))).toBe("c422e7070cb1cb45");
    expect(toHex(nodeSha256(new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(() => hubIdentity(new Uint8Array(65))).toThrow(RangeError);
  });

  test("decoding does not check the hub identity against the key", () => {
    const mismatched = { ...pairing, hubIdentity: new Uint8Array(8) };
    expect(decodePairingData(encodePairingData(mismatched))).toEqual({
      ok: true,
      value: mismatched,
    });
  });

  test("bytes after the password are ignored", () => {
    expect(decodePairingData(fromHex(pairingHex + "ffff"))).toEqual({ ok: true, value: pairing });
  });
});

describe("setup messages", () => {
  const identity: SetupMessage = {
    type: SetupType.Identity,
    role: 3,
    chipId: fromHex("a1b2c3d4e5f6"),
    firmwareVersion: { major: 1, minor: 2, patch: 3 },
    paired: true,
    hubIdentity: fromHex("1122334455667788"),
    developmentBuild: false,
  };

  test.each([
    ["identify", { type: SetupType.Identify }, "f101"],
    [
      "identity",
      identity,
      "f102" + "03" + "a1b2c3d4e5f6" + "010203" + "01" + "1122334455667788" + "00",
    ],
    ["provision", { type: SetupType.Provision, pairing }, "f103" + pairingHex],
    ["provision result", { type: SetupType.ProvisionResult, result: 2 }, "f104" + "02"],
    ["erase", { type: SetupType.Erase }, "f105"],
    ["set role", { type: SetupType.SetRole, role: 2 }, "f106" + "02"],
    ["set role, unlisted role", { type: SetupType.SetRole, role: 9 }, "f106" + "09"],
  ] satisfies [string, SetupMessage, string][])("%s, hand-assembled", (_, message, hex) => {
    expect(toHex(encodeSetupMessage(message))).toBe(hex);
    expect(decodeSetupMessage(fromHex(hex))).toEqual({ ok: true, value: message });
    expect(isSetupMessage(fromHex(hex))).toBe(true);
  });

  test("bytes after a setup message's fields are ignored", () => {
    const result: SetupMessage = { type: SetupType.ProvisionResult, result: 0 };
    for (const message of [identity, result, { type: SetupType.Identify } as const]) {
      const bytes = concatBytes(encodeSetupMessage(message), fromHex("00ff01"));
      expect(decodeSetupMessage(bytes)).toEqual({ ok: true, value: message });
    }
  });

  test("identity truncated at every length", () => {
    const bytes = encodeSetupMessage(identity);
    for (let length = 0; length < bytes.length; length++) {
      expect(decodeSetupMessage(bytes.subarray(0, length))).toEqual({
        ok: false,
        error: { code: "truncated" },
      });
    }
  });

  test("invalid setup messages are reported", () => {
    expect(decodeSetupMessage(fromHex("1001"))).toEqual({ ok: false, error: { code: "badValue" } });
    expect(decodeSetupMessage(fromHex("f100"))).toEqual({
      ok: false,
      error: { code: "unknownType", messageType: 0 },
    });
    expect(decodeSetupMessage(fromHex("f107"))).toEqual({
      ok: false,
      error: { code: "unknownType", messageType: 7 },
    });
    expect(decodeSetupMessage(fromHex("f106"))).toEqual({
      ok: false,
      error: { code: "truncated" },
    });
    const badPaired = encodeSetupMessage(identity);
    badPaired[12] = 2;
    expect(decodeSetupMessage(badPaired)).toEqual({ ok: false, error: { code: "badValue" } });
    expect(isSetupMessage(fromHex("10"))).toBe(false);
    expect(isSetupMessage(new Uint8Array(0))).toBe(false);
  });
});

/**
 * Firmware updates' wire formats (m3-updates-design.md sections 3, 5 and 7): Started's M3 fields,
 * transfer frames, CRC-32, the image header and its signature, and the Bluetooth session. Bytes
 * are written out by hand from the design's tables; the cryptography is checked against
 * node:crypto, not the library's own primitives.
 */
import { describe, expect, test } from "bun:test";
import { createECDH, createHmac, createPublicKey, hkdfSync, verify } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  concatBytes,
  decodeMessage,
  decodeStartedImage,
  Direction,
  encodeMessage,
  encodeStartedWithImage,
  fromHex,
  hubIdentity,
  isEnumValue,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  openPacket,
  Role,
  sealPacket,
  STARTED_IMAGE_OFFSET,
  STARTED_WITH_IMAGE_LENGTH,
  toHex,
  UpdateAction,
  UpdateReason,
} from "../src/index.ts";
import {
  ALL_ROLES_MASK,
  BLUETOOTH_UPDATE,
  bluetoothMaxData,
  bluetoothOpenTag,
  bluetoothSessionKey,
  bluetoothUpdateName,
  checkImageHeader,
  crc32,
  decodeImageHeader,
  decodeTransferFrame,
  encodeImageHeaderBody,
  encodeTransferFrame,
  IMAGE_HEADER,
  imageHeaderSignedBytes,
  imageIdOf,
  ImageTarget,
  isIntact,
  isTransferFrame,
  roleBit,
  signImageHeader,
  signingKeyIdentity,
  signingKeyOf,
  TRANSFER_LIMITS,
  TransferKind,
  verifyImageHeader,
} from "../src/update/index.ts";

const key = fromHex("000102030405060708090a0b0c0d0e0f");
const SENSOR = 0x1a2b3c4d;

const started: Message = {
  type: MessageType.Started,
  role: Role.Sensor,
  firmwareVersion: { major: 1, minor: 2, patch: 3 },
  resetCause: 1,
  lastFatalError: 0,
  settingsVersion: 3,
};
const v1 = "05" + "01" + "010203" + "01" + "0000" + "03";

describe("Started's M3 fields", () => {
  test("sit at offsets 8 (flags: bit 0 on trial, bit 1 rolled back) and 9 (failed version)", () => {
    expect(STARTED_IMAGE_OFFSET).toBe(8);
    expect(STARTED_WITH_IMAGE_LENGTH).toBe(12);
    expect(decodeStartedImage(fromHex(v1 + "01" + "000000"))).toEqual({
      ok: true,
      value: {
        flags: { onTrial: true, rolledBack: false },
        failedVersion: { major: 0, minor: 0, patch: 0 },
      },
    });
    expect(decodeStartedImage(fromHex(v1 + "02" + "010400"))).toEqual({
      ok: true,
      value: {
        flags: { onTrial: false, rolledBack: true },
        failedVersion: { major: 1, minor: 4, patch: 0 },
      },
    });
    // Unused flag bits are ignored, and bytes after the fields too.
    expect(decodeStartedImage(fromHex(v1 + "fd" + "090807" + "aabb"))).toEqual({
      ok: true,
      value: {
        flags: { onTrial: true, rolledBack: false },
        failedVersion: { major: 9, minor: 8, patch: 7 },
      },
    });
  });

  test("an 8-byte body is a Started from a device older than M3", () => {
    expect(decodeStartedImage(fromHex(v1))).toEqual({ ok: true, value: null });
  });

  test("9 to 11 bytes of body, or under 8, are truncated; another type is badValue", () => {
    for (const tail of ["01", "0101", "010104"])
      expect(decodeStartedImage(fromHex(v1 + tail))).toEqual({
        ok: false,
        error: { code: "truncated" },
      });
    expect(decodeStartedImage(fromHex(v1.slice(0, -2)))).toEqual({
      ok: false,
      error: { code: "truncated" },
    });
    expect(decodeStartedImage(new Uint8Array(0))).toEqual({
      ok: false,
      error: { code: "truncated" },
    });
    expect(decodeStartedImage(fromHex("06" + v1.slice(2)))).toEqual({
      ok: false,
      error: { code: "badValue" },
    });
  });

  test("decodeMessage reads the version-1 body whatever follows", () => {
    expect(decodeMessage(fromHex(v1 + "01" + "000000"))).toEqual({ ok: true, value: started });
  });

  test("encodeStartedWithImage appends exactly the four bytes", () => {
    const image = {
      flags: { onTrial: true, rolledBack: true },
      failedVersion: { major: 2, minor: 3, patch: 4 },
    };
    expect(toHex(encodeStartedWithImage(encodeMessage(started), image))).toBe(v1 + "03" + "020304");
    expect(() => encodeStartedWithImage(fromHex(v1 + "00"), image)).toThrow(RangeError);
    expect(() => encodeStartedWithImage(fromHex("06" + v1.slice(2)), image)).toThrow(RangeError);
  });

  test("seal and open carry the fields, and leave an 8-byte Started as it was", () => {
    const options = {
      key,
      direction: Direction.ToHub,
      address: SENSOR,
      counter: 77,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
    } as const;
    const open = {
      key,
      expectedDirection: Direction.ToHub,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
    } as const;
    const image = {
      flags: { onTrial: false, rolledBack: true },
      failedVersion: { major: 1, minor: 0, patch: 9 },
    };
    const withImage = openPacket(sealPacket(started, { ...options, startedImage: image }), open);
    expect(withImage.ok && withImage.value.startedImage).toEqual(image);
    expect(withImage.ok && withImage.value.message).toEqual(started);
    const plain = openPacket(sealPacket(started, options), open);
    expect(plain.ok && "startedImage" in plain.value).toBe(false);
    const heartbeat: Message = {
      type: MessageType.Heartbeat,
      settingsVersion: 0,
      flags: {
        doorOpen: false,
        coverOpen: false,
        usbPower: false,
        charging: false,
        replyWanted: false,
        localAlarmSounded: false,
        buzzing: false,
        listeningAtSendRate: false,
      },
      batteryCode: 0,
      temperatureCelsius: 0,
      doorChangeCount: 0,
      eventAgeSeconds: 0,
    };
    expect(() => sealPacket(heartbeat, { ...options, startedImage: image })).toThrow(RangeError);
  });
});

describe("transfer frames", () => {
  const id = "1122334455667788";
  const idBytes = fromHex(id);

  test.each([
    [
      "Get",
      { kind: TransferKind.Get, imageId: idBytes, offset: 0x01020304, length: 1000 },
      "f201" + id + "04030201" + "e803",
    ],
    ["Gone", { kind: TransferKind.Gone, imageId: idBytes, reason: 3 }, "f203" + id + "03"],
    [
      "Hello",
      {
        kind: TransferKind.Hello,
        address: SENSOR,
        deviceRandom: fromHex("c0c1c2c3c4c5c6c7"),
        imageId: idBytes,
        bytesHeld: 0x10000,
        largestData: 496,
      },
      "f210" + "4d3c2b1a" + "c0c1c2c3c4c5c6c7" + id + "00000100" + "f001",
    ],
    [
      "Open",
      { kind: TransferKind.Open, tag: fromHex("000102030405060708090a0b0c0d0e0f") },
      "f211" + "000102030405060708090a0b0c0d0e0f",
    ],
    [
      "Done",
      { kind: TransferKind.Done, imageId: idBytes, result: 1, reason: 10 },
      "f212" + id + "01" + "0a",
    ],
  ] as const)("%s, written out by hand", (_, frame, bytes) => {
    const encoded = encodeTransferFrame(frame);
    expect(encoded.ok && toHex(encoded.value)).toBe(bytes);
    expect(decodeTransferFrame(fromHex(bytes))).toEqual({ ok: true, value: frame });
  });

  test("Data carries the CRC-32 of its data at offset 14, the data from offset 18", () => {
    const data = new TextEncoder().encode("123456789");
    const encoded = encodeTransferFrame({
      kind: TransferKind.Data,
      imageId: idBytes,
      offset: 128,
      data,
    });
    expect(encoded.ok && toHex(encoded.value)).toBe(
      "f202" + id + "80000000" + "2639f4cb" + toHex(data),
    );
    expect(TRANSFER_LIMITS.dataHeaderBytes).toBe(18);
    const decoded = decodeTransferFrame(
      fromHex("f202" + id + "80000000" + "2639f4cb" + toHex(data)),
    );
    if (!decoded.ok || decoded.value.kind !== TransferKind.Data) throw new Error("not Data");
    expect(decoded.value.crc32).toBe(0xcbf43926);
    expect(isIntact(decoded.value)).toBe(true);
    expect(
      isIntact({ ...decoded.value, data: fromHex("313233343536373839".replace(/39$/, "38")) }),
    ).toBe(false);
  });

  test("the prefix, unknown kinds and short frames", () => {
    expect(isTransferFrame(fromHex("f201"))).toBe(true);
    expect(isTransferFrame(fromHex("f101"))).toBe(false);
    expect(decodeTransferFrame(fromHex("f1" + "01"))).toEqual({
      ok: false,
      error: { code: "badValue" },
    });
    expect(decodeTransferFrame(fromHex("f205"))).toEqual({
      ok: false,
      error: { code: "unknownType", messageType: 5 },
    });
    expect(decodeTransferFrame(fromHex("f2"))).toEqual({ ok: false, error: { code: "truncated" } });
    const get = "f201" + id + "00000000" + "0100";
    for (let n = 2; n < get.length / 2; n++)
      expect(decodeTransferFrame(fromHex(get).subarray(0, n))).toEqual({
        ok: false,
        error: { code: "truncated" },
      });
  });

  test("a Get or Data of 1 to 1,000 bytes, and nothing else", () => {
    const get = (n: number) =>
      "f201" +
      id +
      "00000000" +
      n
        .toString(16)
        .padStart(4, "0")
        .replace(/(..)(..)/, "$2$1");
    expect(decodeTransferFrame(fromHex(get(1))).ok).toBe(true);
    expect(decodeTransferFrame(fromHex(get(1000))).ok).toBe(true);
    expect(decodeTransferFrame(fromHex(get(0)))).toEqual({
      ok: false,
      error: { code: "badValue" },
    });
    expect(decodeTransferFrame(fromHex(get(1001)))).toEqual({
      ok: false,
      error: { code: "badValue" },
    });
    const data = (n: number) => fromHex("f202" + id + "00000000" + "00000000" + "aa".repeat(n));
    expect(decodeTransferFrame(data(1000)).ok).toBe(true);
    expect(decodeTransferFrame(data(1001))).toEqual({ ok: false, error: { code: "tooLong" } });
    expect(decodeTransferFrame(data(0))).toEqual({ ok: false, error: { code: "truncated" } });
  });

  test("encoding refuses what does not fit, without throwing", () => {
    const bad = [
      { kind: TransferKind.Get, imageId: fromHex("11223344556677"), offset: 0, length: 1 },
      { kind: TransferKind.Get, imageId: idBytes, offset: 2 ** 32, length: 1 },
      { kind: TransferKind.Get, imageId: idBytes, offset: -1, length: 1 },
      { kind: TransferKind.Get, imageId: idBytes, offset: 0, length: 0 },
      { kind: TransferKind.Get, imageId: idBytes, offset: 0, length: 1001 },
      { kind: TransferKind.Data, imageId: idBytes, offset: 0, data: new Uint8Array(0) },
      { kind: TransferKind.Data, imageId: idBytes, offset: 0, data: new Uint8Array(1001) },
      { kind: TransferKind.Gone, imageId: idBytes, reason: 256 },
      { kind: TransferKind.Open, tag: new Uint8Array(15) },
      { kind: TransferKind.Done, imageId: idBytes, result: 0, reason: -1 },
      {
        kind: TransferKind.Hello,
        address: SENSOR,
        deviceRandom: new Uint8Array(7),
        imageId: idBytes,
        bytesHeld: 0,
        largestData: 0,
      },
      {
        kind: TransferKind.Hello,
        address: SENSOR,
        deviceRandom: new Uint8Array(8),
        imageId: idBytes,
        bytesHeld: 0,
        largestData: 0x10000,
      },
    ] as const;
    for (const frame of bad)
      expect(encodeTransferFrame(frame)).toEqual({ ok: false, error: { code: "badValue" } });
  });

  test("Bluetooth data at an MTU: 164 at 185, 496 at 517, never above 1,000", () => {
    expect(bluetoothMaxData(185)).toBe(164);
    expect(bluetoothMaxData(517)).toBe(496);
    expect(bluetoothMaxData(5000)).toBe(1000);
    expect(bluetoothMaxData(10)).toBe(0);
  });
});

describe("CRC-32", () => {
  test("the check value, and agreement with Bun's CRC-32 on many inputs", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    for (let length = 0; length < 300; length += 7) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 0xff);
      expect(crc32(bytes)).toBe(Bun.hash.crc32(bytes));
    }
  });
});

describe("the image header", () => {
  const scalar = fromHex("c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(scalar);
  const signingKey = new Uint8Array(ecdh.getPublicKey(null, "uncompressed")).slice(1);
  const fields = {
    flags: { ownBuild: true },
    roles: roleBit(Role.Siren) | roleBit(Role.Gateway),
    target: ImageTarget.OurEsp32s3Board,
    version: { major: 1, minor: 2, patch: 3 },
    imageBytes: 0x00180000,
    imageSha256: fromHex("a0".repeat(16) + "b1".repeat(16)),
    hubIdentity: fromHex("0102030405060708"),
  };
  const bodyHex =
    "48534e49" +
    "01" +
    "01" +
    "0c" +
    "01" +
    "010203" +
    "00" +
    "00001800" +
    "a0".repeat(16) +
    "b1".repeat(16) +
    "0102030405060708" +
    "0000000000000000";

  test("bytes 0 to 63, written out by hand", () => {
    const body = encodeImageHeaderBody(fields);
    expect(body.ok && toHex(body.value)).toBe(bodyHex);
    expect(ALL_ROLES_MASK).toBe(0x0e);
    expect(IMAGE_HEADER.bytes).toBe(128);
  });

  test("the signature is ECDSA P-256 over SHA-256 of the label, a zero byte and bytes 0 to 63", () => {
    const header = signImageHeader(fields, scalar);
    if (!header.ok) throw new Error("not signed");
    expect(header.value.length).toBe(128);
    expect(toHex(header.value.subarray(0, 64))).toBe(bodyHex);
    const signed = concatBytes(
      new TextEncoder().encode("hsn-image/1"),
      Uint8Array.of(0),
      fromHex(bodyHex),
    );
    expect(toHex(imageHeaderSignedBytes(fromHex(bodyHex)))).toBe(toHex(signed));
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(signingKey.subarray(0, 32)).toString("base64url"),
        y: Buffer.from(signingKey.subarray(32)).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        signed,
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        header.value.subarray(64),
      ),
    ).toBe(true);
    expect(verifyImageHeader(header.value, signingKey)).toBe(true);
    // Deterministic, hashed once, and s not normalised: RFC 6979's own signature.
    expect(toHex(header.value.subarray(64))).toBe(
      toHex(p256.sign(sha256(signed), scalar, { prehash: false, lowS: false, format: "compact" })),
    );
    expect(toHex(signImageHeader(fields, scalar).ok ? header.value : new Uint8Array(0))).toBe(
      toHex(header.value),
    );
  });

  test("RFC 6979 A.2.5's signature of 'sample', under the same options", () => {
    const sig = p256.sign(new TextEncoder().encode("sample"), scalar, {
      prehash: true,
      lowS: false,
      format: "compact",
    });
    expect(toHex(sig)).toBe(
      "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716" +
        "f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8",
    );
  });

  test("any changed byte of the 128 fails verification", () => {
    const header = signImageHeader(fields, scalar);
    if (!header.ok) throw new Error("not signed");
    for (let i = 0; i < 128; i++) {
      const copy = header.value.slice();
      copy[i] = (copy[i] ?? 0) ^ 0x01;
      expect([i, verifyImageHeader(copy, signingKey)]).toEqual([i, false]);
    }
    expect(verifyImageHeader(header.value, new Uint8Array(64))).toBe(false);
    expect(verifyImageHeader(header.value.subarray(0, 127), signingKey)).toBe(false);
    const garbage = concatBytes(header.value.subarray(0, 64), new Uint8Array(64).fill(0xff));
    expect(verifyImageHeader(garbage, signingKey)).toBe(false);
  });

  test("decoding: magic, format and zero bytes; target, flags and roles as read", () => {
    const header = signImageHeader(fields, scalar);
    if (!header.ok) throw new Error("not signed");
    const decoded = decodeImageHeader(header.value);
    expect(decoded.ok && decoded.value).toEqual({ ...fields, signature: header.value.slice(64) });
    const at = (i: number, v: number) => {
      const copy = header.value.slice();
      copy[i] = v;
      return decodeImageHeader(copy);
    };
    expect(at(0, 0x49)).toEqual({ ok: false, error: { code: "badValue" } });
    expect(at(4, 2)).toEqual({ ok: false, error: { code: "badVersion" } });
    expect(at(11, 1)).toEqual({ ok: false, error: { code: "badValue" } });
    for (let i = 56; i < 64; i++)
      expect(at(i, 1)).toEqual({ ok: false, error: { code: "badValue" } });
    const target = at(7, 9);
    expect(target.ok && target.value.target).toBe(9);
    const flags = at(5, 0xfe);
    expect(flags.ok && flags.value.flags).toEqual({ ownBuild: false });
    expect(decodeImageHeader(header.value.subarray(0, 127))).toEqual({
      ok: false,
      error: { code: "truncated" },
    });
    expect(toHex(imageIdOf(header.value))).toBe("a0".repeat(8));
  });

  test("the signer's identity and public key", () => {
    expect(toHex(signingKeyIdentity(signingKey))).toBe(toHex(hubIdentity(signingKey)));
    expect(toHex(signingKeyOf(scalar) ?? new Uint8Array(0))).toBe(toHex(signingKey));
    expect(signingKeyOf(new Uint8Array(32))).toBeUndefined();
    expect(signImageHeader(fields, new Uint8Array(32))).toEqual({
      ok: false,
      error: { code: "badValue" },
    });
    expect(signImageHeader({ ...fields, imageBytes: 2 ** 32 }, scalar)).toEqual({
      ok: false,
      error: { code: "badValue" },
    });
    expect(signImageHeader({ ...fields, hubIdentity: new Uint8Array(7) }, scalar)).toEqual({
      ok: false,
      error: { code: "badValue" },
    });
  });

  test("a device's checks, in order", () => {
    const mine = { ...fields, hubIdentity: signingKeyIdentity(signingKey) };
    const header = signImageHeader(mine, scalar);
    if (!header.ok) throw new Error("not signed");
    const expect0 = {
      hubIdentity: mine.hubIdentity,
      signingKey,
      role: Role.Siren,
      capacity: mine.imageBytes,
    };
    expect(checkImageHeader(header.value, expect0)).toBe(UpdateReason.None);
    expect(checkImageHeader(header.value, { ...expect0, role: Role.Sensor })).toBe(
      UpdateReason.WrongRole,
    );
    expect(checkImageHeader(header.value, { ...expect0, capacity: mine.imageBytes - 1 })).toBe(
      UpdateReason.TooLarge,
    );
    expect(checkImageHeader(header.value, { ...expect0, hubIdentity: new Uint8Array(8) })).toBe(
      UpdateReason.WrongHub,
    );
    const target = header.value.slice();
    target[7] = 2;
    expect(checkImageHeader(target, expect0)).toBe(UpdateReason.BadHeader);
    const signature = header.value.slice();
    signature[127] = (signature[127] ?? 0) ^ 0x80;
    expect(checkImageHeader(signature, expect0)).toBe(UpdateReason.BadSignature);
  });
});

describe("the Bluetooth update session", () => {
  const nonce = fromHex("5a5b5c5d5e5f6061");
  const address = 0x01020304;

  test("K is HKDF-SHA256 with the nonce as salt and the label, a zero byte and the address LE as info", () => {
    const info = concatBytes(
      new TextEncoder().encode("hsn-ble-update/1"),
      fromHex("00" + "04030201"),
    );
    const expected = new Uint8Array(hkdfSync("sha256", key, nonce, info, 32));
    const k = bluetoothSessionKey(key, nonce, address);
    expect(k.ok && toHex(k.value)).toBe(toHex(expected));
    const other = bluetoothSessionKey(key, nonce, 0x04030201);
    expect(other.ok && toHex(other.value)).not.toBe(toHex(expected));
  });

  test("the tag is the first 16 bytes of HMAC-SHA256 over label, address LE, random, image id", () => {
    const k = fromHex("aa".repeat(32));
    const random = fromHex("c0c1c2c3c4c5c6c7");
    const id = fromHex("1122334455667788");
    const message = concatBytes(
      new TextEncoder().encode("hsn-ble-open/1"),
      fromHex("00" + "04030201"),
      random,
      id,
    );
    const expected = createHmac("sha256", k).update(message).digest().subarray(0, 16);
    const tag = bluetoothOpenTag(k, address, random, id);
    expect(tag.ok && toHex(tag.value)).toBe(toHex(expected));
  });

  test("wrong sizes are badValue", () => {
    const bad = { ok: false, error: { code: "badValue" } } as const;
    expect(bluetoothSessionKey(new Uint8Array(15), nonce, address)).toEqual(bad);
    expect(bluetoothSessionKey(key, new Uint8Array(9), address)).toEqual(bad);
    expect(bluetoothSessionKey(key, nonce, 2 ** 32)).toEqual(bad);
    const k = new Uint8Array(32);
    expect(bluetoothOpenTag(new Uint8Array(31), 1, new Uint8Array(8), new Uint8Array(8))).toEqual(
      bad,
    );
    expect(bluetoothOpenTag(k, 1, new Uint8Array(7), new Uint8Array(8))).toEqual(bad);
    expect(bluetoothOpenTag(k, 1, new Uint8Array(8), new Uint8Array(9))).toEqual(bad);
  });

  test("the device's name and the service's values", () => {
    expect(bluetoothUpdateName(0x1a2b3c4d)).toBe("hsn-1a2b3c4d");
    expect(bluetoothUpdateName(1)).toBe("hsn-00000001");
    expect(BLUETOOTH_UPDATE.serviceUuid).toBe("1012a7e5-5d53-44e0-9170-6c34720148a4");
    expect(BLUETOOTH_UPDATE.rxUuid).toBe("9e848f59-78c5-4f7e-b604-38d088ceda4f");
    expect(BLUETOOTH_UPDATE.txUuid).toBe("0a218c6e-e0b9-4cfe-9580-e13887bcd840");
    expect(BLUETOOTH_UPDATE.requestedMtu).toBe(517);
    expect(BLUETOOTH_UPDATE.windowMs / BLUETOOTH_UPDATE.windowUnitMs).toBe(12);
  });
});

describe("the update offer's actions (m3-updates-design.md section 5)", () => {
  test("0 to 6 are listed, 6 being a fetch that does not wait for a quiet radio; 7 is not", () => {
    expect(UpdateAction).toEqual({
      Nothing: 0,
      Fetch: 1,
      JoinWifiAndFetch: 2,
      OpenBluetooth: 3,
      InstallNow: 4,
      KeepAndWait: 5,
      ForcedFetch: 6,
    });
    for (const action of [0, 1, 2, 3, 4, 5, 6])
      expect(isEnumValue(UpdateAction, action)).toBe(true);
    expect(isEnumValue(UpdateAction, 7)).toBe(false);
    expect(isEnumValue(UpdateAction, 255)).toBe(false);
  });

  test("action 6 is byte 0 of the body, written out by hand; an unlisted 7 passes through", () => {
    const body = "a1b2c3d4e5f60718" + "00001000" + "020001" + "0000000000000000" + "00";
    const offer = {
      type: MessageType.UpdateOffer,
      action: UpdateAction.ForcedFetch,
      imageId: fromHex("a1b2c3d4e5f60718"),
      fileBytes: 1_048_576,
      version: { major: 2, minor: 0, patch: 1 },
      bluetoothNonce: new Uint8Array(8),
      bluetoothWindowUnits: 0,
    } as const;
    expect(toHex(encodeMessage(offer))).toBe("83" + "06" + body);
    expect(decodeMessage(fromHex("83" + "06" + body))).toEqual({
      ok: true,
      value: offer,
    });
    expect(decodeMessage(fromHex("83" + "07" + body))).toEqual({
      ok: true,
      value: { ...offer, action: 7 },
    });
  });
});

/**
 * Firmware update vectors (m3-updates-design.md sections 3 and 5): Started with its M3 fields,
 * transfer frames and CRC-32, the signed image header and the device's checks of it, and the
 * Bluetooth update session's key and tag. The update messages themselves (0x06, 0x07, 0x83,
 * 0x84) are ordinary message files, made from packetCases.ts.
 */
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import {
  concatBytes,
  decodeStartedImage,
  Direction,
  encodeStartedWithImage,
  encodeMessage,
  fromHex,
  MaxPacketLength,
  type MessageOf,
  MessageType,
  NO_BINDING,
  openPacket,
  Role,
  sealPacket,
  type StartedImage,
  sessionBinding,
  toHex,
  UpdateReason,
} from "../../src/index.ts";
import {
  ALL_ROLES_MASK,
  BLUETOOTH_UPDATE,
  bluetoothOpenTag,
  bluetoothSessionKey,
  bluetoothUpdateName,
  checkImageHeader,
  crc32,
  decodeTransferFrame,
  encodeImageHeaderBody,
  encodeTransferFrame,
  GoneReason,
  type HeaderExpectations,
  IMAGE_HEADER,
  imageHeaderSignedBytes,
  imageIdOf,
  ImageTarget,
  isIntact,
  roleBit,
  signImageHeader,
  signingKeyIdentity,
  type TransferFrameToSend,
  TransferKind,
  TRANSFER_PREFIX,
  TransferResult,
} from "../../src/update/index.ts";
import {
  type Device,
  gateway,
  gatewayRandom,
  hubRandom,
  patternBytes,
  sensor,
  siren,
} from "./devices.ts";
import { errorJson, type Json, type JsonObject, toJson } from "./json.ts";
import { sealRaw } from "./packets.ts";
import { signingPrivateKey, signingPublicKey } from "./signingKey.ts";

const must = <T>(result: { ok: true; value: T } | { ok: false }, what: string): T => {
  if (!result.ok) throw new Error(`vector generation: ${what}`);
  return result.value;
};

// ----- Started with its M3 fields -----

interface StartedCase {
  readonly name: string;
  readonly device: Device;
  readonly counter: number;
  readonly binding: Uint8Array;
  readonly maxLength: MaxPacketLength;
  readonly message: MessageOf<typeof MessageType.Started>;
  /** Null: an 8-byte body, as an M1a device sends it. */
  readonly image: StartedImage | null;
}

const started = (
  role: Role,
  major: number,
  minor: number,
  patch: number,
): MessageOf<typeof MessageType.Started> => ({
  type: MessageType.Started,
  role,
  firmwareVersion: { major, minor, patch },
  resetCause: 1,
  lastFatalError: 0,
  settingsVersion: 3,
});

const startedCases: readonly StartedCase[] = [
  {
    name: "sensor started on trial after an update",
    device: sensor,
    counter: 320,
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Radio,
    message: started(Role.Sensor, 1, 4, 0),
    image: {
      flags: { onTrial: true, rolledBack: false },
      failedVersion: { major: 0, minor: 0, patch: 0 },
    },
  },
  {
    name: "sensor started after a rollback, naming the failed version",
    device: sensor,
    counter: 321,
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Radio,
    message: started(Role.Sensor, 1, 3, 2),
    image: {
      flags: { onTrial: false, rolledBack: true },
      failedVersion: { major: 1, minor: 4, patch: 0 },
    },
  },
  {
    name: "siren started on a confirmed image, nothing to report",
    device: siren,
    counter: 5200,
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Link,
    message: started(Role.Siren, 2, 0, 1),
    image: {
      flags: { onTrial: false, rolledBack: false },
      failedVersion: { major: 0, minor: 0, patch: 0 },
    },
  },
  {
    name: "gateway started on trial, on its connection",
    device: gateway,
    counter: 42,
    binding: sessionBinding(gatewayRandom, hubRandom),
    maxLength: MaxPacketLength.Link,
    message: started(Role.Gateway, 2, 0, 1),
    image: {
      flags: { onTrial: true, rolledBack: true },
      failedVersion: { major: 2, minor: 0, patch: 0 },
    },
  },
  {
    name: "sensor started without the M3 fields, as an M1a device sends it",
    device: sensor,
    counter: 322,
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Radio,
    message: started(Role.Sensor, 1, 2, 3),
    image: null,
  },
];

const nullable = (value: StartedImage | null): Json => (value === null ? null : toJson(value));

function startedCaseJson(c: StartedCase): JsonObject {
  const version1 = encodeMessage(c.message);
  const plaintext = c.image === null ? version1 : encodeStartedWithImage(version1, c.image);
  const sealed = sealRaw({
    device: c.device,
    direction: Direction.ToHub,
    counter: c.counter,
    binding: c.binding,
    plaintext,
  });
  const options = {
    key: c.device.key,
    direction: Direction.ToHub,
    address: c.device.address,
    counter: c.counter,
    binding: c.binding,
    maxLength: c.maxLength,
  } as const;
  const fromLibrary =
    c.image === null
      ? sealPacket(c.message, options)
      : sealPacket(c.message, { ...options, startedImage: c.image });
  if (toHex(fromLibrary) !== toHex(sealed.packet)) throw new Error(`encoder differs: ${c.name}`);
  const opened = openPacket(sealed.packet, {
    key: c.device.key,
    expectedDirection: Direction.ToHub,
    binding: c.binding,
    maxLength: c.maxLength,
  });
  const image = must(decodeStartedImage(plaintext), c.name);
  if (
    !opened.ok ||
    JSON.stringify(nullable(opened.value.startedImage ?? null)) !== JSON.stringify(nullable(image))
  ) {
    throw new Error(`does not open to its image: ${c.name}`);
  }
  if (JSON.stringify(nullable(image)) !== JSON.stringify(nullable(c.image))) {
    throw new Error(`does not decode to its image: ${c.name}`);
  }
  const fields = Object.fromEntries(Object.entries(c.message).filter(([k]) => k !== "type"));
  return {
    name: c.name,
    key: toHex(c.device.key),
    direction: Direction.ToHub,
    address: c.device.address,
    counter: c.counter,
    binding: toHex(c.binding),
    maxLength: c.maxLength,
    messageType: MessageType.Started,
    fields: toJson(fields),
    image: nullable(c.image),
    plaintext: toHex(plaintext),
    nonce: toHex(sealed.nonce),
    associatedData: toHex(sealed.associatedData),
    packet: toHex(sealed.packet),
  };
}

/** Started plaintexts whose M3 fields cannot be read. */
const startedInvalid: readonly (readonly [string, string])[] = [
  ["one byte of the M3 fields", "05" + "0101020301000003" + "01"],
  ["two bytes of the M3 fields", "05" + "0101020301000003" + "0101"],
  ["three bytes of the M3 fields", "05" + "0101020301000003" + "010104"],
  ["a version-1 body cut short", "05" + "01010203010000"],
];

function startedUpdateFile(): JsonObject {
  return {
    valid: startedCases.map(startedCaseJson),
    invalid: startedInvalid.map(([name, plaintext]) => {
      const result = decodeStartedImage(fromHex(plaintext));
      if (result.ok) throw new Error(`accepted: ${name}`);
      return { name, plaintext, ...errorJson(result.error) };
    }),
  };
}

// ----- Transfer frames and CRC-32 -----

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

const crcCases: readonly (readonly [string, Uint8Array])[] = [
  ["empty", new Uint8Array(0)],
  ["the check value: ASCII 123456789", ascii("123456789")],
  ["one zero byte", fromHex("00")],
  ["four 0xff bytes", fromHex("ffffffff")],
  ["1,000 bytes of pattern, a full Data frame", patternBytes(1000, 11)],
];

const imageId = fromHex("1122334455667788");
const pieceData = patternBytes(1000, 5);

const frameCases: readonly (readonly [string, TransferFrameToSend])[] = [
  ["Get the header", { kind: TransferKind.Get, imageId, offset: 0, length: 128 }],
  ["Get 1,000 bytes at 64 KiB", { kind: TransferKind.Get, imageId, offset: 65_536, length: 1000 }],
  [
    "Get 1 byte at the last offset",
    { kind: TransferKind.Get, imageId, offset: 0xffffffff, length: 1 },
  ],
  ["Data, 1,000 bytes", { kind: TransferKind.Data, imageId, offset: 65_536, data: pieceData }],
  ["Data, one byte", { kind: TransferKind.Data, imageId, offset: 7, data: fromHex("a5") }],
  [
    "Data, 164 bytes, the most at an MTU of 185",
    { kind: TransferKind.Data, imageId, offset: 128, data: patternBytes(164, 9) },
  ],
  ["Gone, paused", { kind: TransferKind.Gone, imageId, reason: GoneReason.Paused }],
  ["Gone, out of range", { kind: TransferKind.Gone, imageId, reason: GoneReason.OutOfRange }],
  [
    "Gone, unlisted reason 9, which passes through",
    { kind: TransferKind.Gone, imageId, reason: 9 },
  ],
  [
    "Hello from a sensor holding nothing, at an MTU of 517",
    {
      kind: TransferKind.Hello,
      address: sensor.address,
      deviceRandom: fromHex("c0c1c2c3c4c5c6c7"),
      imageId,
      bytesHeld: 0,
      largestData: 496,
    },
  ],
  [
    "Hello from a sensor resuming at its checkpoint",
    {
      kind: TransferKind.Hello,
      address: sensor.address,
      deviceRandom: fromHex("d0d1d2d3d4d5d6d7"),
      imageId,
      bytesHeld: 196_608,
      largestData: 164,
    },
  ],
  ["Open", { kind: TransferKind.Open, tag: fromHex("000102030405060708090a0b0c0d0e0f") }],
  [
    "Done, verified",
    {
      kind: TransferKind.Done,
      imageId,
      result: TransferResult.Verified,
      reason: UpdateReason.None,
    },
  ],
  [
    "Done, refused: hash mismatch",
    {
      kind: TransferKind.Done,
      imageId,
      result: TransferResult.Refused,
      reason: UpdateReason.HashMismatch,
    },
  ],
];

const dataFrameHex = (crc: string, data: string): string =>
  "f202" + "1122334455667788" + "07000000" + crc + data;

/** Decode-only frames a receiver must take as they are. */
const frameVariations: readonly (readonly [string, string])[] = [
  [
    "Gone with two bytes after its fields, which receivers ignore",
    "f203" + "1122334455667788" + "02" + "eeff",
  ],
  [
    "Data whose CRC does not match its data: read, then dropped by the receiver",
    dataFrameHex("00000000", "a5"),
  ],
];

const frameInvalid: readonly (readonly [string, string])[] = [
  ["empty", ""],
  ["the prefix alone", "f2"],
  ["a packet's first byte, not a frame", "10" + "01"],
  ["a setup message's first byte, not a frame", "f1" + "01"],
  ["unknown kind 0x04", "f204" + "1122334455667788"],
  ["Get cut short", "f201" + "1122334455667788" + "00000000" + "80"],
  ["Get of 0 bytes", "f201" + "1122334455667788" + "00000000" + "0000"],
  ["Get of 1,001 bytes", "f201" + "1122334455667788" + "00000000" + "e903"],
  ["Data with no data", "f202" + "1122334455667788" + "00000000" + "00000000"],
  ["Data with 1,001 bytes", dataFrameHex("00000000", "00".repeat(1001))],
  [
    "Hello cut short",
    "f210" + "4d3c2b1a" + "c0c1c2c3c4c5c6c7" + "1122334455667788" + "00000000" + "f0",
  ],
  ["Open with a 15-byte tag", "f211" + "000102030405060708090a0b0c0d0e"],
  ["Done cut short", "f212" + "1122334455667788" + "00"],
];

function frameFieldsJson(frame: object): Json {
  return toJson(Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "kind")));
}

function transferFile(): JsonObject {
  return {
    prefix: TRANSFER_PREFIX,
    crc32: crcCases.map(([name, data]) => ({ name, data: toHex(data), crc32: crc32(data) })),
    valid: [
      ...frameCases.map(([name, frame]) => {
        const bytes = must(encodeTransferFrame(frame), name);
        const decoded = must(decodeTransferFrame(bytes), name);
        return {
          name,
          canonical: true,
          kind: frame.kind,
          fields: frameFieldsJson(decoded),
          ...(decoded.kind === TransferKind.Data ? { intact: isIntact(decoded) } : {}),
          bytes: toHex(bytes),
        };
      }),
      ...frameVariations.map(([name, hex]) => {
        const decoded = must(decodeTransferFrame(fromHex(hex)), name);
        return {
          name,
          canonical: false,
          kind: decoded.kind,
          fields: frameFieldsJson(decoded),
          ...(decoded.kind === TransferKind.Data ? { intact: isIntact(decoded) } : {}),
          bytes: hex,
        };
      }),
    ],
    invalid: frameInvalid.map(([name, hex]) => {
      const result = decodeTransferFrame(fromHex(hex));
      if (result.ok) throw new Error(`accepted: ${name}`);
      return { name, bytes: hex, ...errorJson(result.error) };
    }),
  };
}

// ----- The image header -----

const signingKey = signingPublicKey(signingPrivateKey);
const hubId = signingKeyIdentity(signingKey);
/** A second key, for a header the paired hub did not sign: RFC 6979 A.2.5's key plus one. */
const otherPrivateKey = fromHex("c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6722");

const image = patternBytes(1000, 3);
const imageSha = new Uint8Array(createHash("sha256").update(image).digest());

const officialFields = {
  flags: { ownBuild: false },
  roles: ALL_ROLES_MASK,
  target: ImageTarget.OurEsp32s3Board,
  version: { major: 1, minor: 4, patch: 0 },
  imageBytes: image.length,
  imageSha256: imageSha,
  hubIdentity: hubId,
} as const;

const headerCases = [
  ["an official image for every role", officialFields],
  [
    "an owner's own build for sensors only",
    {
      ...officialFields,
      flags: { ownBuild: true },
      roles: roleBit(Role.Sensor),
      version: { major: 0, minor: 0, patch: 1 },
    },
  ],
  [
    "the largest version and size fields",
    {
      ...officialFields,
      version: { major: 255, minor: 255, patch: 255 },
      imageBytes: 3_670_016,
    },
  ],
] as const;

const official = must(signImageHeader(officialFields, signingPrivateKey), "official header");

function withBytes(bytes: Uint8Array, changes: Readonly<Record<number, number>>): Uint8Array {
  const copy = bytes.slice();
  for (const [at, value] of Object.entries(changes)) copy[Number(at)] = value;
  return copy;
}

/** Signs a raw 64-byte body, so a case can hold bits `signImageHeader` never writes. */
function signBody(body: Uint8Array): Uint8Array {
  const signature = p256.sign(imageHeaderSignedBytes(body), signingPrivateKey, {
    prehash: true,
    lowS: false,
    format: "compact",
  });
  return concatBytes(body, signature);
}

/** The official header with every unused flag and role bit set, signed again. */
function withUnusedBits(): Uint8Array {
  const body = must(encodeImageHeaderBody(officialFields), "body");
  return signBody(withBytes(body, { 5: 0xfe, 6: 0xff }));
}

const sensorExpect: HeaderExpectations = {
  hubIdentity: hubId,
  signingKey,
  role: Role.Sensor,
  capacity: 3_670_016,
};

const checkCases: readonly (readonly [string, Uint8Array, HeaderExpectations])[] = [
  ["passes every check", official, sensorExpect],
  [
    "an image exactly the slot's size passes",
    official,
    { ...sensorExpect, capacity: image.length },
  ],
  ["wrong magic", withBytes(official, { 3: 0x58 }), sensorExpect],
  ["format 2", withBytes(official, { 4: 2 }), sensorExpect],
  ["target 2", withBytes(official, { 7: 2 }), sensorExpect],
  ["byte 11 not zero", withBytes(official, { 11: 1 }), sensorExpect],
  ["byte 63 not zero", withBytes(official, { 63: 1 }), sensorExpect],
  ["cut to 127 bytes", official.subarray(0, 127), sensorExpect],
  [
    "another hub's identity",
    official,
    { ...sensorExpect, hubIdentity: fromHex("0102030405060708") },
  ],
  [
    "a sensor-only image on a siren",
    must(
      signImageHeader({ ...officialFields, roles: roleBit(Role.Sensor) }, signingPrivateKey),
      "sensor only",
    ),
    { ...sensorExpect, role: Role.Siren },
  ],
  ["one byte over the slot", official, { ...sensorExpect, capacity: image.length - 1 }],
  [
    "a signature byte changed",
    withBytes(official, { 100: (official[100] ?? 0) ^ 1 }),
    sensorExpect,
  ],
  ["the version changed after signing", withBytes(official, { 10: 1 }), sensorExpect],
  [
    "signed by another key",
    must(signImageHeader(officialFields, otherPrivateKey), "other key"),
    sensorExpect,
  ],
  ["unused flag and role bits set, then signed: ignored", withUnusedBits(), sensorExpect],
  // Two rules broken at once: the earlier check names the refusal (section 3's order).
  [
    "target 2 and another hub: the header is checked first",
    withBytes(official, { 7: 2 }),
    { ...sensorExpect, hubIdentity: fromHex("0102030405060708") },
  ],
  [
    "another hub and the wrong role: the hub is checked first",
    must(
      signImageHeader({ ...officialFields, roles: roleBit(Role.Sensor) }, signingPrivateKey),
      "sensor only",
    ),
    { ...sensorExpect, role: Role.Gateway, hubIdentity: fromHex("0102030405060708") },
  ],
  [
    "the wrong role and over the slot: the role is checked first",
    must(
      signImageHeader({ ...officialFields, roles: roleBit(Role.Sensor) }, signingPrivateKey),
      "sensor only",
    ),
    { ...sensorExpect, role: Role.Gateway, capacity: 1 },
  ],
  [
    "over the slot and a bad signature: the size is checked first",
    withBytes(official, { 100: (official[100] ?? 0) ^ 1 }),
    { ...sensorExpect, capacity: 1 },
  ],
];

function imageHeaderFile(): JsonObject {
  const checks = checkCases.map(([name, bytes, expect]) => {
    return {
      name,
      header: toHex(bytes),
      expect: {
        hubIdentity: toHex(expect.hubIdentity),
        signingKey: toHex(expect.signingKey),
        role: expect.role,
        capacity: expect.capacity,
      },
      reason: checkImageHeader(bytes, expect),
    };
  });
  const rfcSample = p256Sample();
  return {
    label: IMAGE_HEADER.label,
    signing: {
      curve: "P-256",
      hash: "SHA-256",
      deterministic: "RFC 6979",
      prehash: true,
      lowS: false,
    },
    signingPrivateKey: toHex(signingPrivateKey),
    signingKey: toHex(signingKey),
    hubIdentity: toHex(hubId),
    rfc6979Sample: rfcSample,
    image: toHex(image),
    valid: headerCases.map(([name, fields]) => {
      const header = must(signImageHeader(fields, signingPrivateKey), name);
      const body = header.subarray(0, IMAGE_HEADER.signedBytes);
      const signed = imageHeaderSignedBytes(body);
      return {
        name,
        fields: toJson(fields),
        signedBytes: toHex(signed),
        signedSha256: toHex(new Uint8Array(createHash("sha256").update(signed).digest())),
        signature: toHex(header.subarray(IMAGE_HEADER.signedBytes)),
        header: toHex(header),
        imageId: toHex(imageIdOf(header)),
      };
    }),
    checks,
  };
}

/** RFC 6979 A.2.5, P-256 with SHA-256, message "sample": the signing is RFC 6979's exactly. */
function p256Sample(): JsonObject {
  // signImageHeader signs its own bytes; this case pins the primitive under it, with the same
  // options: a high s, which `lowS: true` would have replaced by n − s.
  const expected = {
    r: "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716",
    s: "f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8",
  };
  const mine = toHex(
    p256.sign(ascii("sample"), signingPrivateKey, {
      prehash: true,
      lowS: false,
      format: "compact",
    }),
  );
  if (mine !== expected.r + expected.s) throw new Error("not RFC 6979's signature of 'sample'");
  return { message: toHex(ascii("sample")), ...expected };
}

// ----- The Bluetooth update session -----

const sessionCases = [
  ["the sensor's key", sensor.key, fromHex("5a5b5c5d5e5f6061"), sensor.address],
  ["the siren's key, another nonce", siren.key, fromHex("0000000000000001"), siren.address],
  ["the largest address", sensor.key, fromHex("5a5b5c5d5e5f6061"), 0xfffffffe],
] as const;

function bluetoothFile(): JsonObject {
  const keys = sessionCases.map(([name, deviceKey, nonce, address]) => ({
    name,
    deviceKey: toHex(deviceKey),
    nonce: toHex(nonce),
    address,
    info: toHex(
      concatBytes(
        ascii(BLUETOOTH_UPDATE.sessionKeyLabel),
        Uint8Array.of(0),
        Uint8Array.of(
          address & 0xff,
          (address >>> 8) & 0xff,
          (address >>> 16) & 0xff,
          address >>> 24,
        ),
      ),
    ),
    sessionKey: toHex(must(bluetoothSessionKey(deviceKey, nonce, address), name)),
  }));
  const firstKey = fromHex(keys[0]?.sessionKey ?? "");
  const tagCases = [
    ["a first Hello", sensor.address, fromHex("c0c1c2c3c4c5c6c7"), imageId],
    ["a reconnection, a new device random", sensor.address, fromHex("d0d1d2d3d4d5d6d7"), imageId],
    ["another image", sensor.address, fromHex("c0c1c2c3c4c5c6c7"), fromHex("a1b2c3d4e5f60718")],
  ] as const;
  return {
    serviceUuid: BLUETOOTH_UPDATE.serviceUuid,
    rxUuid: BLUETOOTH_UPDATE.rxUuid,
    txUuid: BLUETOOTH_UPDATE.txUuid,
    sessionKeys: keys,
    openTags: tagCases.map(([name, address, deviceRandom, id]) => ({
      name,
      sessionKey: toHex(firstKey),
      address,
      deviceRandom: toHex(deviceRandom),
      imageId: toHex(id),
      tag: toHex(must(bluetoothOpenTag(firstKey, address, deviceRandom, id), name)),
    })),
    names: [sensor.address, 1, 0xfffffffe].map((address) => ({
      address,
      name: bluetoothUpdateName(address),
    })),
  };
}

/** The update vector files, by name. */
export function updateVectorFiles(): Map<string, JsonObject> {
  return new Map<string, JsonObject>([
    ["started-update.json", startedUpdateFile()],
    ["transfer-frames.json", transferFile()],
    ["image-header.json", imageHeaderFile()],
    ["ble-update-session.json", bluetoothFile()],
  ]);
}

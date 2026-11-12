/** USB vectors: COBS framing, setup messages and pairing data. */
import {
  cobsDecode,
  cobsEncode,
  concatBytes,
  dataRateMask,
  decodePairingData,
  decodeSetupMessage,
  encodePairingData,
  encodeSetupMessage,
  encodeUsbFrame,
  fromHex,
  hubIdentity,
  type PairingData,
  ProvisionResultCode,
  Role,
  type SetupMessage,
  SetupType,
  SiteChannel,
  toHex,
  UsbFrameDecoder,
  wifiBytes,
} from "../../src/index.ts";
import { patternBytes, sensor } from "./devices.ts";
import { signingPrivateKey, signingPublicKey } from "./signingKey.ts";
import { errorJson, fieldsJson, type JsonObject, toJson } from "./json.ts";

const nonZeroRun = (length: number, first = 1): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => ((first - 1 + i) % 255) + 1);

const cobsData: readonly (readonly [string, Uint8Array])[] = [
  ["empty", new Uint8Array(0)],
  ["one zero", fromHex("00")],
  ["two zeros", fromHex("0000")],
  ["zero in the middle", fromHex("11220033")],
  ["no zeros", fromHex("11223344")],
  ["trailing zeros", fromHex("11000000")],
  ["253 non-zero bytes", nonZeroRun(253)],
  ["254 non-zero bytes, one full block and nothing after it", nonZeroRun(254)],
  ["a zero then 254 non-zero bytes", concatBytes(fromHex("00"), nonZeroRun(254))],
  ["255 non-zero bytes", nonZeroRun(255)],
  ["254 non-zero bytes then a zero", concatBytes(nonZeroRun(254, 2), fromHex("00"))],
  ["254 non-zero bytes, a zero, one more byte", concatBytes(nonZeroRun(253, 3), fromHex("0001"))],
  ["508 non-zero bytes, two full blocks", nonZeroRun(508)],
  ["1,024 bytes, the largest link packet", patternBytes(1024, 0)],
];

const invalidCobs: readonly (readonly [string, Uint8Array])[] = [
  ["empty frame", new Uint8Array(0)],
  ["zero code byte", fromHex("00")],
  ["zero inside a block", fromHex("031100")],
  ["block runs past the end", fromHex("051122")],
];

const goodFrame = encodeUsbFrame(fromHex("11220033"));
const streams: readonly (readonly [string, readonly Uint8Array[]])[] = [
  ["one frame split into single bytes", Array.from(goodFrame, (byte) => Uint8Array.of(byte))],
  [
    "two frames in one chunk, with leading and repeated zeros",
    [concatBytes(fromHex("0000"), goodFrame, fromHex("00"), goodFrame)],
  ],
  [
    "a corrupt frame, then a good one",
    [
      fromHex("0511"),
      concatBytes(fromHex("2200"), goodFrame.subarray(0, 2)),
      goodFrame.subarray(2),
    ],
  ],
  [
    "a frame longer than any link packet, then a good one",
    [new Uint8Array(1100).fill(0x01), concatBytes(fromHex("00"), goodFrame)],
  ],
  ["an unfinished frame yields nothing yet", [goodFrame.subarray(0, goodFrame.length - 1)]],
  [
    "a frame of zero bytes (01 00) between two others is passed on, not skipped",
    [concatBytes(goodFrame, encodeUsbFrame(new Uint8Array(0)), goodFrame)],
  ],
  ["only zeros: empty frames produce nothing", [fromHex("000000"), fromHex("00")]],
];

function cobsFile(): JsonObject {
  return {
    valid: cobsData.map(([name, data]) => {
      const encoded = cobsEncode(data);
      return {
        name,
        data: toHex(data),
        encoded: toHex(encoded),
        frame: toHex(encodeUsbFrame(data)),
      };
    }),
    invalid: invalidCobs.map(([name, encoded]) => {
      const decoded = cobsDecode(encoded);
      if (decoded.ok) throw new Error(`"${name}" decoded`);
      return { name, encoded: toHex(encoded), ...errorJson(decoded.error) };
    }),
    streams: streams.map(([name, chunks]) => {
      const decoder = new UsbFrameDecoder();
      const frames = chunks.flatMap((chunk) => decoder.push(chunk));
      return {
        name,
        chunks: chunks.map(toHex),
        frames: frames.map((frame) =>
          frame.ok ? { data: toHex(frame.value) } : errorJson(frame.error),
        ),
      };
    }),
  };
}

const signingKey = signingPublicKey(signingPrivateKey);

const pairing: PairingData = {
  address: sensor.address,
  key: sensor.key,
  hubIdentity: hubIdentity(signingKey),
  firmwareSigningKey: signingKey,
  siteChannel: SiteChannel.Mhz868_3,
  allowedDataRateMask: dataRateMask([2, 5]),
  wifiName: wifiBytes("home"),
  wifiPassword: wifiBytes("correct horse battery"),
};

/** A case's name, its value, and for decode-only cases the bytes sent after its fields. */
type DecodeCase<T> = readonly [name: string, value: T, extraBytes?: Uint8Array];

/** The bytes of a valid case, checked to decode back to exactly its value. */
function validBytes<T>(
  [name, value, extraBytes]: DecodeCase<T>,
  encode: (value: T) => Uint8Array,
  decode: (bytes: Uint8Array) => { readonly ok: boolean; readonly value?: unknown },
): Uint8Array {
  const bytes = concatBytes(encode(value), extraBytes ?? new Uint8Array(0));
  const decoded = decode(bytes);
  if (!decoded.ok || JSON.stringify(toJson(decoded.value)) !== JSON.stringify(toJson(value))) {
    throw new Error(`"${name}" does not decode to its fields`);
  }
  return bytes;
}

const pairingCases: readonly DecodeCase<PairingData>[] = [
  ["sensor pairing", pairing],
  [
    "no Wi-Fi details",
    { ...pairing, wifiName: new Uint8Array(0), wifiPassword: new Uint8Array(0) },
  ],
  [
    "longest Wi-Fi name and password, the name typed with multi-byte characters",
    {
      ...pairing,
      wifiName: wifiBytes("Café-" + "n".repeat(26)),
      wifiPassword: wifiBytes("p".repeat(64)),
    },
  ],
  [
    "Wi-Fi name bytes that are not UTF-8, carried as they are",
    { ...pairing, wifiName: fromHex("ff00fe"), wifiPassword: fromHex("c328") },
  ],
  [
    "unlisted site channel 3 and data rate bits 6 and 7, which pass through",
    { ...pairing, siteChannel: 3, allowedDataRateMask: 0xc0 },
  ],
  [
    "hub identity that does not match the signing key, which decoding does not check",
    { ...pairing, hubIdentity: fromHex("0000000000000000") },
  ],
  [
    "sensor pairing with three bytes after the Wi-Fi password, which decoding ignores",
    pairing,
    fromHex("01ff00"),
  ],
];

/** Signing keys and the hub identity each gives (section 9). */
const hubIdentityKeys: readonly (readonly [string, Uint8Array])[] = [
  ["the pairing cases' signing key, from signingPrivateKey", signingKey],
  ["all zeros", new Uint8Array(64)],
  ["all ones", new Uint8Array(64).fill(0xff)],
];

const pairingBytes = encodePairingData(pairing);
/** Offset of the Wi-Fi name's length byte: version, address, key, identity, signing key, channel, rates. */
const WIFI_NAME_OFFSET = 1 + 4 + 16 + 8 + 64 + 1 + 1;
const withByteAt = (bytes: Uint8Array, index: number, value: number): Uint8Array => {
  const copy = bytes.slice();
  copy[index] = value;
  return copy;
};

const invalidPairing: readonly (readonly [string, Uint8Array])[] = [
  ["format version 2", withByteAt(pairingBytes, 0, 2)],
  ["address 0", concatBytes(fromHex("0100000000"), pairingBytes.subarray(5))],
  ["cut off before the Wi-Fi name", pairingBytes.subarray(0, WIFI_NAME_OFFSET)],
  ["cut off inside the Wi-Fi name", pairingBytes.subarray(0, WIFI_NAME_OFFSET + 3)],
  ["Wi-Fi name length 33", withByteAt(pairingBytes, WIFI_NAME_OFFSET, 33)],
  [
    "Wi-Fi password length 65",
    concatBytes(
      pairingBytes.subarray(0, WIFI_NAME_OFFSET),
      fromHex("00"),
      Uint8Array.of(65),
      new Uint8Array(65).fill(0x70),
    ),
  ],
];

function pairingFile(): JsonObject {
  return {
    signingPrivateKey: toHex(signingPrivateKey),
    valid: pairingCases.map((c) => ({
      name: c[0],
      canonical: c[2] === undefined,
      fields: toJson(c[1]),
      bytes: toHex(validBytes(c, encodePairingData, decodePairingData)),
    })),
    hubIdentity: hubIdentityKeys.map(([name, key]) => ({
      name,
      firmwareSigningKey: toHex(key),
      hubIdentity: toHex(hubIdentity(key)),
    })),
    invalid: invalidPairing.map(([name, bytes]) => {
      const decoded = decodePairingData(bytes);
      if (decoded.ok) throw new Error(`"${name}" decoded`);
      return { name, bytes: toHex(bytes), ...errorJson(decoded.error) };
    }),
  };
}

const unpairedGatewayIdentity: SetupMessage = {
  type: SetupType.Identity,
  role: Role.Gateway,
  chipId: fromHex("a1b2c3d4e5f6"),
  firmwareVersion: { major: 0, minor: 1, patch: 0 },
  paired: false,
  hubIdentity: new Uint8Array(8),
  developmentBuild: true,
};

const setupCases: readonly DecodeCase<SetupMessage>[] = [
  ["identify", { type: SetupType.Identify }],
  ["identity of an unpaired development gateway", unpairedGatewayIdentity],
  [
    "identity of a paired release sensor",
    {
      type: SetupType.Identity,
      role: Role.Sensor,
      chipId: fromHex("010203040506"),
      firmwareVersion: { major: 1, minor: 2, patch: 3 },
      paired: true,
      hubIdentity: pairing.hubIdentity,
      developmentBuild: false,
    },
  ],
  ["provision", { type: SetupType.Provision, pairing }],
  ["provision accepted", { type: SetupType.ProvisionResult, result: ProvisionResultCode.Accepted }],
  ["provision refused", { type: SetupType.ProvisionResult, result: ProvisionResultCode.Refused }],
  [
    "provision not valid",
    { type: SetupType.ProvisionResult, result: ProvisionResultCode.NotValid },
  ],
  [
    "provision result with unlisted value 3, which passes through",
    { type: SetupType.ProvisionResult, result: 3 },
  ],
  [
    "identity with unlisted role 9, which passes through",
    {
      type: SetupType.Identity,
      role: 9,
      chipId: fromHex("0a0b0c0d0e0f"),
      firmwareVersion: { major: 4, minor: 0, patch: 2 },
      paired: false,
      hubIdentity: new Uint8Array(8),
      developmentBuild: false,
    },
  ],
  ["erase", { type: SetupType.Erase }],
  [
    "identity with two bytes after its fields, which decoding ignores",
    unpairedGatewayIdentity,
    fromHex("0203"),
  ],
  [
    "provision result with one byte after its field, which decoding ignores",
    { type: SetupType.ProvisionResult, result: ProvisionResultCode.Accepted },
    fromHex("ff"),
  ],
];

const invalidSetup: readonly (readonly [string, Uint8Array])[] = [
  ["empty", new Uint8Array(0)],
  ["marker only", fromHex("f1")],
  ["no marker", fromHex("1001")],
  ["unknown setup type", fromHex("f109")],
  ["identity cut short", fromHex("f10203a1b2c3d4e5f6000100")],
  ["identity with paired = 2", fromHex("f10203a1b2c3d4e5f600010002000000000000000000")],
  ["provision result missing its byte", fromHex("f104")],
];

function setupFile(): JsonObject {
  return {
    valid: setupCases.map((c) => {
      const [name, message, extraBytes] = c;
      const bytes = validBytes(c, encodeSetupMessage, decodeSetupMessage);
      return {
        name,
        canonical: extraBytes === undefined,
        setupType: message.type,
        fields: fieldsJson(message),
        bytes: toHex(bytes),
        frame: toHex(encodeUsbFrame(bytes)),
      };
    }),
    invalid: invalidSetup.map(([name, bytes]) => {
      const decoded = decodeSetupMessage(bytes);
      if (decoded.ok) throw new Error(`"${name}" decoded`);
      return { name, bytes: toHex(bytes), ...errorJson(decoded.error) };
    }),
  };
}

export function usbVectorFiles(): Map<string, JsonObject> {
  return new Map([
    ["cobs.json", cobsFile()],
    ["setup-messages.json", setupFile()],
    ["pairing-data.json", pairingFile()],
  ]);
}

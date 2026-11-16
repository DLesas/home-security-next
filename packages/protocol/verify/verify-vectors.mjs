// Independent check of packages/protocol/vectors against docs/protocol.md.
//
// Written from the specification (docs/protocol.md), the "Time on air" section of
// docs/spikes/S2-radio-rules.md and vectors/README.md only, without reading the
// library in packages/protocol/src. Encryption is Node's own AES-128-CCM.
//
// Run: node packages/protocol/verify/verify-vectors.mjs [vectors directory]
// Exits 1 and lists every mismatch if anything disagrees.

import { Buffer } from "node:buffer";
import console from "node:console";
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPublicKey,
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { verifyAppVectors } from "./verify-app-vectors.mjs";

// An optional argument points at another copy of the vectors (used to test this script).
const VECTORS = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const hex = (s) => Buffer.from(s, "hex");
const toHex = (b) => Buffer.from(b).toString("hex");

const mismatches = [];
const notes = [];
const counts = new Map();
const count = (kind, n = 1) => counts.set(kind, (counts.get(kind) ?? 0) + n);
const mismatch = (file, name, message) => mismatches.push(`${file} › ${name}: ${message}`);
const note = (message) => notes.push(message);

// Loading and walking the vector files. Anything the script does not understand (a file,
// section, case field or value of the wrong shape) becomes a mismatch, never an exception.
const loadedFiles = new Set();
const KNOWN_TOP = {
  message: ["schemaVersion", "protocolVersion", "messageType", "name", "direction", "cases"],
  "rejected-packets.json": ["schemaVersion", "protocolVersion", "packets", "replayed"],
  "counters.json": [
    "schemaVersion",
    "protocolVersion",
    "take",
    "powerLoss",
    "restore",
    "replayWindow",
    "strictlyHigher",
  ],
  "cobs.json": ["schemaVersion", "protocolVersion", "valid", "invalid", "streams"],
  "setup-messages.json": ["schemaVersion", "protocolVersion", "valid", "invalid"],
  "pairing-data.json": [
    "schemaVersion",
    "protocolVersion",
    "signingPrivateKey",
    "valid",
    "hubIdentity",
    "invalid",
  ],
  "units.json": ["schemaVersion", "protocolVersion"], // plus the arrays in UNITS
  "time-on-air.json": ["schemaVersion", "protocolVersion", "cases", "eventListen"],
};
function load(name, knownTop) {
  loadedFiles.add(name);
  let file;
  try {
    file = JSON.parse(readFileSync(join(VECTORS, name), "utf8"));
  } catch (e) {
    mismatch(name, "(file)", `cannot be read: ${e.message}`);
    return {};
  }
  if (file === null || typeof file !== "object") {
    mismatch(name, "(file)", "is not a JSON object");
    return {};
  }
  if (file.schemaVersion !== 1) mismatch(name, "(file)", `schemaVersion ${file.schemaVersion}`);
  if (file.protocolVersion !== 1)
    mismatch(name, "(file)", `protocolVersion ${file.protocolVersion}`);
  for (const k of Object.keys(file))
    if (!knownTop.includes(k)) mismatch(name, "(file)", `section "${k}" the script does not know`);
  return file;
}
function list(file, obj, key) {
  const v = obj[key];
  if (v === undefined) {
    mismatch(file, "(file)", `no "${key}" section`);
    return [];
  }
  if (!Array.isArray(v)) {
    mismatch(file, "(file)", `"${key}" is not an array`);
    return [];
  }
  return v;
}
function guard(file, c, fn) {
  const name =
    c !== null && typeof c === "object" && typeof c.name === "string"
      ? c.name
      : JSON.stringify(c)?.slice(0, 60);
  try {
    fn();
  } catch (e) {
    const why =
      e instanceof ProtocolError
        ? e.code
        : `${e?.constructor?.name ?? "error"}: ${e?.message ?? e}`;
    mismatch(file, name, `the script cannot process this case (${why})`);
  }
}
function knownKeys(file, c, keys) {
  for (const k of Object.keys(c))
    if (!keys.includes(k)) mismatch(file, c.name, `case field "${k}" the script does not know`);
}

class ProtocolError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}
const reject = (code, extra) => {
  throw new ProtocolError(code, extra);
};
const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ProtocolError) return e;
    throw e;
  }
};

// Section 3: limits and the clear part of the header.
const HEADER_LENGTH = 9;
const TAG_LENGTH = 8;
const SMALLEST_PACKET = 18;
const U32_MAX = 0xffffffff;

// ---------------------------------------------------------------------------
// 1. Packet envelope (section 3, encoding rules, bindings of section 4)
// ---------------------------------------------------------------------------

function nonceFor(address, direction, counter) {
  // address (4, LE) · direction (1 byte) · counter (4, LE) · four zero bytes
  const n = Buffer.alloc(13);
  n.writeUInt32LE(address, 0);
  n[4] = direction;
  n.writeUInt32LE(counter, 5);
  return n;
}

function clearPart(header, address, counter) {
  const b = Buffer.alloc(HEADER_LENGTH);
  b[0] = header;
  b.writeUInt32LE(address, 1);
  b.writeUInt32LE(counter, 5);
  return b;
}

function ccmSeal(key, nonce, aad, plaintext) {
  const c = createCipheriv("aes-128-ccm", key, nonce, { authTagLength: TAG_LENGTH });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

function ccmOpen(key, nonce, aad, ciphertext, tag) {
  try {
    const d = createDecipheriv("aes-128-ccm", key, nonce, { authTagLength: TAG_LENGTH });
    d.setAuthTag(tag);
    d.setAAD(aad, { plaintextLength: ciphertext.length });
    const pt = d.update(ciphertext);
    d.final();
    return pt;
  } catch {
    return null;
  }
}

// Header byte: version 1 in bits 7–4, direction in bit 3, low bits zero (0x10 / 0x18).
const headerByte = (direction) => (1 << 4) | (direction << 3);

function sealPacket({ key, direction, address, counter, binding, plaintext, header }) {
  const clear = clearPart(header ?? headerByte(direction), address, counter);
  const aad = Buffer.concat([clear, binding]);
  return Buffer.concat([
    clear,
    ccmSeal(key, nonceFor(address, direction, counter), aad, plaintext),
  ]);
}

// Opens a packet. Order of the clear checks is my choice (the spec does not give
// one): size, version, direction, address, counter, then the tag.
function openPacket(packet, { key, expectedDirection, binding, maxLength }) {
  if (packet.length < SMALLEST_PACKET) reject("truncated");
  if (packet.length > maxLength) reject("tooLong");
  const header = packet[0];
  if (header >> 4 !== 1) reject("badVersion");
  const direction = (header >> 3) & 1; // low three bits ignored
  if (direction !== expectedDirection) reject("wrongDirection");
  const address = packet.readUInt32LE(1);
  if (address === 0 || address === U32_MAX) reject("badAddress");
  const counter = packet.readUInt32LE(5);
  if (counter === 0) reject("badCounter");
  const plaintext = rawOpen(packet, key, binding);
  if (plaintext === null) reject("badTag");
  return { header, direction, address, counter, plaintext };
}

// Tag check alone, with nonce and AD taken from the packet's clear bytes.
function rawOpen(packet, key, binding) {
  if (packet.length < HEADER_LENGTH + TAG_LENGTH + 1) return null;
  const direction = (packet[0] >> 3) & 1;
  const address = packet.readUInt32LE(1);
  const counter = packet.readUInt32LE(5);
  const aad = Buffer.concat([packet.subarray(0, HEADER_LENGTH), binding]);
  return ccmOpen(
    key,
    nonceFor(address, direction, counter),
    aad,
    packet.subarray(HEADER_LENGTH, packet.length - TAG_LENGTH),
    packet.subarray(packet.length - TAG_LENGTH),
  );
}

// ---------------------------------------------------------------------------
// 2. Message bodies (section 6), as data driving one decoder and one encoder
// ---------------------------------------------------------------------------
//
// Each field: [name, offset, size, kind, options]. kind is "u" (unsigned LE),
// "i" (signed LE), "bytes", "version" (major, minor, patch), "rest" (to the end
// of the body), "text" (length byte then UTF-8, size = length byte size),
// "entries" (records back to back to the end of the body), or an array of flag
// names, bit 0 first. options.values lists the values section 6 allows;
// options.max is a numeric upper bound; options.silent marks a reading the spec
// does not state.

const DATA_RATE = { values: [0, 1, 2, 3, 4, 5] };
// Section 6: the packet inside a forwarded packet or transmit request is 18 to 255 bytes.
const RADIO_PACKET = { minBytes: 18, maxBytes: 255 };
const SENSOR_STATUS = [
  ["settingsVersion", 0, 1, "u"],
  [
    "flags",
    1,
    1,
    [
      "doorOpen",
      "coverOpen",
      "usbPower",
      "charging",
      "replyWanted",
      "localAlarmSounded",
      "buzzing",
      "listeningAtSendRate", // bit 7, section 6
    ],
  ],
  ["batteryCode", 2, 1, "u"],
  ["temperatureCelsius", 3, 1, "i"],
  ["doorChangeCount", 4, 1, "u"],
  ["eventAgeSeconds", 5, 2, "u"],
];
const LOG_ENTRY = [
  ["ageTenths", 0, 4, "u"], // tenths of a second before the packet was sealed
  ["level", 4, 1, "u"],
  ["code", 5, 2, "u"],
  ["text", 7, 1, "text", { maxBytes: 64 }],
];

// type: { name, from hub?, paths, fields }
const MESSAGES = {
  0x01: { file: "heartbeat.json", fromHub: false, paths: "lora", fields: SENSOR_STATUS },
  0x02: { file: "door-changed.json", fromHub: false, paths: "lora", fields: SENSOR_STATUS },
  0x03: { file: "cover-changed.json", fromHub: false, paths: "lora", fields: SENSOR_STATUS },
  0x04: {
    file: "button.json",
    fromHub: false,
    paths: "lora",
    fields: [...SENSOR_STATUS, ["buttonAction", 7, 1, "u", { values: [1, 2, 3, 4] }]],
  },
  0x05: {
    file: "started.json",
    fromHub: false,
    paths: "any",
    fields: [
      ["role", 0, 1, "u", { values: [1, 2, 3] }],
      ["firmwareVersion", 1, 3, "version"],
      ["resetCause", 4, 1, "u"],
      ["lastFatalError", 5, 2, "u"],
      ["settingsVersion", 7, 1, "u"],
    ],
  },
  0x10: {
    file: "siren-report.json",
    fromHub: false,
    paths: "any",
    fields: [
      ["settingsVersion", 0, 1, "u"],
      ["state", 1, 1, "u", { values: [0, 1, 2] }],
      ["soundingSecondsLeft", 2, 2, "u"],
      ["lastCommandCounterLow", 4, 2, "u"],
      ["flags", 6, 1, ["onMains", "cellFitted", "charging", "coverOpen", "wifiConnected"]],
      ["cellBatteryCode", 7, 1, "u"],
      ["temperatureCelsius", 8, 1, "i"],
      ["reason", 9, 1, "u", { values: [0, 1, 2, 3] }],
    ],
  },
  0x20: {
    file: "hello.json",
    fromHub: false,
    paths: "link",
    fields: [
      ["gatewayRandom", 0, 8, "bytes"],
      ["firmwareVersion", 8, 3, "version"], // order not stated for hello; as in Started
      ["settingsVersion", 11, 1, "u"],
    ],
  },
  0x21: {
    file: "forwarded-packet.json",
    fromHub: false,
    paths: "link",
    fields: [
      ["receivedAtMicros", 0, 4, "u"],
      ["rssiDbm", 4, 2, "i"],
      ["snrQuarterDb", 6, 1, "i"],
      ["dataRate", 7, 1, "u", DATA_RATE],
      ["siteChannel", 8, 1, "u", { values: [0, 1, 2] }], // encoding as in gateway settings
      ["packet", 9, 0, "rest", RADIO_PACKET],
    ],
  },
  0x22: {
    file: "gateway-status.json",
    fromHub: false,
    paths: "link",
    fields: [
      ["settingsVersion", 0, 1, "u"],
      ["uptimeSeconds", 1, 4, "u"],
      ["airtimeHundredthsPercent", 5, 2, "u", { max: 10000 }],
      ["noiseMedianDbm", 7, 1, "i"],
      ["noiseHighestDbm", 8, 1, "i"],
      ["normalNoiseDbm", 9, 1, "i"],
      ["packetsReceived", 10, 2, "u"],
      ["packetsCrcFailed", 12, 2, "u"],
      ["wifiRssiDbm", 14, 1, "i"],
      ["flags", 15, 1, ["usbConnected", "cellFitted", "onMains"]],
    ],
  },
  0x23: {
    file: "transmit-result.json",
    fromHub: false,
    paths: "link",
    fields: [
      ["requestCounter", 0, 4, "u"],
      ["result", 4, 1, "u", { values: [0, 1, 2, 3, 4] }],
      ["sentAtMicros", 5, 4, "u"],
    ],
  },
  0x24: {
    file: "interference.json",
    fromHub: false,
    paths: "link",
    fields: [
      ["event", 0, 1, "u", { values: [0, 1] }],
      ["noiseDbm", 1, 1, "i"],
      ["durationSeconds", 2, 2, "u"],
    ],
  },
  0x30: {
    file: "log-entries.json",
    fromHub: false,
    paths: "any", // section 5: any path; over LoRa one entry per packet (section 6)
    fields: [["entries", 0, 0, "entries", { record: LOG_ENTRY }]],
  },
  0x81: {
    file: "reply.json",
    fromHub: true,
    paths: "lora",
    fields: [
      ["settingsVersion", 0, 1, "u"],
      ["flags", 1, 1, ["armed", "countdownStarted", "updateAvailable"]],
      ["countdownSeconds", 2, 1, "u"],
      ["countdownRemainingSeconds", 3, 1, "u"],
      ["heartbeatIntervalUnits", 4, 1, "u"],
      ["linkCheckEvery", 5, 1, "u"],
      ["sendDataRate", 6, 1, "u", DATA_RATE],
      ["replyDataRate", 7, 1, "u", DATA_RATE],
      ["nextHeartbeatTenths", 8, 2, "u"],
      ["clockCorrectionTenPpm", 10, 2, "i"], // units of 10 ppm
      // Section 6 / D115: the site's next channel and sending rate, 0xFF for "stays as it is".
      ["nextSiteChannel", 12, 1, "u", { values: [0, 1, 2, 0xff] }],
      ["nextSendDataRate", 13, 1, "u", { values: [...DATA_RATE.values, 0xff] }],
    ],
  },
  0x82: { file: "disarmed-notice.json", fromHub: true, paths: "lora", fields: [] },
  0x90: {
    file: "siren-command.json",
    fromHub: true,
    paths: "any",
    fields: [
      ["action", 0, 1, "u", { values: [0, 1, 2, 3] }],
      ["soundSeconds", 1, 2, "u"],
    ],
  },
  0x91: {
    file: "siren-settings.json",
    fromHub: true,
    paths: "any",
    fields: [
      ["settingsVersion", 0, 1, "u"],
      ["wifiReportIntervalSeconds", 1, 1, "u"],
      ["loraCheckIntervalUnits", 2, 1, "u"],
      ["maxSoundSeconds", 3, 2, "u"],
      ["sendDataRate", 5, 1, "u", DATA_RATE],
      ["commandDataRate", 6, 1, "u", DATA_RATE],
      ["siteChannel", 7, 1, "u", { values: [0, 1, 2] }], // numbered as in gateway settings
    ],
  },
  0xa0: {
    file: "welcome.json",
    fromHub: true,
    paths: "link",
    fields: [["hubRandom", 0, 8, "bytes"]],
  },
  0xa1: {
    file: "transmit-request.json",
    fromHub: true,
    paths: "link",
    fields: [
      ["when", 0, 1, "u", { values: [0, 1] }],
      ["gatewayTimeMicros", 1, 4, "u"],
      ["dataRate", 5, 1, "u", DATA_RATE],
      ["powerDbm", 6, 1, "i"],
      ["priority", 7, 1, "u", { values: [0, 1] }],
      ["packet", 8, 0, "rest", RADIO_PACKET],
    ],
  },
  0xa2: {
    file: "gateway-settings.json",
    fromHub: true,
    paths: "link",
    fields: [
      ["settingsVersion", 0, 1, "u"],
      ["siteChannel", 1, 1, "u", { values: [0, 1, 2] }],
      ["listenDataRateMask", 2, 1, "u", { maskOf: 6 }],
      ["statusIntervalSeconds", 3, 1, "u"],
      ["interferenceThresholdDb", 4, 1, "u"],
      ["interferenceSeconds", 5, 1, "u"],
      ["defaultTxPowerDbm", 6, 1, "i"],
      ["sirenTxPowerDbm", 7, 1, "i"],
    ],
  },
};

// Self-check of the tables: fixed fields are contiguous from offset 0.
for (const [type, m] of Object.entries(MESSAGES)) {
  let at = 0;
  for (const [name, offset, size] of m.fields) {
    if (offset !== at) throw new Error(`table error: type ${type} field ${name} at ${offset}`);
    at += size;
  }
}

// Section 3: log text that is not valid UTF-8 is shown with replacement characters.
// A leading BOM is kept as U+FEFF (the spec does not say to strip it).
const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const decodeText = (bytes) => utf8.decode(bytes);

function readInt(buf, offset, size, signed) {
  if (size === 1) return signed ? buf.readInt8(offset) : buf.readUInt8(offset);
  if (size === 2) return signed ? buf.readInt16LE(offset) : buf.readUInt16LE(offset);
  if (size === 4) return signed ? buf.readInt32LE(offset) : buf.readUInt32LE(offset);
  throw new Error(`no integer of size ${size}`);
}
function writeInt(value, size, signed) {
  const bits = 8 * size;
  const [lo, hi] = signed ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1] : [0, 2 ** bits - 1];
  if (!Number.isInteger(value) || value < lo || value > hi)
    reject("valueOutOfRange", { message: `${value} does not fit ${signed ? "i" : "u"}${bits}` });
  const b = Buffer.alloc(size);
  if (size === 1) signed ? b.writeInt8(value) : b.writeUInt8(value);
  else if (size === 2) signed ? b.writeInt16LE(value) : b.writeUInt16LE(value);
  else signed ? b.writeInt32LE(value) : b.writeUInt32LE(value);
  return b;
}

// Decodes `fields` from `body`, which may be longer than the fields (extra bytes ignored).
// Returns [object, bytesUsed].
function decodeFields(fields, body) {
  const out = {};
  let at = 0;
  for (const [name, offset, size, kind, options = {}] of fields) {
    if (kind === "rest") {
      if (body.length < offset) reject("truncated");
      const rest = body.subarray(offset);
      if (options.minBytes !== undefined && rest.length < options.minBytes) reject("truncated");
      if (options.maxBytes !== undefined && rest.length > options.maxBytes) reject("tooLong");
      out[name] = toHex(rest);
      at = body.length;
      continue;
    }
    if (kind === "entries") {
      const entries = [];
      let pos = offset;
      while (pos < body.length) {
        const [entry, used] = decodeFields(options.record, body.subarray(pos));
        entries.push(entry);
        pos += used;
      }
      if (entries.length === 0) reject("truncated"); // "one or more entries"
      out[name] = entries;
      at = body.length;
      continue;
    }
    if (kind === "text") {
      if (body.length < offset + size) reject("truncated");
      const len = readInt(body, offset, size, false);
      if (len > options.maxBytes) reject("badLength");
      if (body.length < offset + size + len) reject("truncated");
      const raw = body.subarray(offset + size, offset + size + len);
      out[name] = options.bytes ? toHex(raw) : decodeText(raw);
      at = offset + size + len;
      continue;
    }
    if (body.length < offset + size) reject("truncated");
    if (kind === "u" || kind === "i") out[name] = readInt(body, offset, size, kind === "i");
    else if (kind === "bytes") out[name] = toHex(body.subarray(offset, offset + size));
    else if (kind === "version")
      out[name] = { major: body[offset], minor: body[offset + 1], patch: body[offset + 2] };
    else if (Array.isArray(kind))
      out[name] = Object.fromEntries(
        kind.map((flag, bit) => [flag, ((body[offset] >> bit) & 1) === 1]),
      );
    else throw new Error(`unknown kind ${kind}`);
    at = offset + size;
  }
  return [out, at];
}

function encodeFields(fields, value) {
  const parts = [];
  for (const [name, , size, kind, options = {}] of fields) {
    const v = value[name];
    if (kind === "rest" || kind === "bytes") parts.push(hex(v));
    else if (kind === "entries") for (const e of v) parts.push(encodeFields(options.record, e));
    else if (kind === "text") {
      const t = options.bytes ? hex(v) : Buffer.from(v, "utf8");
      parts.push(writeInt(t.length, size, false), t);
    } else if (kind === "u" || kind === "i") parts.push(writeInt(v, size, kind === "i"));
    else if (kind === "version") parts.push(Buffer.from([v.major, v.minor, v.patch]));
    else if (Array.isArray(kind))
      parts.push(Buffer.from([kind.reduce((acc, flag, bit) => acc | (v[flag] ? 1 << bit : 0), 0)]));
  }
  return Buffer.concat(parts);
}

// Section 5: types 0x80 and above come from the hub, lower types go to the hub. Checked
// before "unknown type" (my order; the spec gives none).
function decodeMessage(plaintext, direction) {
  const type = plaintext[0];
  if (direction !== undefined && (type >= 0x80 ? 1 : 0) !== direction) reject("wrongDirection");
  const m = MESSAGES[type];
  if (!m) reject("unknownType", { messageType: type });
  return { type, fields: decodeFields(m.fields, plaintext.subarray(1))[0] };
}

// Section 6 value ranges, applied to decoded fields.
function rangeProblems(fields, value, path = "") {
  const problems = [];
  for (const [name, , , kind, options = {}] of fields) {
    const v = value[name];
    if (kind === "entries") {
      v.forEach((e, i) =>
        problems.push(...rangeProblems(options.record, e, `${path}${name}[${i}].`)),
      );
    }
    if (options.values && !options.values.includes(v))
      problems.push(
        `${path}${name} = ${v}, a value version 1 does not list (allowed by section 3, "Enumerated values")`,
      );
    if (options.maskOf !== undefined && v >> options.maskOf)
      problems.push(`${path}${name} = ${v}, with bits for data rates version 1 does not list`);
    if (options.max !== undefined && v > options.max)
      problems.push(`${path}${name} = ${v}, above ${options.max} (section 6)`);
  }
  return problems;
}

function diff(expected, actual, path = "") {
  if (
    typeof expected !== "object" ||
    expected === null ||
    typeof actual !== "object" ||
    actual === null
  )
    return Object.is(expected, actual)
      ? []
      : [`${path || "value"}: vector ${JSON.stringify(expected)}, mine ${JSON.stringify(actual)}`];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const out = [];
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in expected)) out.push(`${p}: missing from vector, mine ${JSON.stringify(actual[k])}`);
    else if (!(k in actual))
      out.push(`${p}: vector has ${JSON.stringify(expected[k])}, not in spec`);
    else out.push(...diff(expected[k], actual[k], p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message files
// ---------------------------------------------------------------------------

const allValid = []; // every valid case, for cross-file checks
const SENSOR_TYPES = new Set([0x01, 0x02, 0x03, 0x04]);
const GATEWAY_TYPES = new Set([0x20, 0x21, 0x22, 0x23, 0x24, 0xa0, 0xa1, 0xa2]);

for (const [typeKey, m] of Object.entries(MESSAGES)) {
  const type = Number(typeKey);
  const F = m.file;
  const file = load(F, KNOWN_TOP.message);
  const fileDirection = m.fromHub ? 1 : 0;
  if (file.messageType !== type)
    mismatch(m.file, "(file)", `messageType ${file.messageType}, expected ${type}`);
  if (file.direction !== fileDirection)
    mismatch(m.file, "(file)", `direction ${file.direction}, section 5 gives ${fileDirection}`);
  if (file.cases.length === 0) note(`${m.file}: no cases`);

  for (const c of list(F, file, "cases"))
    guard(F, c, () => {
      knownKeys(F, c, [
        "name",
        "canonical",
        "key",
        "direction",
        "address",
        "counter",
        "binding",
        "maxLength",
        "messageType",
        "fields",
        "plaintext",
        "nonce",
        "associatedData",
        "packet",
      ]);
      count("envelope: valid packets opened");
      const key = hex(c.key);
      const binding = hex(c.binding);
      const packet = hex(c.packet);
      const plaintext = hex(c.plaintext);
      allValid.push({ file: m.file, c, type, packet });

      if (c.direction !== file.direction)
        mismatch(m.file, c.name, `case direction ${c.direction} ≠ file ${file.direction}`);
      if (c.messageType !== type)
        mismatch(m.file, c.name, `case messageType ${c.messageType} ≠ ${type}`);
      if (plaintext[0] !== type)
        mismatch(m.file, c.name, `plaintext starts with ${plaintext[0]}, not ${type}`);
      if (![0, 4, 8, 16].includes(binding.length))
        mismatch(m.file, c.name, `binding of ${binding.length} bytes`);

      const myNonce = nonceFor(c.address, c.direction, c.counter);
      if (toHex(myNonce) !== c.nonce)
        mismatch(m.file, c.name, `nonce ${c.nonce}, mine ${toHex(myNonce)}`);
      const myAad = Buffer.concat([packet.subarray(0, HEADER_LENGTH), binding]);
      if (toHex(myAad) !== c.associatedData)
        mismatch(m.file, c.name, `associatedData ${c.associatedData}, mine ${toHex(myAad)}`);

      // Seal: canonical cases from scratch; non-canonical ones with their own header byte.
      if (c.canonical) {
        count("envelope: canonical packets sealed");
        const sealed = sealPacket({
          key,
          direction: c.direction,
          address: c.address,
          counter: c.counter,
          binding,
          plaintext,
        });
        if (!sealed.equals(packet))
          mismatch(
            m.file,
            c.name,
            `sealed packet differs:\n    vector ${c.packet}\n    mine   ${toHex(sealed)}`,
          );
      } else {
        const sealed = sealPacket({
          key,
          direction: c.direction,
          address: c.address,
          counter: c.counter,
          binding,
          plaintext,
          header: packet[0],
        });
        if (!sealed.equals(packet))
          mismatch(m.file, c.name, `non-canonical packet does not reseal with its own header byte`);
      }

      // Open.
      const opened = errorOf(() => {
        const o = openPacket(packet, {
          key,
          expectedDirection: c.direction,
          binding,
          maxLength: c.maxLength,
        });
        if (o.address !== c.address) mismatch(m.file, c.name, `opened address ${o.address}`);
        if (o.counter !== c.counter) mismatch(m.file, c.name, `opened counter ${o.counter}`);
        if (!o.plaintext.equals(plaintext))
          mismatch(m.file, c.name, `opened plaintext ${toHex(o.plaintext)}`);
      });
      if (opened) mismatch(m.file, c.name, `my opener rejects it: ${opened.code}`);

      // Body: decode from section 6, compare every field, and re-encode.
      count(`bodies: ${m.file.replace(".json", "")}`);
      const decoded = errorOf(() => {
        const { fields } = decodeMessage(plaintext, c.direction);
        for (const d of diff(c.fields, fields)) mismatch(m.file, c.name, d);
        count(
          "bodies: unlisted enumerated values passed through",
          rangeProblems(m.fields, fields).length,
        );
        if (c.canonical) {
          const enc = Buffer.concat([Buffer.from([type]), encodeFields(m.fields, c.fields)]);
          if (!enc.equals(plaintext))
            mismatch(m.file, c.name, `encoded fields ${toHex(enc)} ≠ plaintext ${c.plaintext}`);
        } else {
          const enc = Buffer.concat([Buffer.from([type]), encodeFields(m.fields, c.fields)]);
          const isExtra =
            plaintext.length > enc.length && plaintext.subarray(0, enc.length).equals(enc);
          const isHeader = plaintext.equals(enc) && (packet[0] & 0x07) !== 0;
          const isText = !plaintext.equals(enc) && JSON.stringify(c.fields).includes("\ufffd");
          // Unused flag bits set: equal to the encoding once those bits are cleared.
          const cleared = Buffer.from(plaintext);
          for (const [, offset, , kind] of m.fields)
            if (Array.isArray(kind)) cleared[1 + offset] &= (1 << kind.length) - 1;
          const isFlags = !plaintext.equals(cleared) && cleared.equals(enc);
          if (!isExtra && !isHeader && !isText && !isFlags)
            mismatch(
              m.file,
              c.name,
              "non-canonical, but not extra bytes, header low bits, invalid UTF-8 or unused flag bits",
            );
        }
      });
      if (decoded) mismatch(m.file, c.name, `my decoder or encoder fails: ${decoded.code}`);

      // Section 5 paths against the size limit.
      if (m.paths === "lora" && c.maxLength !== 255)
        mismatch(m.file, c.name, `LoRa-only type opened with maxLength ${c.maxLength}`);
      if (m.paths === "link" && c.maxLength !== 1024)
        mismatch(m.file, c.name, `Wi-Fi/USB-only type opened with maxLength ${c.maxLength}`);
      // Section 3: the largest radio packets are the reply (32) and a LoRa log entry (up to 50).
      if (c.maxLength === 255) {
        const limit = type === 0x30 ? 50 : 32;
        if (packet.length > limit)
          mismatch(
            m.file,
            c.name,
            `radio packet of ${packet.length} bytes; section 3 gives at most ${limit}`,
          );
        if (type === 0x30 && c.fields.entries?.length !== 1)
          mismatch(m.file, c.name, "a log entries packet over LoRa carries one entry (section 6)");
      }
      if (c.canonical && packet[0] & 0x07)
        mismatch(m.file, c.name, "canonical packet has header low bits set");
    });
}

// Cross-file checks of bindings (section 4) and keys.
{
  const keyOf = new Map();
  for (const { file, c } of allValid) {
    const k = keyOf.get(c.address);
    if (k && k !== c.key) mismatch(file, c.name, `address ${c.address} used with two keys`);
    keyOf.set(c.address, c.key);
  }
  const hellos = allValid.filter((v) => v.type === 0x20);
  const welcomes = allValid.filter((v) => v.type === 0xa0);
  const gatewayAddresses = new Set(hellos.map((v) => v.c.address));
  // A connection's session value: the hello's random followed by the random of the welcome
  // bound to that hello.
  const sessions = new Set();
  for (const w of welcomes)
    if (hellos.some((h) => h.c.address === w.c.address && h.c.fields.gatewayRandom === w.c.binding))
      sessions.add(w.c.binding + w.c.fields.hubRandom);
  const sensorPackets = allValid.filter(
    (v) => SENSOR_TYPES.has(v.type) || (v.type === 0x05 && v.c.fields.role === 1),
  );

  for (const { file, c, type } of allValid) {
    if (type === 0x20) {
      if (c.binding !== "")
        mismatch(file, c.name, `hello has binding ${c.binding}; section 4 gives none`);
    } else if (type === 0xa0) {
      const ok = hellos.some(
        (h) => h.c.address === c.address && h.c.fields.gatewayRandom === c.binding,
      );
      if (!ok) mismatch(file, c.name, `binding ${c.binding} is not the random of any hello`);
    } else if (GATEWAY_TYPES.has(type) || gatewayAddresses.has(c.address)) {
      if (!sessions.has(c.binding))
        mismatch(file, c.name, `binding ${c.binding} is not the session value of any connection`);
    } else if (type === 0x81 || type === 0x82) {
      // The counter (4 bytes) of the sensor packet it answers.
      if (hex(c.binding).length !== 4) {
        mismatch(file, c.name, `binding of ${hex(c.binding).length} bytes; section 4 gives 4`);
        continue;
      }
      const counter = hex(c.binding).readUInt32LE(0);
      const a = sensorPackets.find((s) => s.c.address === c.address && s.c.counter === counter);
      if (!a) {
        count("envelope: sensor bindings not traceable to a case");
        continue;
      }
      count("envelope: sensor bindings traced to a case");
      if (type === 0x82 && !(a.type === 0x02 && a.c.fields.flags.doorOpen))
        mismatch(
          file,
          c.name,
          `disarmed notice bound to ${a.file} › ${a.c.name}, not a door-open report (section 4)`,
        );
    } else if (c.binding !== "")
      mismatch(file, c.name, `binding ${c.binding}; section 4 gives none`);
  }

  // Packets carried inside forwarded packets and transmit requests.
  for (const { file, c, type } of allValid) {
    if (type !== 0x21 && type !== 0xa1) continue;
    const inner = hex(c.fields.packet);
    const match = allValid.find((v) => v.c.packet === c.fields.packet);
    if (match) {
      count("envelope: carried packets matched to a case");
      if (type === 0xa1 && match.c.direction !== 1)
        mismatch(file, c.name, "transmit request carries a packet to the hub");
      if (type === 0x21 && match.c.direction !== 0)
        mismatch(file, c.name, "forwarded packet carries a packet from the hub");
      if (match.c.maxLength !== 255) note(`${file} › ${c.name}: carries a non-radio case`);
      if (type === 0xa1 && c.fields.priority === 1 && match.type !== 0x90)
        mismatch(file, c.name, `priority 1 (siren command) carrying a ${match.file} packet`);
      continue;
    }
    // Not a case: try to open it with the key known for its clear address.
    const key = inner.length >= HEADER_LENGTH ? keyOf.get(inner.readUInt32LE(1)) : undefined;
    const e = key
      ? errorOf(() => {
          const o = openPacket(inner, {
            key: hex(key),
            expectedDirection: (inner[0] >> 3) & 1,
            binding: Buffer.alloc(0),
            maxLength: 255,
          });
          decodeMessage(o.plaintext, o.direction);
        })
      : new ProtocolError("no key for its address");
    if (e) note(`${file} › ${c.name}: carried packet is not a case and does not open (${e.code})`);
    else {
      count("envelope: carried packets opened with the device key");
      note(`${file} › ${c.name}: carried packet is not a case, but opens with its device's key`);
    }
  }
}

// ---------------------------------------------------------------------------
// Rejected packets
// ---------------------------------------------------------------------------

function openAndDecode(packet, opts) {
  const o = openPacket(packet, opts);
  decodeMessage(o.plaintext, o.direction);
  return o;
}

{
  const F = "rejected-packets.json";
  const file = load(F, KNOWN_TOP[F]);
  const CLEAR_CHECKS = new Set([
    "tooLong",
    "badVersion",
    "wrongDirection",
    "badAddress",
    "badCounter",
  ]);
  for (const c of list(F, file, "packets"))
    guard(F, c, () => {
      knownKeys(F, c, [
        "name",
        "key",
        "expectedDirection",
        "binding",
        "maxLength",
        "packet",
        "error",
        "messageType",
      ]);
      count("envelope: rejected packets");
      const opts = {
        key: hex(c.key),
        expectedDirection: c.expectedDirection,
        binding: hex(c.binding),
        maxLength: c.maxLength,
      };
      const packet = hex(c.packet);
      const err = errorOf(() => openAndDecode(packet, opts));
      if (!err) mismatch(F, c.name, `my implementation accepts it (vector: ${c.error})`);
      else if (err.code !== c.error)
        mismatch(F, c.name, `my reason ${err.code}, vector ${c.error}`);
      else if (c.error === "unknownType" && err.extra.messageType !== c.messageType)
        mismatch(F, c.name, `unknown type byte ${err.extra.messageType}, vector ${c.messageType}`);
      // Does the case isolate the check it names, or would the tag fail anyway?
      if (CLEAR_CHECKS.has(c.error) && rawOpen(packet, opts.key, opts.binding) === null)
        note(
          `${F} › ${c.name}: tag also fails, so the case does not isolate "${c.error}" from badTag`,
        );
      // Second reason that also applies; section 3 says the over-limit length byte wins.
      if (c.error === "badLength" || c.error === "truncated") {
        const pt = rawOpen(packet, opts.key, opts.binding);
        if (pt && pt[0] === 0x30) {
          const len = pt[1 + 7];
          if (c.error === "badLength" && pt.length < 1 + 8 + len)
            count("envelope: badLength cases also cut short (section 3 ordering)");
        }
      }
    });
  for (const c of list(F, file, "replayed"))
    guard(F, c, () => {
      knownKeys(F, c, [
        "name",
        "key",
        "expectedDirection",
        "binding",
        "maxLength",
        "packet",
        "rule",
        "stateBefore",
        "rejection",
      ]);
      count("counters: replayed packets");
      const opts = {
        key: hex(c.key),
        expectedDirection: c.expectedDirection,
        binding: hex(c.binding),
        maxLength: c.maxLength,
      };
      let o;
      const err = errorOf(() => {
        o = openAndDecode(hex(c.packet), opts);
      });
      if (err) {
        mismatch(F, c.name, `replayed packet does not open: ${err.code}`);
        return;
      }
      let result;
      if (c.rule === "replayWindow") result = windowAccept(hex(c.stateBefore), o.counter);
      else if (c.rule === "strictlyHigher") result = strictlyHigher(c.stateBefore, o.counter);
      else {
        mismatch(F, c.name, `unknown rule ${c.rule}`);
        return;
      }
      if (result.accepted) mismatch(F, c.name, `my ${c.rule} accepts counter ${o.counter}`);
      else if (result.rejection !== c.rejection)
        mismatch(F, c.name, `my rejection ${result.rejection}, vector ${c.rejection}`);
    });
}

// ---------------------------------------------------------------------------
// 3. COBS (section 10)
// ---------------------------------------------------------------------------

function cobsEncode(data) {
  const out = [];
  const segments = [];
  let start = 0;
  for (let i = 0; i <= data.length; i++) {
    if (i === data.length || data[i] === 0) {
      segments.push(data.subarray(start, i));
      start = i + 1;
    }
  }
  segments.forEach((s, k) => {
    const last = k === segments.length - 1;
    let pos = 0;
    while (s.length - pos >= 254) {
      out.push(0xff, ...s.subarray(pos, pos + 254));
      pos += 254;
    }
    const r = s.length - pos;
    // The implied zero after a block ends the segment; at the very end of the data
    // a run that filled whole 254-byte blocks needs no further code byte.
    if (!last || r > 0 || s.length === 0) out.push(r + 1, ...s.subarray(pos));
  });
  return Buffer.from(out);
}

function cobsDecode(encoded) {
  if (encoded.length === 0) reject("badFrame");
  const out = [];
  let i = 0;
  while (i < encoded.length) {
    const code = encoded[i];
    if (code === 0) reject("badFrame");
    if (i + code > encoded.length) reject("badFrame");
    for (let j = i + 1; j < i + code; j++) {
      if (encoded[j] === 0) reject("badFrame");
      out.push(encoded[j]);
    }
    i += code;
    if (code < 0xff && i < encoded.length) out.push(0);
  }
  return Buffer.from(out);
}

const LINK_MAX = 1024;
const FRAME_MAX = LINK_MAX + Math.ceil(LINK_MAX / 254); // 1,029: longest encoding of 1,024 bytes

function streamDecode(chunks) {
  const frames = [];
  let buf = [];
  let overflow = false;
  for (const chunk of chunks)
    for (const b of chunk) {
      if (b !== 0) {
        if (buf.length >= FRAME_MAX) overflow = true;
        else buf.push(b);
        continue;
      }
      if (overflow) frames.push({ error: "tooLong" });
      else if (buf.length > 0) {
        const e = errorOf(() => {
          const d = cobsDecode(Buffer.from(buf));
          frames.push(d.length > LINK_MAX ? { error: "tooLong" } : { data: toHex(d) });
        });
        if (e) frames.push({ error: e.code });
      }
      buf = [];
      overflow = false;
    }
  return frames;
}

{
  const F = "cobs.json";
  const file = load(F, KNOWN_TOP[F]);
  for (const c of list(F, file, "valid"))
    guard(F, c, () => {
      count("cobs: valid");
      const enc = cobsEncode(hex(c.data));
      if (toHex(enc) !== c.encoded)
        mismatch(F, c.name, `encoded ${c.encoded.slice(0, 40)}…, mine ${toHex(enc).slice(0, 40)}…`);
      if (c.frame !== c.encoded + "00") mismatch(F, c.name, "frame is not encoded + 00");
      const e = errorOf(() => {
        const d = cobsDecode(hex(c.encoded));
        if (toHex(d) !== c.data) mismatch(F, c.name, "decodes to different data");
      });
      if (e) mismatch(F, c.name, `my decoder rejects it: ${e.code}`);
      if (hex(c.encoded).includes(0)) mismatch(F, c.name, "encoded form contains a zero byte");
      // Section 10: a decoder also accepts the empty block after a final 254-byte run.
      const data = hex(c.data);
      const lastZero = data.lastIndexOf(0);
      const finalRun = data.length - (lastZero + 1);
      if (finalRun > 0 && finalRun % 254 === 0) {
        count("cobs: with optional empty block");
        const e2 = errorOf(() => {
          if (!cobsDecode(hex(c.encoded + "01")).equals(data))
            mismatch(F, c.name, "decoding with the empty block differs");
        });
        if (e2) mismatch(F, c.name, `decoding with the empty block fails: ${e2.code}`);
      }
    });
  for (const c of list(F, file, "invalid"))
    guard(F, c, () => {
      count("cobs: invalid");
      const e = errorOf(() => cobsDecode(hex(c.encoded)));
      if (!e) mismatch(F, c.name, "my decoder accepts it");
      else if (e.code !== c.error) mismatch(F, c.name, `my reason ${e.code}, vector ${c.error}`);
    });
  for (const c of list(F, file, "streams"))
    guard(F, c, () => {
      count("cobs: streams");
      const frames = streamDecode(c.chunks.map(hex));
      for (const d of diff(c.frames, frames)) mismatch(F, c.name, d);
    });
}

// ---------------------------------------------------------------------------
// 4. Counters (section 4)
// ---------------------------------------------------------------------------

// Sender: before using a counter that is a multiple of the step, save counter + step.
function take(step, next, resumePoint) {
  let save = null;
  if (next % step === 0) {
    save = next + step;
    if (save > U32_MAX) return { error: "counterExhausted" };
  }
  return {
    counter: next,
    saveResumePoint: save,
    nextAfter: next + 1,
    resumePointAfter: save ?? resumePoint,
  };
}

// Hub receive window: highest (u32 LE) then 64-bit mask (u64 LE), bit i = highest − 1 − i.
function windowAccept(state, counter) {
  const highest = state.readUInt32LE(0);
  const mask = state.readBigUInt64LE(4);
  const FULL = (1n << 64n) - 1n;
  let newHighest = highest;
  let newMask;
  if (counter > highest) {
    const shift = BigInt(counter - highest);
    newHighest = counter;
    // highest 0 means nothing has been accepted yet (counter 0 is never sent).
    const oldBit = highest === 0 ? 0n : shift <= 64n ? 1n << (shift - 1n) : 0n;
    newMask = ((shift >= 64n ? 0n : (mask << shift) & FULL) | oldBit) & FULL;
  } else if (counter === highest) return { accepted: false, rejection: "duplicate" };
  else {
    const d = highest - counter;
    if (d > 64) return { accepted: false, rejection: "tooOld" };
    const bit = 1n << BigInt(d - 1);
    if (mask & bit) return { accepted: false, rejection: "duplicate" };
    newMask = mask | bit;
  }
  const out = Buffer.alloc(12);
  out.writeUInt32LE(newHighest, 0);
  out.writeBigUInt64LE(newMask, 4);
  return { accepted: true, highest: newHighest, state: out };
}

// Siren (and gateway connection): strictly higher than the last accepted.
function strictlyHigher(last, counter) {
  if (counter > last) return { accepted: true };
  return { accepted: false, rejection: counter === last ? "duplicate" : "tooOld" };
}

// Restoring a backup moves the hub's counter forward by 2^24 from the saved resume point.
function restore(backedUpResumePoint) {
  const next = backedUpResumePoint + 2 ** 24;
  return next > U32_MAX ? { error: "counterExhausted" } : { next };
}

{
  const F = "counters.json";
  const file = load(F, KNOWN_TOP[F]);
  list(F, file, "take").forEach((c, i) =>
    guard(F, c, () => {
      count("counters: take");
      const r = take(c.step, c.next, c.resumePoint);
      const expected = Object.fromEntries(
        ["counter", "saveResumePoint", "nextAfter", "resumePointAfter", "error"]
          .filter((k) => k in c)
          .map((k) => [k, c[k]]),
      );
      for (const d of diff(expected, r)) mismatch(F, `take[${i}] step ${c.step} next ${c.next}`, d);
    }),
  );
  list(F, file, "powerLoss").forEach((seq, i) =>
    guard(F, seq, () => {
      count("counters: powerLoss");
      let next = 1;
      let stored = seq.initialResumePoint;
      if (seq.initialResumePoint !== seq.step)
        mismatch(F, `powerLoss[${i}]`, "initial resume point is not the step");
      seq.events.forEach((ev, j) => {
        const name = `powerLoss[${i}] event ${j}`;
        if (ev.event === "powerLoss") {
          next = stored;
          if (ev.resumeFrom !== stored)
            mismatch(F, name, `resumeFrom ${ev.resumeFrom}, mine ${stored}`);
          return;
        }
        const saved = [];
        let first;
        let lastC;
        for (let k = 0; k < ev.count; k++) {
          const r = take(seq.step, next, stored);
          if (r.error) {
            mismatch(F, name, r.error);
            return;
          }
          if (r.saveResumePoint !== null) saved.push(r.saveResumePoint);
          first ??= r.counter;
          lastC = r.counter;
          next = r.nextAfter;
          stored = r.resumePointAfter;
        }
        for (const d of diff(
          {
            firstCounter: ev.firstCounter,
            lastCounter: ev.lastCounter,
            savedResumePoints: ev.savedResumePoints,
          },
          { firstCounter: first, lastCounter: lastC, savedResumePoints: saved },
        ))
          mismatch(F, name, d);
      });
    }),
  );
  list(F, file, "restore").forEach((c, i) =>
    guard(F, c, () => {
      count("counters: restore");
      const r = restore(c.backedUpResumePoint);
      const expected = "error" in c ? { error: c.error } : { next: c.next };
      for (const d of diff(expected, r))
        mismatch(F, `restore[${i}] from ${c.backedUpResumePoint}`, d);
    }),
  );
  for (const seq of list(F, file, "replayWindow"))
    guard(F, seq, () => {
      count("counters: replayWindow sequences");
      let state = Buffer.alloc(12);
      seq.steps.forEach((s, j) => {
        count("counters: replayWindow steps");
        const r = windowAccept(state, s.counter);
        const mine = r.accepted
          ? { counter: s.counter, accepted: true, highest: r.highest, state: toHex(r.state) }
          : { counter: s.counter, accepted: false, rejection: r.rejection };
        for (const d of diff(s, mine)) mismatch(F, `${seq.name} step ${j}`, d);
        if (r.accepted) state = r.state;
      });
    });
  for (const seq of list(F, file, "strictlyHigher"))
    guard(F, seq, () => {
      count("counters: strictlyHigher sequences");
      let last = 0;
      seq.steps.forEach((s, j) => {
        count("counters: strictlyHigher steps");
        const r = strictlyHigher(last, s.counter);
        const mine = { lastAccepted: last, counter: s.counter, accepted: r.accepted };
        if (!r.accepted) mine.rejection = r.rejection;
        for (const d of diff(s, mine)) mismatch(F, `${seq.name} step ${j}`, d);
        if (r.accepted) last = s.counter;
      });
    });
}

// ---------------------------------------------------------------------------
// 5. Time on air (spike S2)
// ---------------------------------------------------------------------------

const SF_OF_DR = [12, 11, 10, 9, 8, 7]; // section 2, data rates

// ToA = (2^SF / BW_kHz) ms × N_symbol, N_symbol = N_pre + 4.25 + 8
//   + ceil(max(8·N_bytes + N_crc − 4·SF + 8 + N_header, 0) / (4·SF or 4·(SF−2) with LDRO)) × (CR + 4)
function timeOnAirMicros(sf, length) {
  const preamble = 8;
  const crc = 16;
  const header = 20;
  const cr = 1;
  const ldro = sf >= 11;
  const divisor = 4 * (ldro ? sf - 2 : sf);
  const payloadSymbols =
    Math.ceil(Math.max(8 * length + crc - 4 * sf + 8 + header, 0) / divisor) * (cr + 4);
  const quarterSymbols = 4 * preamble + 17 + 32 + 4 * payloadSymbols; // N_symbol × 4
  // symbol time = 2^SF / 125 ms = 2^SF × 8 µs; × N_symbol = 2^SF × 2 × (4 N_symbol)
  return 2 ** sf * 2 * quarterSymbols;
}

{
  const F = "time-on-air.json";
  const file = load(F, KNOWN_TOP[F]);
  for (const c of list(F, file, "cases"))
    guard(F, c, () => {
      count("time on air: vectors");
      const name = `DR${c.dataRate} ${c.length} bytes`;
      if (SF_OF_DR[c.dataRate] !== c.spreadingFactor)
        mismatch(F, name, `SF${c.spreadingFactor}, section 2 gives SF${SF_OF_DR[c.dataRate]}`);
      const us = timeOnAirMicros(SF_OF_DR[c.dataRate], c.length);
      if (us !== c.microseconds) mismatch(F, name, `${c.microseconds} µs, mine ${us} µs`);
      if (c.milliseconds !== c.microseconds / 1000)
        mismatch(F, name, `milliseconds ${c.milliseconds} ≠ microseconds / 1000`);
    });
  // Section 2's table of the protocol itself, rounded to whole milliseconds.
  const TABLE = [
    ["Sensor status", 25, [62, 206, 412, 1483]],
    ["Hub reply", 32, [72, 247, 453, 1810]],
    ["Disarmed notice", 18, [51, 185, 330, 1319]],
    ["Siren command", 21, [57, 185, 371, 1483]],
    ["Siren report", 28, [67, 226, 412, 1647]],
    ["Started", 26, [62, 206, 412, 1647]],
    ["Log entry over LoRa, longest", 50, [98, 329, 616, 2302]],
  ];
  for (const [name, length, ms] of TABLE)
    [7, 9, 10, 12].forEach((sf, i) => {
      count("time on air: section 2 table");
      const mine = Math.round(timeOnAirMicros(sf, length) / 1000);
      if (mine !== ms[i])
        mismatch("docs/protocol.md §2", `${name} SF${sf}`, `table ${ms[i]} ms, formula ${mine} ms`);
    });
  // Section 8: event listen time by the rate the report was sent at.
  const EVENT_LISTEN_MS = [3000, 2600, 2200, 1900, 1700, 1500]; // DR0 … DR5
  const seen = new Set();
  for (const c of list(F, file, "eventListen"))
    guard(F, c, () => {
      count("time on air: event listen times");
      const name = `eventListen DR${c.dataRate}`;
      seen.add(c.dataRate);
      knownKeys(F, { ...c, name }, ["name", "dataRate", "spreadingFactor", "milliseconds"]);
      if (SF_OF_DR[c.dataRate] !== c.spreadingFactor)
        mismatch(F, name, `SF${c.spreadingFactor}, section 2 gives SF${SF_OF_DR[c.dataRate]}`);
      if (EVENT_LISTEN_MS[c.dataRate] !== c.milliseconds)
        mismatch(
          F,
          name,
          `${c.milliseconds} ms, section 8 gives ${EVENT_LISTEN_MS[c.dataRate]} ms`,
        );
    });
  for (let dr = 0; dr < EVENT_LISTEN_MS.length; dr++)
    if (!seen.has(dr)) mismatch(F, "eventListen", `no entry for DR${dr} (section 8)`);
  // Worked example in S2: SF7, 16 bytes, 51.5 ms.
  if (timeOnAirMicros(7, 16) !== 51456)
    mismatch("S2", "worked example", `${timeOnAirMicros(7, 16)} µs`);
  // Packet sizes in section 2's table against the body tables.
  const size = (type) =>
    HEADER_LENGTH + 1 + MESSAGES[type].fields.reduce((a, f) => a + f[2], 0) + TAG_LENGTH;
  for (const [name, type, bytes] of [
    ["Sensor status", 0x01, 25],
    ["Hub reply", 0x81, 32],
    ["Disarmed notice", 0x82, 18],
    ["Siren command", 0x90, 21],
    ["Siren report", 0x10, 28],
    ["Started", 0x05, 26],
  ])
    if (size(type) !== bytes)
      mismatch(
        "docs/protocol.md §2",
        name,
        `table says ${bytes} bytes, section 6 gives ${size(type)}`,
      );
}

// ---------------------------------------------------------------------------
// 6. Pairing data (section 9) and USB setup messages (section 10)
// ---------------------------------------------------------------------------

const PAIRING = [
  ["address", 0, 4, "u"],
  ["key", 4, 16, "bytes"],
  ["hubIdentity", 20, 8, "bytes"],
  ["firmwareSigningKey", 28, 64, "bytes"],
  ["siteChannel", 92, 1, "u", { values: [0, 1, 2] }],
  ["allowedDataRateMask", 93, 1, "u", { maskOf: 6 }],
  ["wifiName", 94, 1, "text", { maxBytes: 32, bytes: true }],
];
const PASSWORD = [["wifiPassword", 0, 1, "text", { maxBytes: 64, bytes: true }]];

// Section 9: hub identity = first 8 bytes of SHA-256 over the 64 key bytes. Decoders do not
// check it (README), so a case that breaks it on purpose is only noted.
let signingPublicKey = null;
function checkSigningKey(file, name, f) {
  count("pairing: signing keys checked");
  if (!onP256(f.firmwareSigningKey))
    mismatch(file, name, "firmwareSigningKey is not a point on P-256 (section 9)");
  if (signingPublicKey !== null && f.firmwareSigningKey !== signingPublicKey)
    mismatch(file, name, "firmwareSigningKey does not derive from signingPrivateKey");
  if (hubIdentityOf(f.firmwareSigningKey) !== f.hubIdentity) {
    if (/does not match/.test(name)) count("pairing: deliberate hub identity mismatches");
    else mismatch(file, name, `hubIdentity ${f.hubIdentity} is not SHA-256 of the signing key`);
  }
}
function publicKeyOf(privateHex) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(hex(privateHex));
  const pub = ecdh.getPublicKey(); // 0x04 · X · Y
  return toHex(pub.subarray(1));
}

const hubIdentityOf = (keyHex) =>
  toHex(createHash("sha256").update(hex(keyHex)).digest().subarray(0, 8));
function onP256(keyHex) {
  const k = hex(keyHex);
  const b64 = (b) => b.toString("base64url");
  try {
    createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64(k.subarray(0, 32)), y: b64(k.subarray(32)) },
      format: "jwk",
    });
    return true;
  } catch {
    return false;
  }
}

// Canonical entries must encode exactly; non-canonical ones (sections 9 and 10: extra bytes
// after the fields are ignored) must start with the canonical encoding and have more after it.
function compareEncoding(file, c, enc, bytes) {
  if (typeof c.canonical !== "boolean") mismatch(file, c.name, "no boolean `canonical`");
  if (c.canonical === false) {
    count(`${file.replace(".json", "")}: decode-only cases with trailing bytes`);
    if (!(bytes.length > enc.length && bytes.subarray(0, enc.length).equals(enc)))
      mismatch(file, c.name, `non-canonical, but bytes do not start with ${toHex(enc)} plus extra`);
  } else if (!enc.equals(bytes)) mismatch(file, c.name, `encoded ${toHex(enc)}`);
}

function decodePairing(bytes) {
  if (bytes.length < 1) reject("truncated");
  if (bytes[0] !== 1) reject("badVersion");
  const body = bytes.subarray(1);
  const [head, used] = decodeFields(PAIRING, body);
  if (head.address === 0 || head.address === U32_MAX) reject("badAddress");
  const [pw] = decodeFields(PASSWORD, body.subarray(used));
  return { ...head, ...pw }; // bytes after the password are ignored
}
function encodePairing(f) {
  return Buffer.concat([Buffer.from([1]), encodeFields(PAIRING, f), encodeFields(PASSWORD, f)]);
}

const SETUP = {
  0x01: [],
  0x02: [
    ["role", 0, 1, "u", { values: [1, 2, 3] }],
    ["chipId", 1, 6, "bytes"],
    ["firmwareVersion", 7, 3, "version"],
    ["paired", 10, 1, "bool"],
    ["hubIdentity", 11, 8, "bytes"],
    ["developmentBuild", 19, 1, "bool"],
  ],
  0x03: "pairing",
  0x04: [["result", 0, 1, "u", { values: [0, 1, 2] }]],
  0x05: [],
  0x06: [["role", 0, 1, "u", { values: [1, 2, 3] }]], // set role
};

function decodeSetup(bytes) {
  if (bytes.length === 0) reject("truncated");
  if (bytes[0] !== 0xf1) reject("badValue");
  if (bytes.length < 2) reject("truncated");
  const type = bytes[1];
  const spec = SETUP[type];
  if (spec === undefined) reject("unknownType", { messageType: type });
  const body = bytes.subarray(2);
  if (spec === "pairing") return { type, fields: { pairing: decodePairing(body) } };
  // Booleans are bytes 0 or 1; the generic decoder reads them as u8 first.
  const asU8 = spec.map(([n, o, s, k, opt]) => [n, o, s, k === "bool" ? "u" : k, opt]);
  const [raw] = decodeFields(asU8, body);
  for (const [n, , , k] of spec)
    if (k === "bool") {
      if (raw[n] !== 0 && raw[n] !== 1) reject("badValue");
      raw[n] = raw[n] === 1;
    }
  return { type, fields: raw, problems: rangeProblems(asU8, raw) };
}
function encodeSetup(type, fields) {
  const spec = SETUP[type];
  if (spec === undefined) reject("unknownType", { messageType: type });
  const body =
    spec === "pairing"
      ? encodePairing(fields.pairing)
      : encodeFields(
          spec.map(([n, o, s, k, opt]) => [n, o, s, k === "bool" ? "u" : k, opt]),
          Object.fromEntries(
            Object.entries(fields).map(([k, v]) => [k, typeof v === "boolean" ? Number(v) : v]),
          ),
        );
  return Buffer.concat([Buffer.from([0xf1, type]), body]);
}

{
  const F = "pairing-data.json";
  const file = load(F, KNOWN_TOP[F]);
  if (file.signingPrivateKey === undefined) note(`${F}: no signingPrivateKey`);
  else {
    signingPublicKey = publicKeyOf(file.signingPrivateKey);
    count("pairing: public key derived from signingPrivateKey");
    if (!onP256(signingPublicKey)) mismatch(F, "signingPrivateKey", "derived key not on P-256");
  }
  for (const c of list(F, file, "valid"))
    guard(F, c, () => {
      knownKeys(F, c, ["name", "canonical", "fields", "bytes"]);
      count("pairing: valid");
      const e = errorOf(() => {
        const d = decodePairing(hex(c.bytes));
        for (const x of diff(c.fields, d)) mismatch(F, c.name, x);
        count(
          "pairing: unlisted enumerated values passed through",
          rangeProblems([...PAIRING, ...PASSWORD], d).length,
        );
      });
      if (e) mismatch(F, c.name, `my decoder rejects it: ${e.code}`);
      compareEncoding(F, c, encodePairing(c.fields), hex(c.bytes));
      checkSigningKey(F, c.name, c.fields);
    });
  for (const c of list(F, file, "hubIdentity"))
    guard(F, c, () => {
      knownKeys(F, c, ["name", "firmwareSigningKey", "hubIdentity"]);
      count("pairing: hub identity");
      const mine = hubIdentityOf(c.firmwareSigningKey);
      if (mine !== c.hubIdentity) mismatch(F, c.name, `hubIdentity ${c.hubIdentity}, mine ${mine}`);
    });
  for (const c of list(F, file, "invalid"))
    guard(F, c, () => {
      knownKeys(F, c, ["name", "bytes", "error"]);
      count("pairing: invalid");
      const e = errorOf(() => decodePairing(hex(c.bytes)));
      if (!e) mismatch(F, c.name, `my decoder accepts it (vector: ${c.error})`);
      else if (e.code !== c.error) mismatch(F, c.name, `my reason ${e.code}, vector ${c.error}`);
      if (c.error === "badLength") {
        // Is the length byte also running past the end? Then truncated applies too.
        const b = hex(c.bytes);
        const nameLen = b[1 + 94];
        const short = /name/.test(c.name)
          ? b.length < 1 + 95 + nameLen
          : b.length < 1 + 95 + nameLen + 1 + b[1 + 95 + nameLen];
        if (short) count("pairing: badLength cases also cut short (section 3 ordering)");
      }
    });
}

{
  const F = "setup-messages.json";
  const file = load(F, KNOWN_TOP[F]);
  for (const c of list(F, file, "valid"))
    guard(F, c, () => {
      knownKeys(F, c, ["name", "setupType", "canonical", "fields", "bytes", "frame"]);
      count("setup: valid");
      const bytes = hex(c.bytes);
      const e = errorOf(() => {
        const d = decodeSetup(bytes);
        if (d.type !== c.setupType) mismatch(F, c.name, `setup type ${d.type}`);
        for (const x of diff(c.fields, d.fields)) mismatch(F, c.name, x);
        count("setup: unlisted enumerated values passed through", (d.problems ?? []).length);
      });
      if (e) mismatch(F, c.name, `my decoder rejects it: ${e.code}`);
      compareEncoding(F, c, encodeSetup(c.setupType, c.fields), bytes);
      const frame = toHex(cobsEncode(bytes)) + "00";
      if (frame !== c.frame) mismatch(F, c.name, `frame ${c.frame}, mine ${frame}`);
      if (c.setupType === 3) checkSigningKey(F, c.name, c.fields.pairing);
      if (c.setupType === 2 && c.fields.paired && signingPublicKey !== null)
        if (c.fields.hubIdentity !== hubIdentityOf(signingPublicKey))
          note(`${F} › ${c.name}: paired identity is not the pairing cases' hub identity`);
      if (c.setupType === 2 && c.fields.paired === (c.fields.hubIdentity === "0000000000000000"))
        note(
          `${F} › ${c.name}: paired=${c.fields.paired} with hubIdentity ${c.fields.hubIdentity} ("hub identity or zeros")`,
        );
    });
  for (const c of list(F, file, "invalid"))
    guard(F, c, () => {
      knownKeys(F, c, ["name", "bytes", "error", "messageType"]);
      count("setup: invalid");
      const e = errorOf(() => decodeSetup(hex(c.bytes)));
      if (!e) mismatch(F, c.name, `my decoder accepts it (vector: ${c.error})`);
      else if (e.code !== c.error) mismatch(F, c.name, `my reason ${e.code}, vector ${c.error}`);
      else if (c.error === "unknownType" && e.extra.messageType !== c.messageType)
        mismatch(F, c.name, `type byte ${e.extra.messageType}, vector ${c.messageType}`);
    });
}

// ---------------------------------------------------------------------------
// Units (section 3 "Battery byte" and "Rounding", section 6 field units)
// ---------------------------------------------------------------------------

// Nearest whole number, an exact half rounding up (section 3). Exact for a / b with integers.
const roundDiv = (a, b) => Math.floor((2 * a + b) / (2 * b));
const UNITS = {
  batteryEncode: [
    "millivolts",
    "byte",
    (mv) => Math.min(255, Math.max(0, roundDiv(mv - 2500, 10))),
  ],
  batteryDecode: ["byte", "millivolts", (b) => 2500 + 10 * b],
  fifteenSecondDecode: ["units", "seconds", (u) => u * 15],
  // Section 6 gives "in units of 15 seconds"; a value that is not a whole number of units, or
  // does not fit the byte, cannot be sent (my reading; the spec does not say to round here).
  fifteenSecondEncode: [
    "seconds",
    "units",
    (s) => (Number.isInteger(s / 15) && s / 15 >= 0 && s / 15 <= 255 ? s / 15 : null),
  ],
  tenthsDecode: ["tenths", "milliseconds", (t) => t * 100],
  tenthsEncode: [
    "milliseconds",
    "tenths",
    (ms) => {
      const t = roundDiv(ms, 100);
      return t >= 0 && t <= 65535 ? t : null;
    },
  ],
  clockCorrectionDecode: ["units", "ppm", (u) => u * 10],
  clockCorrectionEncode: [
    "ppm",
    "units",
    (ppm) => {
      const u = roundDiv(ppm, 10);
      return u >= -32768 && u <= 32767 ? u : null;
    },
  ],
  snrDecode: ["quarterDecibels", "decibels", (q) => q / 4],
  airtimeDecode: ["hundredthsOfPercent", "percent", (h) => h / 100, 1e-9],
};
{
  const F = "units.json";
  const file = load(F, [...KNOWN_TOP[F], ...Object.keys(UNITS)]);
  for (const [key, [from, to, fn, tolerance]] of Object.entries(UNITS)) {
    for (const c of list(F, file, key))
      guard(F, c, () => {
        count(`units: ${key}`);
        const mine = fn(c[from]);
        const same =
          tolerance !== undefined && mine !== null && c[to] !== null
            ? Math.abs(mine - c[to]) <= tolerance
            : Object.is(mine, c[to]);
        if (!same) mismatch(F, `${key} ${from} ${c[from]}`, `vector ${c[to]}, mine ${mine}`);
      });
  }
}

// The app's vectors (`app-*.json`, the app channel's, m2-design.md section 10): A9's part.
const appFiles = verifyAppVectors(VECTORS, { mismatch, count, note });

// Every vector file, the device's and the app's, must be one this script checks.
for (const name of readdirSync(VECTORS))
  if (name.endsWith(".json") && !loadedFiles.has(name) && !appFiles.has(name))
    mismatch(name, "(file)", "a vector file the script does not know");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("Checked:");
for (const [kind, n] of [...counts].sort()) console.log(`  ${String(n).padStart(4)}  ${kind}`);
if (notes.length) {
  console.log(`\nNotes (not failures; things the vectors leave untested or do loosely):`);
  for (const n of notes) console.log(`  - ${n}`);
}
const total = [...counts.values()].reduce((a, b) => a + b, 0);
if (mismatches.length) {
  console.log(`\nMismatches:`);
  for (const m of mismatches) console.log(`  ✗ ${m}`);
}
console.log(`\n${total} checks, ${mismatches.length} mismatches, ${notes.length} notes`);
process.exitCode = mismatches.length ? 1 : 0;

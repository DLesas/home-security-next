// Independent check of the firmware update vectors that are not message files:
// started-update.json, transfer-frames.json, image-header.json and ble-update-session.json.
//
// Written from docs/m3-updates-design.md (section 3, "The device image header" and "What a device
// checks"; section 5, "The device messages", "Transfer frames" and "The session key"),
// docs/protocol.md section 6 (Started) and vectors/README.md, without reading packages/protocol/src.
// The cryptography is Node's own: SHA-256, HMAC, HKDF and ECDSA P-256 from node:crypto. CRC-32 is
// this file's own, bit by bit.
//
// Called by verify-vectors.mjs with its `mismatch`, `count`, `note`, its packet sealer and opener
// and `errorOf`; returns the file names it checked. Every disagreement is a mismatch, never an
// exception.

import { Buffer } from "node:buffer";
import { createHash, createHmac, createPublicKey, hkdfSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const UPDATE_FILES = [
  "started-update.json",
  "transfer-frames.json",
  "image-header.json",
  "ble-update-session.json",
];

const hex = (s) => Buffer.from(s, "hex");
const toHex = (b) => Buffer.from(b).toString("hex");
const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const ascii = (s) => Buffer.from(s, "ascii");
const zero = Buffer.from([0]);
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

class Refused extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}
const refuse = (code, extra) => {
  throw new Refused(code, extra);
};
const errorJson = (e) =>
  e.code === "unknownType"
    ? { error: e.code, messageType: e.extra.messageType }
    : { error: e.code };

// CRC-32, reflected polynomial 0xEDB88320, initial value and final XOR 0xFFFFFFFF.
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function verifyUpdateVectors(
  dir,
  { mismatch, count, note, sealPacket, openPacket, errorOf },
) {
  const read = (name, known) => {
    let file;
    try {
      file = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch (e) {
      mismatch(name, "(file)", `cannot be read: ${e.message}`);
      return {};
    }
    if (file.schemaVersion !== 1) mismatch(name, "(file)", `schemaVersion ${file.schemaVersion}`);
    if (file.protocolVersion !== 1)
      mismatch(name, "(file)", `protocolVersion ${file.protocolVersion}`);
    for (const k of Object.keys(file))
      if (!["schemaVersion", "protocolVersion", ...known].includes(k))
        mismatch(name, "(file)", `section "${k}" the script does not know`);
    return file;
  };
  const each = (file, obj, key, fn) => {
    const list = obj[key];
    if (!Array.isArray(list)) {
      mismatch(file, "(file)", `no "${key}" array`);
      return;
    }
    for (const c of list) {
      try {
        fn(c);
      } catch (e) {
        mismatch(file, c?.name ?? "?", `the script cannot process this case (${e.message})`);
      }
    }
  };
  const same = (file, name, what, vector, mine) => {
    if (JSON.stringify(vector) !== JSON.stringify(mine))
      mismatch(
        file,
        name,
        `${what}: vector ${JSON.stringify(vector)}, mine ${JSON.stringify(mine)}`,
      );
  };

  // -------------------------------------------------------------------------
  // Started with the M3 fields (section 5: offset 8 image flags, offset 9 failed version)
  // -------------------------------------------------------------------------
  {
    const F = "started-update.json";
    const file = read(F, ["valid", "invalid"]);
    const version = (b, at) => ({ major: b[at], minor: b[at + 1], patch: b[at + 2] });
    const decode = (plaintext) => {
      if (plaintext.length < 1) refuse("truncated");
      if (plaintext[0] !== 0x05) refuse("badValue");
      const body = plaintext.subarray(1);
      if (body.length < 8) refuse("truncated");
      const fields = {
        role: body[0],
        firmwareVersion: version(body, 1),
        resetCause: body[4],
        lastFatalError: body.readUInt16LE(5),
        settingsVersion: body[7],
      };
      if (body.length === 8) return { fields, image: null };
      if (body.length < 12) refuse("truncated");
      const image = {
        flags: { onTrial: (body[8] & 1) === 1, rolledBack: ((body[8] >> 1) & 1) === 1 },
        failedVersion: version(body, 9),
      };
      return { fields, image };
    };
    each(F, file, "valid", (c) => {
      count("started-update: valid packets");
      const packet = hex(c.packet);
      const opened = errorOf(() => {
        const o = openPacket(packet, {
          key: hex(c.key),
          expectedDirection: 0,
          binding: hex(c.binding),
          maxLength: c.maxLength,
        });
        if (toHex(o.plaintext) !== c.plaintext) mismatch(F, c.name, "opened plaintext differs");
        if (o.address !== c.address || o.counter !== c.counter)
          mismatch(F, c.name, "opened header differs");
      });
      if (opened) mismatch(F, c.name, `my opener rejects it: ${opened.code}`);
      const sealed = sealPacket({
        key: hex(c.key),
        direction: 0,
        address: c.address,
        counter: c.counter,
        binding: hex(c.binding),
        plaintext: hex(c.plaintext),
      });
      if (!sealed.equals(packet)) mismatch(F, c.name, "sealed packet differs");
      if (c.messageType !== 0x05) mismatch(F, c.name, `messageType ${c.messageType}`);
      const { fields, image } = decode(hex(c.plaintext));
      same(F, c.name, "fields", c.fields, fields);
      same(F, c.name, "image", c.image, image);
      if (c.maxLength === 255 && packet.length > 30)
        mismatch(F, c.name, `radio packet of ${packet.length} bytes, Started is at most 30`);
    });
    each(F, file, "invalid", (c) => {
      count("started-update: unreadable M3 fields");
      let got = null;
      try {
        decode(hex(c.plaintext));
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        got = errorJson(e);
      }
      same(F, c.name, "error", { error: c.error }, got);
    });
  }

  // -------------------------------------------------------------------------
  // Transfer frames (section 5)
  // -------------------------------------------------------------------------
  const MAX_DATA = 1000;
  const FRAMES = {
    0x01: [
      ["imageId", 8, "bytes"],
      ["offset", 4, "u"],
      ["length", 2, "u"],
    ],
    0x02: [
      ["imageId", 8, "bytes"],
      ["offset", 4, "u"],
      ["crc32", 4, "u"],
      ["data", 0, "rest"],
    ],
    0x03: [
      ["imageId", 8, "bytes"],
      ["reason", 1, "u"],
    ],
    0x10: [
      ["address", 4, "u"],
      ["deviceRandom", 8, "bytes"],
      ["imageId", 8, "bytes"],
      ["bytesHeld", 4, "u"],
      ["largestData", 2, "u"],
    ],
    0x11: [["tag", 16, "bytes"]],
    0x12: [
      ["imageId", 8, "bytes"],
      ["result", 1, "u"],
      ["reason", 1, "u"],
    ],
  };
  const readUint = (b, at, size) =>
    size === 1 ? b[at] : size === 2 ? b.readUInt16LE(at) : b.readUInt32LE(at);
  const writeUint = (n, size) => {
    const b = Buffer.alloc(size);
    if (size === 1) b.writeUInt8(n);
    else if (size === 2) b.writeUInt16LE(n);
    else b.writeUInt32LE(n);
    return b;
  };
  const decodeFrame = (b) => {
    if (b.length < 1) refuse("truncated");
    if (b[0] !== 0xf2) refuse("badValue");
    if (b.length < 2) refuse("truncated");
    const kind = b[1];
    const spec = FRAMES[kind];
    if (spec === undefined) refuse("unknownType", { messageType: kind });
    const fields = {};
    let at = 2;
    for (const [name, size, type] of spec) {
      if (type === "rest") {
        const rest = b.subarray(at);
        if (rest.length < 1) refuse("truncated");
        if (rest.length > MAX_DATA) refuse("tooLong");
        fields[name] = toHex(rest);
        at = b.length;
        continue;
      }
      if (b.length < at + size) refuse("truncated");
      fields[name] = type === "u" ? readUint(b, at, size) : toHex(b.subarray(at, at + size));
      at += size;
    }
    if (kind === 0x01 && (fields.length < 1 || fields.length > MAX_DATA)) refuse("badValue");
    return { kind, fields };
  };
  const encodeFrame = (kind, fields) =>
    Buffer.concat([
      Buffer.from([0xf2, kind]),
      ...FRAMES[kind].map(([name, size, type]) =>
        type === "u" ? writeUint(fields[name], size) : hex(fields[name]),
      ),
    ]);
  {
    const F = "transfer-frames.json";
    const file = read(F, ["prefix", "crc32", "valid", "invalid"]);
    if (file.prefix !== 0xf2) mismatch(F, "(file)", `prefix ${file.prefix}`);
    each(F, file, "crc32", (c) => {
      count("transfer-frames: CRC-32 values");
      same(F, c.name, "crc32", c.crc32, crc32(hex(c.data)));
    });
    const check = crc32(ascii("123456789"));
    if (check !== 0xcbf43926) mismatch(F, "(script)", `my CRC-32 check value ${check}`);
    each(F, file, "valid", (c) => {
      count("transfer-frames: valid frames");
      const bytes = hex(c.bytes);
      const { kind, fields } = decodeFrame(bytes);
      same(F, c.name, "kind", c.kind, kind);
      same(F, c.name, "fields", c.fields, fields);
      if (kind === 0x02)
        same(F, c.name, "intact", c.intact, crc32(hex(fields.data)) === fields.crc32);
      else if (c.intact !== undefined) mismatch(F, c.name, "intact on a frame that is not Data");
      const enc = encodeFrame(kind, fields);
      if (c.canonical === true) {
        if (!enc.equals(bytes)) mismatch(F, c.name, `encoded ${toHex(enc)}`);
        if (kind === 0x02 && crc32(hex(fields.data)) !== fields.crc32)
          mismatch(F, c.name, "a canonical Data frame whose CRC does not match");
      } else if (c.canonical === false) {
        const extra = bytes.length > enc.length && bytes.subarray(0, enc.length).equals(enc);
        const badCrc = enc.equals(bytes) && kind === 0x02 && c.intact === false;
        if (!extra && !badCrc)
          mismatch(F, c.name, "non-canonical, but not extra bytes or a bad CRC");
      } else mismatch(F, c.name, "no boolean `canonical`");
    });
    each(F, file, "invalid", (c) => {
      count("transfer-frames: rejected frames");
      let got = null;
      try {
        decodeFrame(hex(c.bytes));
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        got = errorJson(e);
      }
      const expected =
        c.messageType === undefined
          ? { error: c.error }
          : { error: c.error, messageType: c.messageType };
      same(F, c.name, "error", expected, got);
    });
  }

  // -------------------------------------------------------------------------
  // The image header (section 3)
  // -------------------------------------------------------------------------
  {
    const F = "image-header.json";
    const file = read(F, [
      "label",
      "signing",
      "signingPrivateKey",
      "signingKey",
      "hubIdentity",
      "rfc6979Sample",
      "image",
      "valid",
      "checks",
    ]);
    const LABEL = Buffer.concat([ascii("hsn-image/1"), zero]);
    if (file.label !== "hsn-image/1") mismatch(F, "(file)", `label ${file.label}`);
    // An uncompressed P-256 point as SPKI: the fixed DER prefix, then 0x04 X Y.
    const spki = (xy) =>
      createPublicKey({
        key: Buffer.concat([
          hex("3059301306072a8648ce3d020106082a8648ce3d030107034200"),
          Buffer.from([0x04]),
          hex(xy),
        ]),
        format: "der",
        type: "spki",
      });
    const ecdsaOk = (message, signature, xy) => {
      try {
        return verify("sha256", message, { key: spki(xy), dsaEncoding: "ieee-p1363" }, signature);
      } catch {
        return false;
      }
    };
    const identity = (xy) => sha256(hex(xy)).subarray(0, 8);
    if (toHex(identity(file.signingKey)) !== file.hubIdentity)
      mismatch(F, "(file)", "hubIdentity is not SHA-256 of signingKey, first 8 bytes");
    {
      const s = file.rfc6979Sample;
      count("image-header: RFC 6979 sample verified");
      if (!ecdsaOk(hex(s.message), hex(s.r + s.s), file.signingKey))
        mismatch(F, "rfc6979Sample", "does not verify under signingKey");
      if (s.r !== "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716")
        mismatch(F, "rfc6979Sample", "r is not RFC 6979 A.2.5's");
      note(
        `${F}: the RFC 6979 sample and the headers are verified, not re-signed (Node's ECDSA is randomised)`,
      );
    }
    const encodeBody = (f) => {
      const b = Buffer.alloc(64);
      ascii("HSNI").copy(b, 0);
      b[4] = 1;
      b[5] = f.flags.ownBuild ? 1 : 0;
      b[6] = f.roles;
      b[7] = f.target;
      b[8] = f.version.major;
      b[9] = f.version.minor;
      b[10] = f.version.patch;
      b.writeUInt32LE(f.imageBytes, 12);
      hex(f.imageSha256).copy(b, 16);
      hex(f.hubIdentity).copy(b, 48);
      return b;
    };
    const imageSha = toHex(sha256(hex(file.image)));
    each(F, file, "valid", (c) => {
      count("image-header: valid headers");
      const body = encodeBody(c.fields);
      const signed = Buffer.concat([LABEL, body]);
      same(F, c.name, "signedBytes", c.signedBytes, toHex(signed));
      same(F, c.name, "signedSha256", c.signedSha256, toHex(sha256(signed)));
      same(F, c.name, "header", c.header, toHex(body) + c.signature);
      same(F, c.name, "imageId", c.imageId, c.header.slice(32, 48));
      if (!ecdsaOk(signed, hex(c.signature), file.signingKey))
        mismatch(F, c.name, "signature does not verify");
      if (c.fields.hubIdentity !== file.hubIdentity) mismatch(F, c.name, "another hub identity");
      if (c.fields.imageSha256 !== imageSha) note(`${F} › ${c.name}: not the hash of "image"`);
    });
    // Section 3's checks, in order: 6 badHeader, 7 wrongHub, 8 wrongRole, 9 tooLarge,
    // 10 badSignature; 0 none.
    const reasonOf = (h, e) => {
      if (h.length < 128) return 6;
      if (!h.subarray(0, 4).equals(ascii("HSNI")) || h[4] !== 1 || h[7] !== 1 || h[11] !== 0)
        return 6;
      if (h.subarray(56, 64).some((b) => b !== 0)) return 6;
      if (toHex(h.subarray(48, 56)) !== e.hubIdentity) return 7;
      if ((h[6] & (1 << e.role)) === 0) return 8;
      if (h.readUInt32LE(12) > e.capacity) return 9;
      if (!ecdsaOk(Buffer.concat([LABEL, h.subarray(0, 64)]), h.subarray(64, 128), e.signingKey))
        return 10;
      return 0;
    };
    each(F, file, "checks", (c) => {
      count("image-header: device checks");
      same(F, c.name, "reason", c.reason, reasonOf(hex(c.header), c.expect));
    });
  }

  // -------------------------------------------------------------------------
  // The Bluetooth update session (section 5): K and the Open tag; the address little-endian.
  // -------------------------------------------------------------------------
  {
    const F = "ble-update-session.json";
    const file = read(F, ["serviceUuid", "rxUuid", "txUuid", "sessionKeys", "openTags", "names"]);
    same(F, "(file)", "serviceUuid", file.serviceUuid, "1012a7e5-5d53-44e0-9170-6c34720148a4");
    same(F, "(file)", "rxUuid", file.rxUuid, "9e848f59-78c5-4f7e-b604-38d088ceda4f");
    same(F, "(file)", "txUuid", file.txUuid, "0a218c6e-e0b9-4cfe-9580-e13887bcd840");
    each(F, file, "sessionKeys", (c) => {
      count("ble-update-session: session keys");
      const info = Buffer.concat([ascii("hsn-ble-update/1"), zero, u32le(c.address)]);
      same(F, c.name, "info", c.info, toHex(info));
      const k = Buffer.from(hkdfSync("sha256", hex(c.deviceKey), hex(c.nonce), info, 32));
      same(F, c.name, "sessionKey", c.sessionKey, toHex(k));
    });
    each(F, file, "openTags", (c) => {
      count("ble-update-session: open tags");
      const message = Buffer.concat([
        ascii("hsn-ble-open/1"),
        zero,
        u32le(c.address),
        hex(c.deviceRandom),
        hex(c.imageId),
      ]);
      const tag = createHmac("sha256", hex(c.sessionKey)).update(message).digest().subarray(0, 16);
      same(F, c.name, "tag", c.tag, toHex(tag));
    });
    each(F, file, "names", (c) => {
      count("ble-update-session: device names");
      same(F, String(c.address), "name", c.name, `hsn-${c.address.toString(16).padStart(8, "0")}`);
    });
  }

  return new Set(UPDATE_FILES);
}

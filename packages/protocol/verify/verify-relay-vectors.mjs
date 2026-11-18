// Independent check of the relay's vectors: relay-xn.json, relay-push.json and relay-frames.json.
//
// Written from docs/m4-design.md (section 3, the hub link, the relay link and their frames; section
// 5, push and the h format), the vector files' own descriptions and the Noise Protocol Framework
// (revision 34). It imports nothing from packages/protocol/src and runs none of it. The frames'
// bounds that the design's tables leave out (version and file-name forms, the enumerations, the
// welcome's limits) are restated by hand from the frozen schemas of step 0, which are the
// specification (src/relay/frames.ts), never from the codecs that implement them.
// The cryptography is Node's own: X25519, ChaCha20-Poly1305, SHA-256 and HMAC from node:crypto. The
// Noise state machine below (XN only) is this file's own, checked first against the published XN
// vectors kept in vectors/noise-published (third-party data, not the library).
//
// Called by verify-vectors.mjs with its `mismatch`, `count` and `note`; returns the file names it
// checked. Every disagreement is a mismatch, never an exception. Messages name fields and cases
// only, never key bytes.

import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

export const RELAY_FILES = ["relay-xn.json", "relay-push.json", "relay-frames.json"];

const XN = "Noise_XN_25519_ChaChaPoly_SHA256";
const ascii = (s) => Buffer.from(s, "ascii");
const zero = Buffer.from([0]);
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hmac = (key, ...parts) => createHmac("sha256", key).update(Buffer.concat(parts)).digest();
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

class ShapeError extends Error {}
class Refused extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function hexField(obj, key, len) {
  const v = obj?.[key];
  if (typeof v !== "string" || !/^(?:[0-9a-f]{2})*$/.test(v))
    throw new ShapeError(`"${key}" is not lower-case hex`);
  const b = Buffer.from(v, "hex");
  if (len !== undefined && b.length !== len)
    throw new ShapeError(`"${key}" is ${b.length} bytes, not ${len}`);
  return b;
}

// RFC 4648 base32, lower case, no padding: a hub's (or relay's) identity.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const identityOf = (staticPublic) => base32(sha256(staticPublic).subarray(0, 16));

// ---------------------------------------------------------------------------
// X25519 and ChaCha20-Poly1305 (node:crypto)
// ---------------------------------------------------------------------------

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const privateKey = (raw) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
const publicKey = (raw) =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
const publicOf = (raw) =>
  createPublicKey(privateKey(raw)).export({ format: "der", type: "spki" }).subarray(12);

// The low-order u-coordinates the XN file's description lists.
const P_MINUS = (d) => Buffer.from([0xed - d, ...Array(30).fill(0xff), 0x7f]);
const LOW_ORDER = new Map([
  ["0", Buffer.alloc(32)],
  ["1", Buffer.from([1, ...Array(31).fill(0)])],
  [
    "order 8 (a)",
    Buffer.from("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "hex"),
  ],
  [
    "order 8 (b)",
    Buffer.from("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157", "hex"),
  ],
  ["p - 1", P_MINUS(1)],
  ["p", P_MINUS(0)],
  ["p + 1", P_MINUS(-1)],
  ["2^255", Buffer.from([...Array(31).fill(0), 0x80])],
]);
const lowOrderName = (pub) => [...LOW_ORDER].find(([, v]) => same(v, pub))?.[0];

let zeroDhInputs = [];
function dh(priv, pub) {
  let out;
  try {
    out = diffieHellman({ privateKey: privateKey(priv), publicKey: publicKey(pub) });
  } catch (e) {
    // OpenSSL fails the derivation exactly when the shared secret is all zero (RFC 7748 6.1).
    if (e?.code !== "ERR_OSSL_FAILED_DURING_DERIVATION") throw e;
    out = Buffer.alloc(32);
  }
  if (out.every((b) => b === 0)) {
    zeroDhInputs.push(Buffer.from(pub));
    throw new Refused("allZeroDh");
  }
  return out;
}

function seal(key, nonce, ad, plain) {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  c.setAAD(ad, { plaintextLength: plain.length });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function open(key, nonce, ad, sealed) {
  if (sealed.length < 16) return null;
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  d.setAAD(ad, { plaintextLength: sealed.length - 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Noise (revision 34): 25519, ChaChaPoly, SHA256; pattern XN only
//   -> e
//   <- e, ee
//   -> s, se
// ---------------------------------------------------------------------------

const MAX_NOISE = 65535;
function noiseHkdf(ck, ikm, n) {
  const temp = hmac(ck, ikm);
  const out = [hmac(temp, Buffer.from([1]))];
  for (let i = 2; i <= n; i++) out.push(hmac(temp, out[i - 2], Buffer.from([i])));
  return out;
}

class CipherState {
  constructor(k = null) {
    this.k = k;
    this.n = 0n;
  }
  nonce() {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(this.n, 4);
    return nonce;
  }
  encrypt(ad, plain) {
    if (!this.k) return Buffer.from(plain);
    const out = seal(this.k, this.nonce(), ad, plain);
    this.n++;
    return out;
  }
  decrypt(ad, sealed) {
    if (!this.k) return Buffer.from(sealed);
    if (sealed.length < 16) throw new Refused("badMessage");
    const out = open(this.k, this.nonce(), ad, sealed);
    if (!out) throw new Refused("decryptFailed");
    this.n++;
    return out;
  }
}

const XN_MESSAGES = [["e"], ["e", "ee"], ["s", "se"]];
/** The fewest bytes of each XN message: e; e and a tag; an encrypted static key and a tag. */
const XN_SHORTEST = [32, 48, 64];

/** One side of XN. `s` {private, public} for the initiator only; `e` the fixed ephemeral. */
class XnSide {
  constructor({ initiator, prologue, s = null, e }) {
    Object.assign(this, { initiator, s, e, re: null, rs: null, i: 0, failed: false });
    const name = ascii(XN);
    this.h =
      name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name);
    this.ck = this.h;
    this.cs = new CipherState();
    this.mixHash(prologue);
  }
  mixHash(data) {
    this.h = sha256(this.h, data);
  }
  mixKey(ikm) {
    const [ck, k] = noiseHkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cs = new CipherState(k);
  }
  encryptAndHash(plain) {
    const ct = this.cs.encrypt(this.h, plain);
    this.mixHash(ct);
    return ct;
  }
  decryptAndHash(ct) {
    const plain = this.cs.decrypt(this.h, ct);
    this.mixHash(ct);
    return plain;
  }
  get complete() {
    return this.i >= 3;
  }
  myTurn() {
    return !this.complete && (this.i % 2 === 0) === this.initiator;
  }
  guarded(fn) {
    if (this.failed) throw new Refused("refused");
    try {
      return fn();
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
  token(t, write, take, out) {
    if (t === "e") {
      const pub = write ? this.e.public : take(32);
      if (write) out.push(pub);
      else this.re = pub;
      this.mixHash(pub);
    } else if (t === "s") {
      if (write) out.push(this.encryptAndHash(this.s.public));
      else this.rs = this.decryptAndHash(take(48));
    } else if (t === "ee") {
      this.mixKey(dh(this.e.private, this.re));
    } else if (t === "se") {
      // The initiator's static with the responder's ephemeral.
      this.mixKey(this.initiator ? dh(this.s.private, this.re) : dh(this.e.private, this.rs));
    }
  }
  write(payload) {
    return this.guarded(() => {
      if (!this.myTurn()) throw new Refused("notMyTurn");
      const out = [];
      for (const t of XN_MESSAGES[this.i]) this.token(t, true, null, out);
      out.push(this.encryptAndHash(payload));
      this.i++;
      const msg = Buffer.concat(out);
      if (msg.length > MAX_NOISE) throw new Refused("tooLong");
      return msg;
    });
  }
  read(message) {
    return this.guarded(() => {
      if (this.complete || this.myTurn()) throw new Refused("notMyTurn");
      if (message.length > MAX_NOISE) throw new Refused("tooLong");
      if (message.length < XN_SHORTEST[this.i]) throw new Refused("badMessage");
      let at = 0;
      const take = (n) => message.subarray(at, (at += n));
      for (const t of XN_MESSAGES[this.i]) this.token(t, false, take, null);
      const payload = this.decryptAndHash(message.subarray(at));
      this.i++;
      return payload;
    });
  }
  split() {
    const [k1, k2] = noiseHkdf(this.ck, Buffer.alloc(0), 2);
    const [c1, c2] = [new CipherState(k1), new CipherState(k2)];
    return this.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}

// ---------------------------------------------------------------------------
// PushContent (m4-design.md section 5; relay-push.json's description lists the categories and bounds)
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "sensorSilentWhileDisarmed",
  "sirenPathLost",
  "gatewayOffline",
  "batteryLow",
  "armDisarm",
  "updates",
  "countdown",
  "alarm",
  "localAlarm",
  "tamper",
  "longPress",
  "sensorSilentWhileArmed",
  "sirenSilent",
  "jamming",
  "scheduleMissedOrHeldBack",
  "disk",
  "newClient",
  "backup",
  "hub",
  "stateUnexpected",
];
const IDENTITY = /^[a-z2-7]{26}$/;
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const isBool = (v) => typeof v === "boolean";
/** Text of `min` to `max` Unicode code points (the description's rule; not UTF-16 units). */
const textOf = (v, min, max) =>
  typeof v === "string" && [...v].length >= min && [...v].length <= max;
const onlyKeys = (obj, required, optional = []) =>
  isObject(obj) &&
  required.every((k) => Object.hasOwn(obj, k)) &&
  Object.keys(obj).every((k) => required.includes(k) || optional.includes(k));

/** Whether a value is a PushContent, by section 5's interface and the bounds relay-push.json's description gives. */
function isPushContent(c) {
  if (!onlyKeys(c, ["v", "hub", "n", "delayed", "names", "actions", "armed"], ["detail"]))
    return false;
  const n = c.n;
  const nOk =
    onlyKeys(n, ["seq", "atMs", "clockOk", "kind", "category", "critical", "device", "cause"]) &&
    isInt(n.seq, 0, MAX_SAFE) &&
    isInt(n.atMs, 0, MAX_SAFE) &&
    isBool(n.clockOk) &&
    textOf(n.kind, 1, 64) &&
    CATEGORIES.includes(n.category) &&
    isBool(n.critical) &&
    (n.device === null || isInt(n.device, 1, 2 ** 32 - 1)) &&
    (n.cause === null || isInt(n.cause, 0, MAX_SAFE));
  const namesOk =
    onlyKeys(c.names, [], ["device", "person", "client", "mode", "schedule"]) &&
    Object.values(c.names).every((v) => textOf(v, 1, 64));
  const detailOk =
    c.detail === undefined ||
    (isObject(c.detail) &&
      Object.entries(c.detail).every(
        ([k, v]) =>
          textOf(k, 1, 64) &&
          (typeof v === "string" || isBool(v) || (typeof v === "number" && Number.isFinite(v))),
      ));
  return (
    c.v === 1 &&
    typeof c.hub === "string" &&
    IDENTITY.test(c.hub) &&
    nOk &&
    isBool(c.delayed) &&
    namesOk &&
    detailOk &&
    Array.isArray(c.actions) &&
    c.actions.length <= 1 &&
    c.actions.every((a) => a === "disarm" || a === "armAway") &&
    isBool(c.armed)
  );
}

/** Two JSON values equal, key order aside. */
function jsonEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => jsonEqual(x, b[i]))
    );
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return jsonEqual(ka, kb) && ka.every((k) => jsonEqual(a[k], b[k]));
  }
  return Object.is(a, b);
}

// ---------------------------------------------------------------------------
// The h format (section 5)
// ---------------------------------------------------------------------------

const PADDED = 1280;
const pushAad = (keyId) => Buffer.concat([ascii("hsn-push/1"), zero, keyId]);
const H_FORM = /^1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{1744})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Opens h with `keys` (a Map of key id hex to key); throws Refused with the description's reason. */
function openH(h, keys) {
  const m = typeof h === "string" ? H_FORM.exec(h) : null;
  if (!m) throw new Refused("badFormat");
  const body = Buffer.from(m[2], "base64url");
  if (body.length !== 12 + PADDED + 16 || body.toString("base64url") !== m[2])
    throw new Refused("badFormat");
  const key = keys.get(m[1]);
  if (!key) throw new Refused("unknownKey");
  const padded = open(
    key,
    body.subarray(0, 12),
    pushAad(Buffer.from(m[1], "hex")),
    body.subarray(12),
  );
  if (!padded) throw new Refused("decryptFailed");
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 0x80) throw new Refused("badPadding");
  let content;
  try {
    content = JSON.parse(utf8.decode(padded.subarray(0, end)));
  } catch {
    throw new Refused("badContent");
  }
  if (!isPushContent(content)) throw new Refused("badContent");
  return content;
}

// ---------------------------------------------------------------------------
// The links' text frames (section 3's tables; the bounds as the frozen schemas state them)
// ---------------------------------------------------------------------------

const MAX_TEXT = 131072;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const RELEASE_PLATFORMS = ["darwin-arm64", "linux-x64", "linux-arm64", "windows-x64"];
const HUB_FILE =
  /^hsn-hub-(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})-(darwin-arm64|linux-x64|linux-arm64|windows-x64)\.hsnr$/;
const FIRMWARE_FILE = /^hsn-firmware-(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.hsnf$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const isU32 = (v) => isInt(v, 0, 0xffffffff);
const isVersion = (v) => typeof v === "string" && VERSION.test(v);
const isH = (v) => typeof v === "string" && H_FORM.test(v);
const HUB_CLOSES = [1000, 1008, 1013, 4000, 4001, 4002, 4003, 4004];

function tokenFits(platform, token) {
  if (typeof token !== "string") return false;
  if (platform === "apns") return /^[0-9a-fA-F]{64,200}$/.test(token);
  if (platform === "fcm")
    return token.length >= 1 && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token);
  return false;
}
const isTarget = (t) =>
  onlyKeys(t, ["key", "platform", "env", "token", "unreachable", "back"]) &&
  KEY_ID.test(t.key) &&
  ["production", "development"].includes(t.env) &&
  tokenFits(t.platform, t.token) &&
  isH(t.unreachable) &&
  isH(t.back);
const isOffer = (o) => {
  const common =
    isVersion(o?.version) &&
    isInt(o?.bytes, 1, MAX_SAFE) &&
    typeof o?.sha256 === "string" &&
    SHA256_HEX.test(o.sha256);
  if (o?.kind === "hub")
    return (
      onlyKeys(o, ["kind", "version", "platform", "file", "bytes", "sha256"]) &&
      common &&
      RELEASE_PLATFORMS.includes(o.platform) &&
      HUB_FILE.test(o.file)
    );
  if (o?.kind === "firmware")
    return (
      onlyKeys(o, ["kind", "version", "target", "roles", "file", "bytes", "sha256"]) &&
      common &&
      o.target === "esp32s3" &&
      Array.isArray(o.roles) &&
      o.roles.length >= 1 &&
      o.roles.length <= 3 &&
      o.roles.every((r) => isInt(r, 1, 3)) &&
      new Set(o.roles).size === o.roles.length &&
      typeof o.file === "string" &&
      FIRMWARE_FILE.test(o.file)
    );
  return false;
};
const items = (list, each) =>
  Array.isArray(list) && list.length >= 1 && list.length <= 32 && list.every(each);

const FRAMES = {
  ping: (f) => onlyKeys(f, ["t", "n"]) && isU32(f.n),
  pong: (f) => onlyKeys(f, ["t", "n"]) && isU32(f.n),
  hubClose: (f) =>
    onlyKeys(f, ["t", "stream", "code"]) && isU32(f.stream) && HUB_CLOSES.includes(f.code),
  relayClose: (f) =>
    onlyKeys(f, ["t", "stream", "code"]) && isU32(f.stream) && isInt(f.code, 1000, 4999),
  roster: (f) =>
    onlyKeys(f, ["t", "rev", "targets"]) &&
    isInt(f.rev, 0, MAX_SAFE) &&
    Array.isArray(f.targets) &&
    f.targets.every(isTarget) &&
    new Set(f.targets.map((t) => t.key)).size === f.targets.length,
  hubPush: (f) =>
    onlyKeys(f, ["t", "items"]) &&
    items(
      f.items,
      (i) =>
        onlyKeys(i, ["id", "key", "h"]) &&
        isInt(i.id, 1, MAX_SAFE) &&
        KEY_ID.test(i.key) &&
        isH(i.h),
    ),
  relayPush: (f) =>
    onlyKeys(f, ["t", "items"]) &&
    items(
      f.items,
      (i) =>
        onlyKeys(i, ["id", "hub", "platform", "env", "token", "h"]) &&
        isInt(i.id, 1, MAX_SAFE) &&
        typeof i.hub === "string" &&
        IDENTITY.test(i.hub) &&
        ["production", "development"].includes(i.env) &&
        tokenFits(i.platform, i.token) &&
        isH(i.h),
    ),
  restarting: (f) =>
    onlyKeys(f, ["t", "reason", "withinMs"]) &&
    ["update", "restore"].includes(f.reason) &&
    isInt(f.withinMs, 0, 600000),
  check: (f) =>
    onlyKeys(f, ["t", "platform", "running"], ["firmware"]) &&
    RELEASE_PLATFORMS.includes(f.platform) &&
    isVersion(f.running) &&
    (f.firmware === undefined || isVersion(f.firmware)),
  get: (f) =>
    onlyKeys(f, ["t", "id", "file", "offset", "length"]) &&
    isU32(f.id) &&
    typeof f.file === "string" &&
    (HUB_FILE.test(f.file) || FIRMWARE_FILE.test(f.file)) &&
    isInt(f.offset, 0, MAX_SAFE) &&
    isInt(f.length, 1, 262144),
  joined: (f) =>
    onlyKeys(f, ["t", "identity"]) && typeof f.identity === "string" && IDENTITY.test(f.identity),
  open: (f) =>
    onlyKeys(f, ["t", "stream", "path", "peer"]) &&
    isU32(f.stream) &&
    ["session", "link", "restore"].includes(f.path) &&
    typeof f.peer === "string" &&
    /^relay-[0-9a-f]{16}$/.test(f.peer),
  rosterAck: (f) => onlyKeys(f, ["t", "rev"]) && isInt(f.rev, 0, MAX_SAFE),
  pushResult: (f) =>
    onlyKeys(f, ["t", "results"]) &&
    items(
      f.results,
      (r) =>
        onlyKeys(r, ["id", "outcome"]) &&
        isInt(r.id, 1, MAX_SAFE) &&
        ["accepted", "badToken", "limited", "failed"].includes(r.outcome),
    ),
  restartingAck: (f) => onlyKeys(f, ["t"]),
  offer: (f) =>
    onlyKeys(f, ["t", "releases"]) &&
    Array.isArray(f.releases) &&
    f.releases.length <= 2 &&
    f.releases.every(isOffer) &&
    new Set(f.releases.map((r) => r.kind)).size === f.releases.length,
  releaseError: (f) =>
    onlyKeys(f, ["t", "id", "reason"], ["retryAfterMs"]) &&
    isU32(f.id) &&
    ["notFound", "range", "limit", "unavailable"].includes(f.reason) &&
    (f.retryAfterMs === undefined || isInt(f.retryAfterMs, 0, MAX_SAFE)),
  limit: (f) =>
    onlyKeys(f, ["t", "what", "retryAfterMs"]) &&
    ["newIdentity", "upgrades", "streams", "traffic", "pushes", "releases"].includes(f.what) &&
    isInt(f.retryAfterMs, 0, MAX_SAFE),
};

/** Each direction's frames, by `t`. */
const DIRECTIONS = {
  hubToRelay: {
    ping: FRAMES.ping,
    close: FRAMES.hubClose,
    roster: FRAMES.roster,
    push: FRAMES.hubPush,
    restarting: FRAMES.restarting,
    "release.check": FRAMES.check,
    "release.get": FRAMES.get,
  },
  relayToHub: {
    joined: FRAMES.joined,
    pong: FRAMES.pong,
    open: FRAMES.open,
    close: FRAMES.relayClose,
    rosterAck: FRAMES.rosterAck,
    pushResult: FRAMES.pushResult,
    restartingAck: FRAMES.restartingAck,
    "release.offer": FRAMES.offer,
    "release.error": FRAMES.releaseError,
    limit: FRAMES.limit,
  },
  relayToPush: {
    ping: FRAMES.ping,
    push: FRAMES.relayPush,
    "release.check": FRAMES.check,
    "release.get": FRAMES.get,
  },
  pushToRelay: {
    joined: FRAMES.joined,
    pong: FRAMES.pong,
    pushResult: FRAMES.pushResult,
    "release.offer": FRAMES.offer,
    "release.error": FRAMES.releaseError,
    limit: FRAMES.limit,
  },
};

function acceptsText(direction, text) {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT) return false;
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return false;
  }
  const check =
    isObject(frame) && Object.hasOwn(DIRECTIONS[direction], frame.t)
      ? DIRECTIONS[direction][frame.t]
      : null;
  return check !== null && check(frame);
}

// ---------------------------------------------------------------------------
// The links' binary frames
// ---------------------------------------------------------------------------

function decodeBinary(bytes) {
  if (bytes.length === 0) throw new Refused("truncated");
  const kind = bytes[0];
  if (kind !== 1 && kind !== 2) throw new Refused("unknownKind");
  if (bytes.length < 5) throw new Refused("truncated");
  const payload = bytes.subarray(5);
  const max = kind === 1 ? 65535 : 262144;
  if (payload.length < 1 || payload.length > max) throw new Refused("badLength");
  const number = bytes.readUInt32LE(1);
  return kind === 1
    ? { kind, stream: number, message: payload.toString("hex") }
    : { kind, id: number, bytes: payload.toString("hex") };
}

function encodeBinary(frame) {
  const head = Buffer.alloc(5);
  head[0] = frame.kind;
  head.writeUInt32LE(frame.kind === 1 ? frame.stream : frame.id, 1);
  return Buffer.concat([head, Buffer.from(frame.kind === 1 ? frame.message : frame.bytes, "hex")]);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export function verifyRelayVectors(dir, { mismatch, count, note }) {
  const ctx = { mismatch, count, note, dir };
  selfCheckXn(ctx);
  checkXn(ctx);
  checkPush(ctx);
  checkFrames(ctx);
  return new Set(RELAY_FILES);
}

function load(ctx, name, sections) {
  let file;
  try {
    file = JSON.parse(readFileSync(join(ctx.dir, name), "utf8"));
  } catch (e) {
    ctx.mismatch(name, "(file)", `cannot be read: ${e.message}`);
    return {};
  }
  if (!isObject(file)) {
    ctx.mismatch(name, "(file)", "is not a JSON object");
    return {};
  }
  for (const k of Object.keys(file))
    if (!["schemaVersion", "description", ...sections].includes(k))
      ctx.mismatch(name, "(file)", `section "${k}" the script does not know`);
  if (file.schemaVersion !== 1) ctx.mismatch(name, "(file)", `schemaVersion ${file.schemaVersion}`);
  if (typeof file.description !== "string") ctx.mismatch(name, "(file)", "no description");
  for (const s of sections)
    if (!Array.isArray(file[s])) {
      ctx.mismatch(name, "(file)", `"${s}" is not an array`);
      file[s] = [];
    }
  return file;
}
function guardCase(ctx, file, name, fn) {
  try {
    fn();
  } catch (e) {
    const why = e instanceof ShapeError ? e.message : `${e?.constructor?.name}: ${e?.message}`;
    ctx.mismatch(file, name, `the script cannot process this case (${why})`);
  }
}
function knownKeys(ctx, file, name, obj, keys) {
  for (const k of Object.keys(obj ?? {}))
    if (!keys.includes(k)) ctx.mismatch(file, name, `field "${k}" the script does not know`);
}
function keyPair(ctx, file, name, obj, label) {
  const pair = { private: hexField(obj, "private", 32), public: hexField(obj, "public", 32) };
  ctx.count("relay: X25519 public keys from their private keys");
  if (!same(publicOf(pair.private), pair.public))
    ctx.mismatch(file, name, `${label}: public key is not the private key's`);
  return pair;
}

// Mine against the published XN vectors: shows this file's XN is Noise's.
function selfCheckXn(ctx) {
  const F = "noise-published";
  for (const src of ["cacophony.txt", "snow.txt"]) {
    let vectors;
    try {
      vectors = JSON.parse(readFileSync(join(ctx.dir, F, src), "utf8")).vectors;
      if (!Array.isArray(vectors)) throw new ShapeError("no vectors");
    } catch {
      ctx.note(`${F}/${src} not found: this script's XN was not checked against it`);
      continue;
    }
    const xn = vectors.filter((x) => x.protocol_name === XN);
    if (xn.length === 0) ctx.mismatch(`${F}/${src}`, XN, "no published XN vector");
    for (const v of xn)
      guardCase(ctx, `${F}/${src}`, XN, () => {
        ctx.count("relay: published XN vectors this script's XN reproduces");
        const k = (s) => ({ private: hexField(v, s, 32), public: publicOf(hexField(v, s, 32)) });
        const I = new XnSide({
          initiator: true,
          prologue: hexField(v, "init_prologue"),
          s: k("init_static"),
          e: k("init_ephemeral"),
        });
        const R = new XnSide({
          initiator: false,
          prologue: hexField(v, "resp_prologue"),
          e: k("resp_ephemeral"),
        });
        let t = null;
        v.messages.forEach((m, i) => {
          const fromI = i % 2 === 0;
          const payload = hexField(m, "payload");
          let ct;
          let back;
          if (!I.complete) {
            ct = (fromI ? I : R).write(payload);
            back = (fromI ? R : I).read(ct);
            if (I.complete) t = { I: I.split(), R: R.split() };
          } else {
            ct = (fromI ? t.I.send : t.R.send).encrypt(Buffer.alloc(0), payload);
            back = (fromI ? t.R.recv : t.I.recv).decrypt(Buffer.alloc(0), ct);
          }
          if (!same(ct, hexField(m, "ciphertext")) || !same(back, payload))
            ctx.mismatch(`${F}/${src}`, XN, `message ${i}: this script's XN differs`);
        });
        if (v.handshake_hash && !same(I.h, hexField(v, "handshake_hash")))
          ctx.mismatch(`${F}/${src}`, XN, "handshake hash: this script's XN differs");
      });
  }
}

const PROLOGUES = {
  hub: Buffer.concat([ascii("hsn-relay/1"), zero]),
  relay: Buffer.concat([ascii("hsn-relay-peer/1"), zero]),
};
const linkOfPrologue = (p) => Object.keys(PROLOGUES).find((k) => same(PROLOGUES[k], p));

/** The handshake payloads by section 3's table (proto [min, max] with 1 ≤ min ≤ max). */
function payloadProblem(link, index, bytes) {
  let p;
  try {
    p = JSON.parse(utf8.decode(bytes));
  } catch {
    return "not UTF-8 JSON";
  }
  const range = (r) =>
    Array.isArray(r) &&
    r.length === 2 &&
    isInt(r[0], 1, MAX_SAFE) &&
    isInt(r[1], 1, MAX_SAFE) &&
    r[0] <= r[1];
  if (index === 0 && link === "hub")
    return onlyKeys(p, ["proto", "hub"]) && range(p.proto) && isVersion(p.hub)
      ? null
      : "not a RelayHello";
  if (index === 0)
    return onlyKeys(p, ["proto", "relay"]) && range(p.proto) && isVersion(p.relay)
      ? null
      : "not a RelayPeerHello";
  if (index === 1) {
    const roles = ["relay", "push", "names", "releases"];
    const limits = p?.limits;
    const ok =
      onlyKeys(p, ["proto", "relay", "roles", "limits"]) &&
      isInt(p.proto, 1, MAX_SAFE) &&
      isVersion(p.relay) &&
      Array.isArray(p.roles) &&
      p.roles.length >= 1 &&
      p.roles.every((r) => roles.includes(r)) &&
      new Set(p.roles).size === p.roles.length &&
      onlyKeys(limits, [
        "maxRosterBytes",
        "maxPushItemsPerFrame",
        "maxReleasePieceBytes",
        "maxRestartWithinMs",
      ]) &&
      isInt(limits.maxRosterBytes, 1, MAX_SAFE) &&
      isInt(limits.maxPushItemsPerFrame, 1, MAX_SAFE) &&
      isInt(limits.maxReleasePieceBytes, 1, MAX_SAFE) &&
      isInt(limits.maxRestartWithinMs, 0, MAX_SAFE);
    return ok ? null : "not a RelayWelcome";
  }
  return onlyKeys(p, []) ? null : "not a RelayJoin {}";
}

function checkXn(ctx) {
  const F = "relay-xn.json";
  const file = load(ctx, F, ["handshakes", "failures"]);
  for (const v of file.handshakes ?? []) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, [
        "name",
        "pattern",
        "link",
        "prologue",
        "initiator",
        "responder",
        "messages",
        "handshakeHash",
        "identity",
        "transport",
      ]);
      knownKeys(ctx, F, name, v.initiator, ["static", "ephemeral"]);
      knownKeys(ctx, F, name, v.responder, ["ephemeral"]);
      if (v.pattern !== XN) ctx.mismatch(F, name, `pattern ${v.pattern}`);
      const prologue = hexField(v, "prologue");
      ctx.count("relay: XN handshakes: prologue is the link's");
      if (linkOfPrologue(prologue) !== v.link || !["hub", "relay"].includes(v.link))
        ctx.mismatch(F, name, `prologue is not section 3's for link ${v.link}`);
      const s = keyPair(ctx, F, name, v.initiator?.static, "initiator static");
      const I = new XnSide({
        initiator: true,
        prologue,
        s,
        e: keyPair(ctx, F, name, v.initiator?.ephemeral, "initiator ephemeral"),
      });
      const R = new XnSide({
        initiator: false,
        prologue,
        e: keyPair(ctx, F, name, v.responder?.ephemeral, "responder ephemeral"),
      });
      if (!Array.isArray(v.messages) || v.messages.length !== 3)
        throw new ShapeError("not three messages");
      v.messages.forEach((m, i) => {
        knownKeys(ctx, F, name, m, ["from", "payload", "message"]);
        const fromI = i % 2 === 0;
        if (m.from !== (fromI ? "initiator" : "responder"))
          ctx.mismatch(F, name, `message ${i + 1} from ${m.from}`);
        const payload = hexField(m, "payload");
        const problem = payloadProblem(v.link, i, payload);
        ctx.count("relay: XN handshakes: payloads as section 3 gives them");
        if (problem) ctx.mismatch(F, name, `message ${i + 1}'s payload is ${problem}`);
        const written = (fromI ? I : R).write(payload);
        ctx.count("relay: XN handshakes: messages reproduced");
        if (!same(written, hexField(m, "message")))
          ctx.mismatch(F, name, `message ${i + 1} differs from mine`);
        const read = (fromI ? R : I).read(hexField(m, "message"));
        if (!same(read, payload))
          ctx.mismatch(F, name, `message ${i + 1} reads back to another payload`);
      });
      ctx.count("relay: XN handshakes: hash, the proved key and its identity");
      if (!same(I.h, hexField(v, "handshakeHash")) || !same(R.h, I.h))
        ctx.mismatch(F, name, "handshake hash differs from mine");
      if (!R.rs || !same(R.rs, s.public))
        ctx.mismatch(F, name, "the responder does not end holding the initiator's static key");
      if (v.identity !== identityOf(s.public))
        ctx.mismatch(F, name, "identity is not the static key's");
      const t = { initiator: I.split(), responder: R.split() };
      for (const m of v.transport ?? []) {
        knownKeys(ctx, F, name, m, ["from", "plaintext", "message"]);
        const other = m.from === "initiator" ? "responder" : "initiator";
        if (!t[m.from]) throw new ShapeError(`transport from ${m.from}`);
        const plain = hexField(m, "plaintext");
        ctx.count("relay: XN handshakes: transport messages reproduced");
        if (!same(t[m.from].send.encrypt(Buffer.alloc(0), plain), hexField(m, "message")))
          ctx.mismatch(F, name, "a transport message differs from mine");
        if (!same(t[other].recv.decrypt(Buffer.alloc(0), hexField(m, "message")), plain))
          ctx.mismatch(F, name, "a transport message reads back to another plaintext");
      }
    });
  }
  if (
    !(file.handshakes ?? []).some((v) => v?.link === "hub") ||
    !(file.handshakes ?? []).some((v) => v?.link === "relay")
  )
    ctx.mismatch(F, "(file)", "a handshake of each link is not there");

  const seenLowOrder = new Set();
  const seenExpect = new Set();
  for (const v of file.failures ?? []) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, [
        "name",
        "pattern",
        "side",
        "prologue",
        "staticKey",
        "ephemeral",
        "messages",
        "expect",
      ]);
      if (v.pattern !== XN) ctx.mismatch(F, name, `pattern ${v.pattern}`);
      const initiator = v.side === "initiator";
      if (!initiator && v.side !== "responder") throw new ShapeError(`side ${v.side}`);
      const prologue = hexField(v, "prologue");
      if (!linkOfPrologue(prologue)) ctx.mismatch(F, name, "prologue is not one of section 3's");
      if (initiator !== (v.staticKey !== undefined))
        ctx.mismatch(F, name, "a static key for the responder, or none for the initiator");
      const s = initiator ? keyPair(ctx, F, name, v.staticKey, "staticKey") : null;
      const e = keyPair(ctx, F, name, v.ephemeral, "ephemeral");
      if (!Array.isArray(v.messages) || v.messages.length === 0)
        throw new ShapeError("no messages");
      const messages = v.messages.map((m, i) => hexField(v.messages, i));
      const side = new XnSide({ initiator, prologue, s, e });
      zeroDhInputs = [];
      let failedAt = null;
      let code = null;
      let at = -1;
      const writes = () => {
        while (side.myTurn()) side.write(Buffer.alloc(0));
      };
      let t = null;
      try {
        writes();
        for (at = 0; at < messages.length; at++) {
          if (!side.complete) {
            side.read(messages[at]);
            writes();
          } else {
            t ??= side.split();
            if (messages[at].length > MAX_NOISE) throw new Refused("tooLong");
            t.recv.decrypt(Buffer.alloc(0), messages[at]);
          }
        }
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        failedAt = at;
        code = err.code;
      }
      ctx.count(`relay: XN refusals: ${String(v.expect)}`);
      seenExpect.add(v.expect);
      if (failedAt === null) ctx.mismatch(F, name, `my XN accepts it (vector: ${v.expect})`);
      else if (failedAt !== messages.length - 1)
        ctx.mismatch(
          F,
          name,
          `my XN refuses it ${failedAt < 0 ? "before" : `at message ${failedAt + 1}`}, not at the last (${code})`,
        );
      else if (code !== v.expect) ctx.mismatch(F, name, `my reason ${code}, vector ${v.expect}`);
      if (code === "allZeroDh") {
        const which = zeroDhInputs.map(lowOrderName);
        if (which.some((x) => x === undefined))
          ctx.mismatch(F, name, "an all-zero DH from a key not in the description's list");
        which.forEach((x) => seenLowOrder.add(x));
      }
    });
  }
  const missing = [...LOW_ORDER.keys()].filter((k) => !seenLowOrder.has(k));
  if (missing.length)
    ctx.mismatch(F, "(file)", `low-order keys never refused: ${missing.join(", ")}`);
  for (const expect of ["allZeroDh", "badMessage", "decryptFailed", "tooLong"])
    if (!seenExpect.has(expect)) ctx.mismatch(F, "(file)", `no failure with the reason ${expect}`);
}

function checkPush(ctx) {
  const F = "relay-push.json";
  const file = load(ctx, F, ["seal", "open"]);
  const sizes = new Set();
  for (const v of file.seal ?? []) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, [
        "name",
        "key",
        "keyId",
        "nonce",
        "content",
        "contentJson",
        "aad",
        "padded",
        "sealed",
        "h",
      ]);
      const key = hexField(v, "key", 32);
      const keyId = hexField(v, "keyId", 8);
      const nonce = hexField(v, "nonce", 12);
      const json = hexField(v, "contentJson");
      ctx.count("relay: sealed pushes: content is a PushContent, as its JSON");
      if (!isPushContent(v.content))
        ctx.mismatch(F, name, "content is not a PushContent of section 5");
      let parsed;
      try {
        parsed = JSON.parse(utf8.decode(json));
      } catch {
        parsed = undefined;
      }
      if (!jsonEqual(parsed, v.content)) ctx.mismatch(F, name, "contentJson is not content");
      if (json.length > 1279) ctx.mismatch(F, name, "contentJson is over 1,279 bytes");
      sizes.add(json.length);
      ctx.count("relay: sealed pushes: aad, padding, sealing and h");
      const aad = pushAad(keyId);
      if (!same(aad, hexField(v, "aad")))
        ctx.mismatch(F, name, "aad is not hsn-push/1, 0 and the key id");
      const padded = Buffer.concat([
        json,
        Buffer.from([0x80]),
        Buffer.alloc(Math.max(0, PADDED - json.length - 1)),
      ]);
      if (!same(padded, hexField(v, "padded", PADDED)))
        ctx.mismatch(F, name, "padded is not content, 0x80 and zeros");
      const sealed = Buffer.concat([nonce, seal(key, nonce, aad, padded)]);
      if (!same(sealed, hexField(v, "sealed"))) ctx.mismatch(F, name, "sealed differs from mine");
      const h = `1.${keyId.toString("hex")}.${sealed.toString("base64url")}`;
      if (h.length !== 1763) ctx.mismatch(F, name, `my h is ${h.length} characters`);
      if (v.h !== h) ctx.mismatch(F, name, "h differs from mine");
      ctx.count("relay: sealed pushes: h opens to content");
      let opened;
      try {
        opened = openH(v.h, new Map([[keyId.toString("hex"), key]]));
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        ctx.mismatch(F, name, `my opener refuses it (${e.code})`);
      }
      if (opened !== undefined && !jsonEqual(opened, v.content))
        ctx.mismatch(F, name, "h opens to other content");
    });
  }
  for (const size of [1279, 1278])
    if (!sizes.has(size))
      ctx.mismatch(F, "(file)", `no sealed push whose content is ${size} bytes`);
  const seen = new Set();
  for (const v of file.open ?? []) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, ["name", "key", "keyId", "h", "expect"]);
      const keys = new Map([[hexField(v, "keyId", 8).toString("hex"), hexField(v, "key", 32)]]);
      let code = null;
      try {
        openH(v.h, keys);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        code = e.code;
      }
      ctx.count(`relay: pushes refused: ${String(v.expect)}`);
      seen.add(v.expect);
      if (code === null) ctx.mismatch(F, name, `my opener accepts it (vector: ${v.expect})`);
      else if (code !== v.expect) ctx.mismatch(F, name, `my reason ${code}, vector ${v.expect}`);
    });
  }
  for (const expect of ["badFormat", "unknownKey", "decryptFailed", "badPadding", "badContent"])
    if (!seen.has(expect)) ctx.mismatch(F, "(file)", `no refused push with the reason ${expect}`);
}

/**
 * A compact value (the file's description): the value itself, or a non-empty array of pieces
 * joined in order, each the value's text or {repeat, times} (repeat non-empty, times 1 to 2^24).
 * For hex, every piece and every repeat is lower-case hex of whole bytes.
 */
function expand(value, isHex) {
  const unit = (t, nonEmpty) =>
    typeof t === "string" &&
    (!nonEmpty || t.length > 0) &&
    (!isHex || /^(?:[0-9a-f]{2})*$/.test(t));
  if (typeof value === "string") {
    if (!unit(value, false)) throw new ShapeError("a value that is not lower-case hex");
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) throw new ShapeError("not a value or pieces");
  let out = "";
  for (const piece of value) {
    if (typeof piece === "string" && unit(piece, false)) out += piece;
    else if (
      onlyKeys(piece, ["repeat", "times"]) &&
      unit(piece.repeat, true) &&
      isInt(piece.times, 1, 16777216)
    )
      out += piece.repeat.repeat(piece.times);
    else throw new ShapeError("a piece that is neither text nor {repeat, times}");
  }
  return out;
}
const expandHex = (value) => Buffer.from(expand(value, true), "hex");

function checkFrames(ctx) {
  const F = "relay-frames.json";
  const file = load(ctx, F, ["text", "binary", "closes"]);
  const seenDirections = new Set();
  const seenEdges = new Set();
  for (const v of file.text ?? []) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, ["name", "schema", "text", "accept"]);
      if (!Object.hasOwn(DIRECTIONS, v.schema)) throw new ShapeError(`schema ${v.schema}`);
      const text = expand(v.text, false);
      if (typeof v.accept !== "boolean") throw new ShapeError("accept");
      seenDirections.add(`${v.schema} ${v.accept}`);
      ctx.count(`relay: text frames ${v.accept ? "accepted" : "refused"}`);
      if (Buffer.byteLength(text, "utf8") === MAX_TEXT && v.accept)
        seenEdges.add("text at the limit");
      if (Buffer.byteLength(text, "utf8") === MAX_TEXT + 1 && !v.accept)
        seenEdges.add("text past it");
      if (acceptsText(v.schema, text) !== v.accept)
        ctx.mismatch(
          F,
          name,
          `I ${v.accept ? "refuse" : "accept"} it (vector: ${v.accept ? "accept" : "refuse"})`,
        );
    });
  }
  for (const d of Object.keys(DIRECTIONS))
    for (const a of [true, false])
      if (!seenDirections.has(`${d} ${a}`))
        ctx.mismatch(F, "(file)", `no ${d} frame that is ${a ? "accepted" : "refused"}`);
  const seen = new Set();
  for (const v of file.binary ?? []) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, ["name", "bytes", "frame", "expect"]);
      const bytes = expandHex(v.bytes);
      if ((v.frame === undefined) === (v.expect === undefined))
        throw new ShapeError("a frame or an error");
      let mine = null;
      let code = null;
      try {
        mine = decodeBinary(bytes);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        code = e.code;
      }
      if (v.frame !== undefined) {
        knownKeys(ctx, F, name, v.frame, ["kind", "stream", "id", "message", "bytes"]);
        ctx.count("relay: binary frames decoded and encoded");
        const frame =
          v.frame.kind === 1
            ? { kind: 1, stream: v.frame.stream, message: expand(v.frame.message, true) }
            : { kind: 2, id: v.frame.id, bytes: expand(v.frame.bytes, true) };
        if (mine === null) ctx.mismatch(F, name, `I refuse it (${code})`);
        else if (!jsonEqual(mine, frame)) ctx.mismatch(F, name, "it decodes to another frame");
        else if (bytes.length === (bytes[0] === 1 ? 65540 : 262149))
          seenEdges.add(`kind ${bytes[0]} at its largest`);
        if (!same(encodeBinary(frame), bytes))
          ctx.mismatch(F, name, "its frame encodes to other bytes");
      } else {
        ctx.count(`relay: binary frames refused: ${String(v.expect)}`);
        seen.add(v.expect);
        if (code === null) ctx.mismatch(F, name, `I accept it (vector: ${v.expect})`);
        else if (code !== v.expect) ctx.mismatch(F, name, `my reason ${code}, vector ${v.expect}`);
        if (code === "badLength" && bytes.length === (bytes[0] === 1 ? 65541 : 262150))
          seenEdges.add(`kind ${bytes[0]} one byte past it`);
      }
    });
  }
  for (const edge of [
    "text at the limit",
    "text past it",
    "kind 1 at its largest",
    "kind 1 one byte past it",
    "kind 2 at its largest",
    "kind 2 one byte past it",
  ])
    if (!seenEdges.has(edge)) ctx.mismatch(F, "(file)", `no frame for the edge: ${edge}`);
  for (const expect of ["truncated", "unknownKind", "badLength"])
    if (!seen.has(expect)) ctx.mismatch(F, "(file)", `no binary frame refused as ${expect}`);
  // Section 3's close codes of hub and relay links, and 4403 (the operator refused this key, D142);
  // what the closed side does next by section 4's back-off and the coordinator's ruling on 4403.
  const CLOSES = new Map([
    [1001, "backoff"],
    [4001, "wait"],
    [4400, "backoff"],
    [4403, "never"],
    [4408, "backoff"],
    [4426, "wait"],
    [4429, "wait"],
  ]);
  const listed = new Set();
  for (const c of file.closes ?? []) {
    const name = typeof c?.name === "string" ? c.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, c, ["name", "code", "reconnect"]);
      ctx.count("relay: link close codes and what follows them");
      if (listed.has(c.code)) ctx.mismatch(F, name, `code ${c.code} twice`);
      listed.add(c.code);
      if (!CLOSES.has(c.code)) ctx.mismatch(F, name, `code ${c.code} is not a link close code`);
      else if (CLOSES.get(c.code) !== c.reconnect)
        ctx.mismatch(F, name, `after ${c.code}: ${c.reconnect}, mine ${CLOSES.get(c.code)}`);
    });
  }
  for (const code of CLOSES.keys())
    if (!listed.has(code)) ctx.mismatch(F, "(file)", `close code ${code} is not listed`);
}

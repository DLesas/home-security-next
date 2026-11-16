// Independent check of the app channel's vectors, packages/protocol/vectors/app-*.json.
//
// Written from docs/m2-design.md (section 5, the app's channel; section 6, the messages; section
// 9, "Backup, export and restore"; section 10), vectors/README.md, the vector files' own
// descriptions and the Noise Protocol Framework (revision 34), without reading packages/protocol/src
// or the hub. The cryptography is Node's own: X25519, ChaCha20-Poly1305, SHA-256, HMAC and HKDF
// from node:crypto. The Noise state machine below (CipherState, SymmetricState, HandshakeState for
// IK and XXpsk3) is this file's own, checked first against the published Noise vectors kept in
// vectors/noise-published (third-party data, not the library).
//
// Called by verify-vectors.mjs with its `mismatch`, `count` and `note`. Every disagreement is a
// mismatch, never an exception. Messages name fields and cases only, never key or secret bytes.

import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

/** The app vector files this script checks; any other `app-*.json` is reported by the caller. */
export const APP_FILES = [
  "app-link-secrets.json",
  "app-typed-code.json",
  "app-noise.json",
  "app-noise-failures.json",
  "app-backup.json",
];

const IK = "Noise_IK_25519_ChaChaPoly_SHA256";
const XX = "Noise_XXpsk3_25519_ChaChaPoly_SHA256";
const ascii = (s) => Buffer.from(s, "ascii");
const zero = Buffer.from([0]);
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hmac = (key, ...parts) => createHmac("sha256", key).update(Buffer.concat(parts)).digest();

class ShapeError extends Error {}
class NoiseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** A lower-case hex field of a case, as bytes (`len` bytes when given). */
function hexField(obj, key, len) {
  const v = obj?.[key];
  if (typeof v !== "string" || !/^(?:[0-9a-f]{2})*$/.test(v))
    throw new ShapeError(`"${key}" is not lower-case hex`);
  const b = Buffer.from(v, "hex");
  if (len !== undefined && b.length !== len)
    throw new ShapeError(`"${key}" is ${b.length} bytes, not ${len}`);
  return b;
}
const b64url = (b) => Buffer.from(b).toString("base64url");
function fromB64url(s, len) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.length === len && b64url(b) === s ? b : null;
}

// RFC 4648 base32, lower case, no padding: the hub's app identity (section 5).
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
const identityBytes = (hubPublic) => sha256(hubPublic).subarray(0, 16);
const identityText = (hubPublic) => base32(identityBytes(hubPublic));

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

/** Low-order u-coordinates (the failure file's list): each X25519 with them is all zero. */
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

/** The public keys whose Diffie-Hellman came out all zero, for the failure cases to inspect. */
let zeroDhInputs = [];
function dh(priv, pub) {
  let out;
  try {
    out = diffieHellman({ privateKey: privateKey(priv), publicKey: publicKey(pub) });
  } catch (e) {
    // OpenSSL's X25519 fails the derivation exactly when the shared secret is all zero (RFC 7748
    // section 6.1's check); the keys are always 32 bytes here, so nothing else can fail it.
    if (e?.code !== "ERR_OSSL_FAILED_DURING_DERIVATION") throw e;
    out = Buffer.alloc(32);
  }
  if (out.every((b) => b === 0)) {
    zeroDhInputs.push(Buffer.from(pub));
    throw new NoiseError("allZeroDh");
  }
  return out;
}

function seal(key, nonce, ad, plain) {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  c.setAAD(ad, { plaintextLength: plain.length });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
/** Opens `sealed` (ciphertext then 16-byte tag); null when the tag does not verify. */
function open(key, nonce, ad, sealed) {
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
// Noise (revision 34): 25519, ChaChaPoly, SHA256; patterns IK and XXpsk3
// ---------------------------------------------------------------------------

const MAX_NOISE = 65535;
/** Noise's HKDF (section 4.3): HMAC-SHA256 with the chaining key, 2 or 3 outputs. */
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
  hasKey() {
    return this.k !== null;
  }
  nonce() {
    if (this.n >= 0xffffffffffffffffn) throw new NoiseError("nonceExhausted");
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(this.n, 4); // 32 bits of zeros, then n little-endian (section 5.1)
    return nonce;
  }
  encryptWithAd(ad, plain) {
    if (!this.k) return Buffer.from(plain);
    const out = seal(this.k, this.nonce(), ad, plain);
    this.n++;
    return out;
  }
  decryptWithAd(ad, sealed) {
    if (!this.k) return Buffer.from(sealed);
    if (sealed.length < 16) throw new NoiseError("badMessage");
    const out = open(this.k, this.nonce(), ad, sealed);
    if (!out) throw new NoiseError("decryptFailed");
    this.n++;
    return out;
  }
}

class SymmetricState {
  constructor(protocolName) {
    const name = ascii(protocolName);
    this.h =
      name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name);
    this.ck = this.h;
    this.cs = new CipherState();
  }
  mixKey(ikm) {
    const [ck, k] = noiseHkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cs = new CipherState(k);
  }
  mixHash(data) {
    this.h = sha256(this.h, data);
  }
  mixKeyAndHash(ikm) {
    const [ck, h, k] = noiseHkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(h);
    this.cs = new CipherState(k);
  }
  encryptAndHash(plain) {
    const ct = this.cs.encryptWithAd(this.h, plain);
    this.mixHash(ct);
    return ct;
  }
  decryptAndHash(ct) {
    const plain = this.cs.decryptWithAd(this.h, ct);
    this.mixHash(ct);
    return plain;
  }
  split() {
    const [k1, k2] = noiseHkdf(this.ck, Buffer.alloc(0), 2);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

const PATTERNS = {
  [IK]: {
    preResponderS: true,
    psk: false,
    messages: [
      ["e", "es", "s", "ss"],
      ["e", "ee", "se"],
    ],
  },
  [XX]: {
    preResponderS: false,
    psk: true,
    messages: [["e"], ["e", "ee", "s", "es"], ["s", "se", "psk"]],
  },
};

/**
 * One side of a handshake. `s` and `e` are {private, public}; `e` is the fixed ephemeral. `rs` is
 * the responder's static public key for an IK initiator; `psk` 32 bytes, or set later by setPsk.
 * After any failure every call is refused.
 */
class Handshake {
  constructor({ pattern, initiator, prologue, s, e, rs = null, psk = null }) {
    this.p = PATTERNS[pattern];
    if (!this.p) throw new ShapeError(`pattern ${pattern} the script does not know`);
    Object.assign(this, { initiator, s, e, rs, psk, re: null, i: 0, failed: false });
    this.sym = new SymmetricState(pattern);
    this.sym.mixHash(prologue);
    if (this.p.preResponderS) this.sym.mixHash(initiator ? rs : s.public);
  }
  get complete() {
    return this.i >= this.p.messages.length;
  }
  myTurn() {
    return !this.complete && (this.i % 2 === 0) === this.initiator;
  }
  setPsk(psk) {
    this.psk = psk;
  }
  guarded(fn) {
    if (this.failed) throw new NoiseError("refused");
    try {
      return fn();
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
  dhToken(t) {
    const mine = {
      ee: "e",
      es: this.initiator ? "e" : "s",
      se: this.initiator ? "s" : "e",
      ss: "s",
    };
    const theirs = { ee: "re", es: this.initiator ? "rs" : "re", se: this.initiator ? "re" : "rs" };
    this.sym.mixKey(dh(this[mine[t]].private, this[theirs[t] ?? "rs"]));
  }
  token(t, write, msg, out) {
    if (t === "e") {
      const pub = write ? this.e.public : msg.take(32);
      if (write) out.push(pub);
      else this.re = pub;
      this.sym.mixHash(pub);
      if (this.p.psk) this.sym.mixKey(pub);
    } else if (t === "s") {
      if (write) out.push(this.sym.encryptAndHash(this.s.public));
      else this.rs = this.sym.decryptAndHash(msg.take(this.sym.cs.hasKey() ? 48 : 32));
    } else if (t === "psk") {
      if (!this.psk) throw new NoiseError("noPsk");
      this.sym.mixKeyAndHash(this.psk);
    } else this.dhToken(t);
  }
  /** The fewest bytes the next message can have, from its tokens (section 7). */
  shortest() {
    let hasKey = this.sym.cs.hasKey();
    let n = 0;
    for (const t of this.p.messages[this.i]) {
      if (t === "e") {
        n += 32;
        if (this.p.psk) hasKey = true;
      } else if (t === "s") n += hasKey ? 48 : 32;
      else hasKey = true;
    }
    return n + (hasKey ? 16 : 0);
  }
  write(payload) {
    return this.guarded(() => {
      if (!this.myTurn()) throw new NoiseError("notMyTurn");
      const out = [];
      for (const t of this.p.messages[this.i]) this.token(t, true, null, out);
      out.push(this.sym.encryptAndHash(payload));
      this.i++;
      const msg = Buffer.concat(out);
      if (msg.length > MAX_NOISE) throw new NoiseError("tooLong");
      return msg;
    });
  }
  read(message) {
    return this.guarded(() => {
      if (this.complete || this.myTurn()) throw new NoiseError("notMyTurn");
      if (message.length > MAX_NOISE) throw new NoiseError("tooLong");
      if (message.length < this.shortest()) throw new NoiseError("badMessage");
      let at = 0;
      const msg = { take: (n) => message.subarray(at, (at += n)) };
      for (const t of this.p.messages[this.i]) this.token(t, false, msg, null);
      const payload = this.sym.decryptAndHash(message.subarray(at));
      this.i++;
      return payload;
    });
  }
  /** After the last message: { send, recv } CipherStates, each direction its own nonce. */
  split() {
    const [c1, c2] = this.sym.split();
    return this.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}

function transportWrite(cs, plain) {
  const out = cs.encryptWithAd(Buffer.alloc(0), plain);
  if (out.length > MAX_NOISE) throw new NoiseError("tooLong");
  return out;
}
function transportRead(cs, message) {
  if (message.length > MAX_NOISE) throw new NoiseError("tooLong");
  if (message.length < 16) throw new NoiseError("badMessage");
  return cs.decryptWithAd(Buffer.alloc(0), message);
}

// ---------------------------------------------------------------------------
// Typed codes: Crockford base32 with its mod-37 check symbol (section 5)
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_SYMBOLS = `${CROCKFORD}*~$=U`;
const SECRET_BITS = 35n;

function typedCode(tokenId, secret5) {
  const value = (BigInt(tokenId) << SECRET_BITS) | BigInt(`0x${secret5.toString("hex")}`);
  let chars = "";
  for (let i = 10n; i >= 0n; i--) chars += CROCKFORD[Number((value >> (5n * i)) & 31n)];
  chars += CHECK_SYMBOLS[Number(value % 37n)];
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}
/** What a person typed, read as {tokenId, secret}; null when refused. */
function readTypedCode(text) {
  const t = text.replace(/[ -]/g, "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  if (t.length !== 12) return null;
  let value = 0n;
  for (const ch of t.slice(0, 11)) {
    const d = CROCKFORD.indexOf(ch);
    if (d < 0) return null;
    value = value * 32n + BigInt(d);
  }
  if (CHECK_SYMBOLS[Number(value % 37n)] !== t[11]) return null;
  const secret = Buffer.from(
    (value & ((1n << SECRET_BITS) - 1n)).toString(16).padStart(10, "0"),
    "hex",
  );
  return { tokenId: Number(value >> SECRET_BITS), secret };
}

const linkPsk = (secret) => sha256(ascii("hsn-link/1"), zero, secret);
const lookup128 = (secret) =>
  sha256(ascii("hsn-find/1"), zero, secret).subarray(0, 4).toString("hex");

// ---------------------------------------------------------------------------
// Backup files (section 9)
// ---------------------------------------------------------------------------

const HEADER = 64;
const CHUNK = 65536;
const SEALED_CHUNK = CHUNK + 16;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

class BackupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const backupKey = (key, header) =>
  Buffer.from(hkdfSync("sha256", key, header.subarray(38, 46), ascii("hsn-backup/1"), 32));
function chunkNonce(i) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(i), 4);
  return n;
}
const chunkAd = (header, last) => Buffer.concat([header, Buffer.from([last ? 1 : 0])]);

/** Header checks; my order: length, magic, format, flags, reserved bytes, the two times. */
function checkHeader(file) {
  if (file.length < HEADER) throw new BackupError("truncated");
  const h = file.subarray(0, HEADER);
  if (!same(h.subarray(0, 4), ascii("HSNB"))) throw new BackupError("badMagic");
  if (h[4] !== 1 || h[5] !== 0 || h.subarray(54).some((b) => b !== 0))
    throw new BackupError("badFormat");
  if (h.readBigUInt64LE(26) > MAX_SAFE || h.readBigUInt64LE(46) > MAX_SAFE)
    throw new BackupError("badFormat");
  return h;
}
function sealBackup(key, header, database) {
  const k = backupKey(key, header);
  const n = Math.max(1, Math.ceil(database.length / CHUNK));
  const out = [header];
  for (let i = 0; i < n; i++)
    out.push(
      seal(
        k,
        chunkNonce(i),
        chunkAd(header, i === n - 1),
        database.subarray(i * CHUNK, (i + 1) * CHUNK),
      ),
    );
  return Buffer.concat(out);
}
/** Opens a whole file, chunk by chunk in file order, as a streaming opener meets them. */
function openBackup(key, file) {
  const header = checkHeader(file);
  const k = backupKey(key, header);
  const body = file.subarray(HEADER);
  const rest = body.length % SEALED_CHUNK;
  const full = Math.floor(body.length / SEALED_CHUNK);
  const pieces = [];
  for (let i = 0; i < full; i++)
    pieces.push(body.subarray(i * SEALED_CHUNK, (i + 1) * SEALED_CHUNK));
  const tail = rest === 0 ? null : body.subarray(full * SEALED_CHUNK);
  // Fewer bytes than a tag at the end: every whole chunk before them is not the last.
  const shortTail = tail !== null && tail.length < 16;
  const lastIndex = shortTail ? -1 : tail !== null ? full : full - 1;
  const plain = [];
  pieces.forEach((piece, i) => {
    if (i === lastIndex) return;
    const p = open(k, chunkNonce(i), chunkAd(header, false), piece);
    if (!p) throw new BackupError("decryptFailed");
    plain.push(p);
  });
  if (lastIndex < 0) throw new BackupError("truncated");
  const last = lastIndex === full ? tail : pieces[lastIndex];
  const p = open(k, chunkNonce(lastIndex), chunkAd(header, true), last);
  if (!p) {
    const asMiddle =
      last.length === SEALED_CHUNK && open(k, chunkNonce(lastIndex), chunkAd(header, false), last);
    throw new BackupError(asMiddle ? "cut" : "decryptFailed");
  }
  plain.push(p);
  return Buffer.concat(plain);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export function verifyAppVectors(vectorsDir, { mismatch, count, note }) {
  const ctx = { mismatch, count, note, dir: vectorsDir };
  selfCheckNoise(ctx);
  const secrets = checkLinkSecrets(ctx);
  const codes = checkTypedCodes(ctx);
  checkNoise(ctx, secrets, codes);
  checkNoiseFailures(ctx);
  checkBackup(ctx);
  return new Set(APP_FILES);
}

function loadApp({ mismatch, dir }, name, sections = ["description", "vectors"]) {
  let file;
  try {
    file = JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch (e) {
    mismatch(name, "(file)", `cannot be read: ${e.message}`);
    return [];
  }
  if (file === null || typeof file !== "object" || Array.isArray(file)) {
    mismatch(name, "(file)", "is not a JSON object");
    return [];
  }
  for (const k of Object.keys(file))
    if (!sections.includes(k)) mismatch(name, "(file)", `section "${k}" the script does not know`);
  if (typeof file.description !== "string") mismatch(name, "(file)", "no description");
  if (!Array.isArray(file.vectors)) {
    mismatch(name, "(file)", `"vectors" is not an array`);
    return [];
  }
  return file.vectors;
}
function guardCase({ mismatch }, file, name, fn) {
  try {
    fn();
  } catch (e) {
    const why = e instanceof ShapeError ? e.message : `${e?.constructor?.name}: ${e?.message}`;
    mismatch(file, name, `the script cannot process this case (${why})`);
  }
}
function knownKeys({ mismatch }, file, name, obj, keys) {
  for (const k of Object.keys(obj ?? {}))
    if (!keys.includes(k)) mismatch(file, name, `field "${k}" the script does not know`);
}
function keyPair(ctx, file, name, obj, label) {
  const pair = { private: hexField(obj, "private", 32), public: hexField(obj, "public", 32) };
  ctx.count("app: X25519 public keys from their private keys");
  if (!same(publicOf(pair.private), pair.public))
    ctx.mismatch(file, name, `${label}: public key is not the private key's`);
  return pair;
}

// Mine to compare against the published Noise vectors: shows this file's Noise is Noise.
function selfCheckNoise(ctx) {
  const F = "noise-published";
  for (const src of ["cacophony.txt", "snow.txt"]) {
    let vectors;
    try {
      vectors = JSON.parse(readFileSync(join(ctx.dir, F, src), "utf8")).vectors;
      if (!Array.isArray(vectors)) throw new ShapeError("no vectors");
    } catch {
      ctx.note(`${F}/${src} not found: this script's Noise was not checked against it`);
      continue;
    }
    for (const v of vectors.filter((x) => x.protocol_name === IK || x.protocol_name === XX))
      guardCase(ctx, `${F}/${src}`, v.protocol_name, () => {
        ctx.count("app: published Noise vectors this script's Noise reproduces");
        const k = (s) => ({ private: hexField(v, s, 32), public: publicOf(hexField(v, s, 32)) });
        const psk = v.init_psks?.length ? hexField(v.init_psks, 0, 32) : null;
        const rpsk = v.resp_psks?.length ? hexField(v.resp_psks, 0, 32) : null;
        const base = { pattern: v.protocol_name };
        const I = new Handshake({
          ...base,
          initiator: true,
          prologue: hexField(v, "init_prologue"),
          s: k("init_static"),
          e: k("init_ephemeral"),
          rs: v.init_remote_static ? hexField(v, "init_remote_static", 32) : null,
          psk,
        });
        const R = new Handshake({
          ...base,
          initiator: false,
          prologue: hexField(v, "resp_prologue"),
          s: k("resp_static"),
          e: k("resp_ephemeral"),
          psk: rpsk,
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
            ct = transportWrite(fromI ? t.I.send : t.R.send, payload);
            back = transportRead(fromI ? t.R.recv : t.I.recv, ct);
          }
          if (!same(ct, hexField(m, "ciphertext")) || !same(back, payload))
            ctx.mismatch(
              `${F}/${src}`,
              v.protocol_name,
              `message ${i}: this script's Noise differs`,
            );
        });
        if (v.handshake_hash && !same(I.sym.h, hexField(v, "handshake_hash")))
          ctx.mismatch(
            `${F}/${src}`,
            v.protocol_name,
            "handshake hash: this script's Noise differs",
          );
      });
  }
}

// The vector file's description fixes these: addresses, port, and a fixed certificate fingerprint.
const QR_ADDRESSES = "192.168.1.20,fd00::20";
const QR_PORT = 8444;
const LINK_ADDRESS_HOST = "192.168.1.20";

function checkLinkSecrets(ctx) {
  const F = "app-link-secrets.json";
  const out = [];
  const fingerprints = new Set();
  loadApp(ctx, F).forEach((v, i) => {
    const name = `vector ${i} (lookup ${String(v?.lookup)})`;
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, [
        "secret",
        "lookup",
        "psk",
        "hubStaticPublic",
        "identity",
        "qr",
        "linkAddress",
      ]);
      const secret = hexField(v, "secret", 16);
      const hub = hexField(v, "hubStaticPublic", 32);
      const psk = hexField(v, "psk", 32);
      const check = (what, ok) => {
        ctx.count(`app: link secrets: ${what}`);
        if (!ok) ctx.mismatch(F, name, `${what} is not the one section 5 derives`);
      };
      check("lookup", v.lookup === lookup128(secret));
      check("psk", same(psk, linkPsk(secret)));
      check("identity", v.identity === identityText(hub));
      const restore = typeof v.qr === "string" && v.qr.startsWith("hsn://restore/1?");
      const c = /&c=([A-Za-z0-9_-]+)$/.exec(String(v.qr))?.[1] ?? "";
      ctx.count("app: link secrets: certificate fingerprint form");
      if (!fromB64url(c, 32))
        ctx.mismatch(F, name, "qr: c is not 43 base64url characters (32 bytes)");
      fingerprints.add(c);
      const qr = `hsn://${restore ? "restore" : "link"}/1?h=${identityText(hub)}&s=${b64url(secret)}&a=${QR_ADDRESSES}&p=${QR_PORT}&c=${c}`;
      check("qr", v.qr === qr);
      check(
        "linkAddress",
        v.linkAddress ===
          `https://${LINK_ADDRESS_HOST}:${QR_PORT}/#link=${identityText(hub)}.${b64url(secret)}`,
      );
      out.push({ psk, lookup: v.lookup, hub, restore });
    });
  });
  if (fingerprints.size > 1) ctx.mismatch(F, "(file)", "the QR codes carry different fingerprints");
  ctx.note(
    `${F}: SPEC-QUESTION the certificate fingerprint in each qr (c=) is "fixed" by the file; it is ` +
      "checked only for its form (43 base64url characters, 32 bytes) and for being one value",
  );
  return out;
}

function checkTypedCodes(ctx) {
  const F = "app-typed-code.json";
  const out = [];
  loadApp(ctx, F).forEach((v, i) => {
    const name = `vector ${i} (token id ${String(v?.tokenId)})`;
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, ["code", "tokenId", "secret", "lookup", "psk", "typed"]);
      const secret = hexField(v, "secret", 5);
      const psk = hexField(v, "psk", 32);
      if (!Number.isInteger(v.tokenId) || v.tokenId < 0 || v.tokenId >= 2 ** 20)
        throw new ShapeError("tokenId is not a 20-bit integer");
      ctx.count("app: typed codes: secret within 35 bits");
      if (secret[0] >> 3 !== 0) ctx.mismatch(F, name, "secret has its top 5 bits set");
      const code = typedCode(v.tokenId, secret);
      ctx.count("app: typed codes: characters and check character");
      if (v.code !== code) {
        const what =
          v.code?.slice(0, 13) === code.slice(0, 13) ? "check character is" : "characters are";
        ctx.mismatch(F, name, `code: its ${what} not what the token id and secret give`);
      }
      ctx.count("app: typed codes: lookup (the token id's characters)");
      if (v.lookup !== code.slice(0, 4))
        ctx.mismatch(F, name, "lookup is not the token id's 4 characters");
      ctx.count("app: typed codes: psk");
      if (!same(psk, linkPsk(secret)))
        ctx.mismatch(F, name, "psk is not the one section 5 derives");
      if (!Array.isArray(v.typed)) throw new ShapeError(`"typed" is not an array`);
      v.typed.forEach((t, j) => {
        knownKeys(ctx, F, name, t, ["text", "valid"]);
        if (typeof t?.text !== "string" || typeof t.valid !== "boolean")
          throw new ShapeError(`typed ${j} has no text or valid`);
        ctx.count("app: typed codes: what a person types, read or refused");
        const read = readTypedCode(t.text);
        if (t.valid && (!read || read.tokenId !== v.tokenId || !same(read.secret, secret)))
          ctx.mismatch(
            F,
            name,
            `typed ${j}: valid, but mine ${read ? "reads another code" : "refuses it"}`,
          );
        if (!t.valid && read)
          ctx.mismatch(F, name, `typed ${j}: must be refused, but mine reads it`);
      });
      out.push({ psk, lookup: v.lookup });
    });
  });
  ctx.note(
    `${F}: what a typed code forgives (case, spaces, dashes, I and L for 1, O for 0) is taken from the ` +
      "file's description and Crockford's definition; section 5 names only the code's form",
  );
  return out;
}

const PROLOGUES = {
  link: Buffer.concat([ascii("hsn-link/1"), zero]),
  restore: Buffer.concat([ascii("hsn-restore/1"), zero]),
};
const sessionPrologue = (hubPublic) =>
  Buffer.concat([ascii("hsn-session/1"), zero, identityBytes(hubPublic)]);

// Payload fields by section 5's tables: [required, optional]. A missing field is a mismatch; a
// field the tables do not name is only a note, since the schemas themselves live in src.
const SHAPES = {
  ClientHello: [["proto", "app"], ["first"]],
  HubHello: [["proto", "hub", "boot", "rev", "client", "features"], []],
  LinkHello: [["proto", "find"], []],
  LinkMessage2: [["hub", "proto", "askName"], []],
  RestoreMessage2: [["hub", "proto"], []],
  LinkRequest: [["name", "kind"], ["person"]],
  LinkResult: [["client", "person"], ["backupKey"]],
  RestoreHello: [["app"], []],
  RestoreOffer: [["identity", "epoch", "madeMs", "lastChangeMs"], []],
  RestoreKey: [["key", "epoch"], []],
  RestoreResult: [["ok"], ["reason"]],
  req: [["t", "id", "op", "body"], ["seq"]],
  res: [
    ["t", "id", "ok"],
    ["body", "error", "repeat"],
  ],
  evt: [["t", "rev", "ev", "body"], []],
};
function expectedShapes(purpose, messages, transport) {
  const hs = {
    session: ["ClientHello", "HubHello"],
    link: ["LinkHello", "LinkMessage2", "LinkRequest"],
    restore: ["LinkHello", "RestoreMessage2", "RestoreHello"],
  }[purpose];
  const tr =
    purpose === "session"
      ? transport.map((t) => (t.from === "initiator" ? "req" : null))
      : purpose === "link"
        ? ["LinkResult"]
        : ["RestoreOffer", "RestoreKey", "RestoreResult"];
  return { hs: messages.map((_, i) => hs?.[i]), tr };
}
function checkShape(ctx, F, name, where, bytes, shape, extras) {
  let obj;
  ctx.count("app: payloads: UTF-8 JSON with section 5's fields");
  try {
    obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    ctx.mismatch(F, name, `${where}: payload is not UTF-8 JSON`);
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    ctx.mismatch(F, name, `${where}: payload is not a JSON object`);
    return null;
  }
  const kind = shape ?? obj.t;
  const fields = SHAPES[kind];
  if (!fields) {
    ctx.mismatch(F, name, `${where}: no message of section 5 has this shape`);
    return obj;
  }
  for (const k of fields[0])
    if (!(k in obj)) ctx.mismatch(F, name, `${where}: ${kind} has no ${k}`);
  for (const k of Object.keys(obj))
    if (!fields[0].includes(k) && !fields[1].includes(k)) extras.add(`${kind}.${k}`);
  return obj;
}

function checkNoise(ctx, secrets, codes) {
  const F = "app-noise.json";
  const extras = new Set();
  for (const v of loadApp(ctx, F)) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, [
        "name",
        "pattern",
        "purpose",
        "carrier",
        "prologue",
        "psk",
        "initiator",
        "responder",
        "messages",
        "handshakeHash",
        "transport",
      ]);
      const pattern = v.pattern;
      const xx = pattern === XX;
      if (
        !(pattern === IK && v.purpose === "session") &&
        !(xx && (v.purpose === "link" || v.purpose === "restore"))
      )
        ctx.mismatch(
          F,
          name,
          `pattern ${pattern} for purpose ${v.purpose}: section 5 gives another`,
        );
      const iS = keyPair(ctx, F, name, v.initiator?.static, "initiator static");
      const iE = keyPair(ctx, F, name, v.initiator?.ephemeral, "initiator ephemeral");
      const rS = keyPair(ctx, F, name, v.responder?.static, "responder static");
      const rE = keyPair(ctx, F, name, v.responder?.ephemeral, "responder ephemeral");
      const prologue = hexField(v, "prologue");
      ctx.count("app: prologues");
      const myPrologue =
        v.purpose === "session" ? sessionPrologue(rS.public) : PROLOGUES[v.purpose];
      if (!myPrologue || !same(prologue, myPrologue))
        ctx.mismatch(F, name, `prologue is not section 5's for purpose ${v.purpose}`);

      // Where the pre-shared key comes from: an entry of the secrets files, by carrier.
      let psk = null;
      let token = null;
      if (xx) {
        psk = hexField(v, "psk", 32);
        const pool = v.carrier === "typedCode" ? codes : secrets;
        token = pool.find((t) => same(t.psk, psk)) ?? null;
        ctx.count("app: link and restore psk from a secrets file entry");
        if (!["qr", "linkAddress", "typedCode"].includes(v.carrier))
          ctx.mismatch(F, name, `carrier ${v.carrier} the script does not know`);
        else if (!token)
          ctx.mismatch(F, name, `psk is not that of any entry of the ${v.carrier} secrets file`);
        else if (v.carrier !== "typedCode") {
          if (token.restore !== (v.purpose === "restore"))
            ctx.mismatch(F, name, `psk is that of a ${token.restore ? "restore" : "link"} token`);
          if (!same(token.hub, rS.public))
            ctx.mismatch(F, name, "the hub's static key is not the one the token's code names");
        }
        if (v.purpose === "restore" && v.carrier !== "qr")
          ctx.mismatch(F, name, "a restore token is only ever a QR code (section 5)");
      } else if (v.psk !== undefined || v.carrier !== undefined)
        ctx.mismatch(F, name, "a session vector with a psk or carrier");

      const I = new Handshake({
        pattern,
        initiator: true,
        prologue,
        s: iS,
        e: iE,
        rs: xx ? null : rS.public,
        psk,
      });
      const R = new Handshake({ pattern, initiator: false, prologue, s: rS, e: rE });
      if (!Array.isArray(v.messages) || !Array.isArray(v.transport))
        throw new ShapeError("messages or transport is not an array");
      const shapes = expectedShapes(v.purpose, v.messages, v.transport);
      const step = (where, fn) => {
        try {
          fn();
        } catch (e) {
          if (!(e instanceof NoiseError)) throw e;
          ctx.mismatch(F, name, `${where}: my implementation refuses it (${e.code})`);
        }
      };
      let clientHello = null;
      v.messages.forEach((m, i) => {
        knownKeys(ctx, F, name, m, ["from", "payload", "message"]);
        const from = i % 2 === 0 ? "initiator" : "responder";
        if (m.from !== from)
          ctx.mismatch(F, name, `message ${i + 1} is from ${m.from}; the pattern gives ${from}`);
        const [w, r] = from === "initiator" ? [I, R] : [R, I];
        const payload = hexField(m, "payload");
        const message = hexField(m, "message");
        step(`message ${i + 1} written`, () => {
          ctx.count("app: handshake messages written exactly");
          if (!same(w.write(payload), message))
            ctx.mismatch(F, name, `message ${i + 1}: written bytes differ from "message"`);
        });
        step(`message ${i + 1} read`, () => {
          ctx.count("app: handshake messages read back to their payload");
          if (!same(r.read(message), payload))
            ctx.mismatch(F, name, `message ${i + 1}: read payload differs from "payload"`);
        });
        if (xx && i === 0) R.setPsk(psk);
        const obj = checkShape(ctx, F, name, `message ${i + 1}`, payload, shapes.hs[i], extras);
        if (i === 0) clientHello = obj;
        if (i === 0 && xx && token && obj?.find !== token.lookup)
          ctx.mismatch(F, name, "LinkHello's find is not the token's lookup");
        if (i === 1 && clientHello && Array.isArray(clientHello.proto)) {
          const [min, max] = clientHello.proto;
          if (!(obj?.proto >= min && obj?.proto <= max))
            ctx.mismatch(F, name, "the hub's proto is not in the client's range");
        }
      });
      const steps = PATTERNS[pattern]?.messages.length;
      if (v.messages.length !== steps)
        ctx.mismatch(F, name, `${v.messages.length} handshake messages; the pattern has ${steps}`);
      const hash = hexField(v, "handshakeHash", 32);
      ctx.count("app: handshake hashes, both sides");
      if (!same(I.sym.h, hash) || !same(R.sym.h, hash))
        ctx.mismatch(
          F,
          name,
          `handshakeHash differs from mine (${same(I.sym.h, R.sym.h) ? "both sides agree" : "the sides disagree"})`,
        );
      if (!I.complete || !R.complete) return;
      const ti = I.split();
      const tr = R.split();
      let lastBackupKey = null;
      v.transport.forEach((t, j) => {
        knownKeys(ctx, F, name, t, ["from", "plaintext", "message"]);
        const plain = hexField(t, "plaintext");
        const message = hexField(t, "message");
        const [send, recv] =
          t.from === "initiator"
            ? [ti.send, tr.recv]
            : t.from === "responder"
              ? [tr.send, ti.recv]
              : [];
        if (!send) throw new ShapeError(`transport ${j} from "${t.from}"`);
        step(`transport ${j}`, () => {
          ctx.count("app: transport messages encrypted exactly and decrypted back");
          if (!same(transportWrite(send, plain), message))
            ctx.mismatch(F, name, `transport ${j}: encrypted bytes differ from "message"`);
          const n = recv.n;
          try {
            if (!same(transportRead(recv, message), plain))
              ctx.mismatch(F, name, `transport ${j}: decrypted bytes differ from "plaintext"`);
          } finally {
            recv.n = n + 1n; // keep this direction's nonce in step, so one bad message is one mismatch
          }
        });
        const shape = shapes.tr[j] ?? undefined;
        const obj = checkShape(ctx, F, name, `transport ${j}`, plain, shape, extras);
        if (v.purpose === "restore" && j === 0 && !/^[a-z2-7]{26}$/.test(String(obj?.identity)))
          ctx.mismatch(F, name, "RestoreOffer's identity is not 26 base32 characters");
        const key = obj?.key ?? obj?.backupKey?.key;
        if (key !== undefined) {
          ctx.count("app: backup keys carried: 32 bytes, base64url");
          if (!fromB64url(key, 32))
            ctx.mismatch(F, name, `transport ${j}: the backup key is not 32 bytes of base64url`);
          lastBackupKey = key;
        }
      });
      if (v.purpose === "restore" && lastBackupKey === null)
        ctx.mismatch(F, name, "the phone never sends the backup key");
    });
  }
  if (extras.size)
    ctx.note(
      `${F}: SPEC-QUESTION payload fields section 5's tables do not name: ${[...extras].sort().join(", ")}`,
    );
  ctx.note(
    `${F}: payloads are checked only against section 5's tables (fields present, JSON, UTF-8); the ` +
      "schemas themselves (handshake.ts, envelope.ts) are src and not read here",
  );
}

function checkNoiseFailures(ctx) {
  const F = "app-noise-failures.json";
  const seenLowOrder = new Set();
  for (const v of loadApp(ctx, F)) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, [
        "name",
        "pattern",
        "side",
        "prologue",
        "psk",
        "staticKey",
        "ephemeral",
        "remoteStatic",
        "messages",
        "expect",
      ]);
      const xx = v.pattern === XX;
      const initiator = v.side === "initiator";
      if (!initiator && v.side !== "responder") throw new ShapeError(`side ${v.side}`);
      const s = keyPair(ctx, F, name, v.staticKey, "staticKey");
      const e = keyPair(ctx, F, name, v.ephemeral, "ephemeral");
      const prologue = hexField(v, "prologue");
      const remote = v.remoteStatic === undefined ? null : hexField(v, "remoteStatic", 32);
      const psk = v.psk === undefined ? null : hexField(v, "psk", 32);
      ctx.count("app: refusals: prologue is one of section 5's");
      const hubPublic = initiator ? remote : s.public;
      const ok = xx
        ? same(prologue, PROLOGUES.link) || same(prologue, PROLOGUES.restore)
        : hubPublic && same(prologue, sessionPrologue(hubPublic));
      if (!ok)
        ctx.mismatch(F, name, "prologue is not one section 5 gives for this pattern and hub");
      if (xx !== (psk !== null)) ctx.mismatch(F, name, "psk given for IK or missing for XXpsk3");
      if (!xx && initiator && !remote)
        ctx.mismatch(F, name, "an IK initiator without remoteStatic");
      if (!xx && !initiator && remote) ctx.mismatch(F, name, "remoteStatic for an IK responder");
      if (!Array.isArray(v.messages) || v.messages.length === 0)
        throw new ShapeError("no messages");
      const messages = v.messages.map((m, i) => hexField(v.messages, i));

      const hs = new Handshake({
        pattern: v.pattern,
        initiator,
        prologue,
        s,
        e,
        rs: !xx && initiator ? remote : null,
        psk: xx && initiator ? psk : null,
      });
      let t = null;
      const writes = () => {
        while (hs.myTurn()) hs.write(Buffer.alloc(0));
        if (hs.complete && !t) t = hs.split();
      };
      zeroDhInputs = [];
      let failedAt = null;
      let code = null;
      let at = -1; // a failure before any message is read
      try {
        writes();
        for (at = 0; at < messages.length; at++) {
          if (!hs.complete) {
            const hadRs = hs.rs !== null;
            hs.read(messages[at]);
            if (xx && !initiator && at === 0) hs.setPsk(psk);
            if (
              xx &&
              initiator &&
              remote &&
              !hadRs &&
              hs.rs !== null &&
              !same(identityBytes(hs.rs), identityBytes(remote))
            )
              throw new NoiseError("identityMismatch");
            writes();
          } else {
            if (!t) t = hs.split();
            transportRead(t.recv, messages[at]);
          }
        }
      } catch (err) {
        if (!(err instanceof NoiseError)) throw err;
        failedAt = at;
        code = err.code;
      }
      ctx.count(`app: refusals: ${String(v.expect)}`);
      const last = messages.length - 1;
      if (failedAt === null)
        ctx.mismatch(F, name, `my implementation accepts it (vector: ${v.expect})`);
      else if (failedAt !== last)
        ctx.mismatch(
          F,
          name,
          `my implementation refuses it ${failedAt < 0 ? "before" : `at message ${failedAt + 1}`}, not at the last (${code})`,
        );
      else if (code !== v.expect) ctx.mismatch(F, name, `my reason ${code}, vector ${v.expect}`);
      if (code === "allZeroDh") {
        ctx.count("app: refusals: all-zero DH from a listed low-order key");
        const which = zeroDhInputs.map(lowOrderName);
        if (which.some((x) => x === undefined))
          ctx.mismatch(
            F,
            name,
            "an all-zero DH from a key not in the description's low-order list",
          );
        which.forEach((x) => seenLowOrder.add(x));
      }
      // After a refusal every further call is refused: a property of this script's state machine
      // (Handshake.guarded), not of the vector, so it is not counted.
    });
  }
  const missing = [...LOW_ORDER.keys()].filter((k) => !seenLowOrder.has(k));
  if (missing.length)
    ctx.note(`${F}: low-order keys listed but never refused: ${missing.join(", ")}`);
}

function checkBackup(ctx) {
  const F = "app-backup.json";
  const errors = ["badMagic", "badFormat", "truncated", "decryptFailed", "cut"];
  for (const v of loadApp(ctx, F)) {
    const name = typeof v?.name === "string" ? v.name : "(unnamed)";
    guardCase(ctx, F, name, () => {
      knownKeys(ctx, F, name, v, ["name", "backupKey", "header", "database", "file", "tamper"]);
      const key = hexField(v, "backupKey", 32);
      const header = hexField(v, "header", HEADER);
      const database = hexField(v, "database");
      const file = hexField(v, "file");
      ctx.count("app: backup headers: section 9's layout");
      try {
        checkHeader(header);
      } catch (e) {
        if (!(e instanceof BackupError)) throw e;
        ctx.mismatch(F, name, `header refused by mine (${e.code})`);
      }
      ctx.count("app: backup files sealed exactly (header and every chunk)");
      const mine = sealBackup(key, header, database);
      if (!same(mine, file)) {
        const at = mine.findIndex((b, i) => b !== file[i]);
        const where =
          mine.length !== file.length && at < 0
            ? "its length"
            : at < HEADER
              ? "the header"
              : `chunk ${Math.floor((at - HEADER) / SEALED_CHUNK)}`;
        ctx.mismatch(F, name, `file differs from mine, first at ${where}`);
      }
      ctx.count("app: backup files opened back to the database");
      try {
        if (!same(openBackup(key, file), database))
          ctx.mismatch(F, name, "file opens to another database");
      } catch (e) {
        if (!(e instanceof BackupError)) throw e;
        ctx.mismatch(F, name, `my opener refuses the file (${e.code})`);
      }
      if (!Array.isArray(v.tamper)) throw new ShapeError(`"tamper" is not an array`);
      v.tamper.forEach((t, j) => {
        const tname = `${name} › tamper ${j} (${String(t?.expect)})`;
        knownKeys(ctx, F, tname, t, ["file", "expect"]);
        if (!errors.includes(t?.expect))
          ctx.mismatch(F, tname, `expect ${t?.expect}: not an error section 9 or the file gives`);
        ctx.count(`app: backup tampers: ${String(t?.expect)}`);
        let code = null;
        try {
          openBackup(key, hexField(t, "file"));
        } catch (e) {
          if (!(e instanceof BackupError)) throw e;
          code = e.code;
        }
        if (code === null) ctx.mismatch(F, tname, `my opener accepts it (vector: ${t.expect})`);
        else if (code !== t.expect) ctx.mismatch(F, tname, `my reason ${code}, vector ${t.expect}`);
      });
    });
  }
  ctx.note(
    `${F}: SPEC-QUESTION section 9 names no error for a wrong magic (badMagic is the file's), nor which ` +
      "check comes first when a file is both shorter than its header and of another magic (mine: truncated)",
  );
  ctx.note(
    `${F}: SPEC-QUESTION "a time past 2^53 - 1 is badFormat" is the file's description, not section 9; mine ` +
      "applies it to both u64 times (made, bytes 26-33; last change, bytes 46-53)",
  );
  ctx.note(
    `${F}: the header's fields (identity, epoch, times, schema, salt) are given only as bytes, so only ` +
      "their layout and limits are checked; `finished` (a call after finish) is API behaviour no vector holds",
  );
}

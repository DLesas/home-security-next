// Independent check of pairing's vectors (docs/m3-design.md section 5; P3's): pairing-code.json,
// pairing-board-qr.json, pairing-advert.json from our own rules, and pairing-srp.json,
// pairing-security2.json, pairing-board-script.json and pairing-security2-counter.json, which
// were made by running ESP-IDF v6.1.1's protocomm security 2 for the host.
//
// Written from the files' own descriptions and the sources they name, not from packages/protocol
// /src: it imports nothing from there and runs none of it. SRP is plain BigInt arithmetic
// (square-and-multiply) with Node's SHA-512; AES-256-GCM and SHA-256 are Node's; the protobuf is
// this file's own; and the board's scripts are replayed against this file's own model of
// security2.c's state machine, which must give every recorded answer, refusal and event.
//
// Called by verify-vectors.mjs with its `mismatch`, `count` and `note`; returns the file names it
// checked. Every disagreement is a mismatch, never an exception. Messages name fields and cases
// only, never key bytes.

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URLSearchParams } from "node:url";

export const PAIRING_FILES = [
  "pairing-code.json",
  "pairing-board-qr.json",
  "pairing-advert.json",
  "pairing-srp.json",
  "pairing-security2.json",
  "pairing-board-script.json",
  "pairing-security2-counter.json",
];

const hexOf = (b) => Buffer.from(b).toString("hex");
const bytes = (h) => Buffer.from(h, "hex");
const sha512 = (...parts) => createHash("sha512").update(Buffer.concat(parts)).digest();

// ---------------------------------------------------------------------------
// The pairing code, the QR code and the advertisement, from the rules
// ---------------------------------------------------------------------------

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECKS = "*~$=U";

function checkChar(value) {
  const r = Number(value % 37n);
  return r < 32 ? ALPHABET[r] : CHECKS[r - 32];
}

/** Returns { code, shown, secret } or null. */
function readCode(text) {
  let t = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const space = /\s/u.test(ch);
    const dash = ch === "-" || (cp >= 0x2010 && cp <= 0x2014) || cp === 0x2212;
    if (!space && !dash) t += ch;
  }
  for (const ch of t) if (ch.codePointAt(0) < 0x21 || ch.codePointAt(0) > 0x7e) return null;
  t = t.toUpperCase();
  t = t.replaceAll("I", "1").replaceAll("L", "1").replaceAll("O", "0");
  if (t.length !== 8) return null;
  let value = 0n;
  for (let i = 0; i < 7; i++) {
    const d = ALPHABET.indexOf(t[i]);
    if (d < 0) return null;
    value = value * 32n + BigInt(d);
  }
  if (t[7] !== checkChar(value)) return null;
  return { code: t, shown: `${t.slice(0, 4)}-${t.slice(4)}`, secret: value.toString() };
}

function readQr(text) {
  const prefix = "hsn://pair/1?";
  if (!text.startsWith(prefix)) return null;
  const query = new URLSearchParams(text.slice(prefix.length));
  const c = query.getAll("c");
  const d = query.getAll("d");
  if (c.length !== 1 || d.length !== 1) return null;
  const code = readCode(c[0]);
  if (code === null || !/^[0-9a-f]{12}$/u.test(d[0])) return null;
  return { code: code.code, chipId: d[0] };
}

function readAdvert(localName) {
  const match =
    typeof localName === "string" && /^hsn-pair-([0-9a-f]{4})(?![\s\S])/u.exec(localName);
  return match ? { chipSuffix: match[1] } : null;
}

// ---------------------------------------------------------------------------
// SRP6a, as esp_srp.c computes it
// ---------------------------------------------------------------------------

const N = BigInt(
  "0x" +
    "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404dd" +
    "ef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7ed" +
    "ee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f" +
    "83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3b" +
    "e39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa0510" +
    "15728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7" +
    "abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200c" +
    "bbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a93ad2caffffffffffffffff",
);
const g = 5n;
const big = (b) => (b.length === 0 ? 0n : BigInt(`0x${hexOf(b)}`));
const pad = (n, len = 384) => bytes(n.toString(16).padStart(2 * len, "0"));
const minimal = (n) =>
  n === 0n
    ? Buffer.alloc(0)
    : bytes(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0"));
function pow(base, e) {
  let r = 1n;
  let b = base % N;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % N;
    b = (b * b) % N;
    e >>= 1n;
  }
  return r;
}
const N_BYTES = pad(N);
const PAD_G = pad(g);
const k = big(sha512(N_BYTES, PAD_G));
const HNxHG = Buffer.from(sha512(N_BYTES).map((x, i) => x ^ sha512(PAD_G)[i]));
const ascii = (s) => Buffer.from(s, "utf8");

const xOf = (user, pass, salt) => big(sha512(salt, sha512(ascii(user), ascii(":"), ascii(pass))));
const verifierOf = (user, pass, salt) => minimal(pow(g, xOf(user, pass, salt)));
const devicePublicOf = (v, b) => minimal((k * v + pow(g, b)) % N);
const uOf = (A, B) => sha512(pad(big(A)), pad(big(B)));
const proofOf = (user, salt, A, B, K) => sha512(HNxHG, sha512(ascii(user)), salt, A, B, K);
const amkOf = (A, M, K) => sha512(A, M, K);

// ---------------------------------------------------------------------------
// The protobuf: SessionData, Sec2Payload and its four messages
// ---------------------------------------------------------------------------

function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
const lenField = (field, b) => [...varint((field << 3) | 2), ...varint(b.length), ...b];
const numField = (field, n) => (n === 0 ? [] : [...varint(field << 3), ...varint(n)]);
const bytesField = (field, b) => (b.length === 0 ? [] : lenField(field, b));

/** fields: [[number, value]] in order; numbers are varints, Buffers bytes. */
function sessionData(msg, payloadField, body) {
  const payload = Buffer.from([...numField(1, msg), ...lenField(payloadField, body)]);
  return Buffer.from([...numField(2, 2), ...lenField(12, payload)]);
}
const command0 = (user, A) =>
  sessionData(0, 20, Buffer.from([...bytesField(1, ascii(user)), ...bytesField(2, A)]));
const response0 = (B, salt) =>
  sessionData(1, 21, Buffer.from([...bytesField(2, B), ...bytesField(3, salt)]));
const command1 = (M) => sessionData(2, 22, Buffer.from(bytesField(1, M)));
const response1 = (amk, nonce) =>
  sessionData(3, 23, Buffer.from([...bytesField(2, amk), ...bytesField(3, nonce)]));

/** Parses protobuf fields: { n: Map(field -> number), b: Map(field -> Buffer) } or null. */
function fields(buf) {
  const n = new Map();
  const b = new Map();
  let at = 0;
  const vi = () => {
    let v = 0;
    let shift = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= buf.length) return null;
      const byte = buf[at++];
      v += (byte & 0x7f) * shift;
      shift *= 128;
      if (byte < 0x80) return v;
    }
    return null;
  };
  while (at < buf.length) {
    const key = vi();
    if (key === null) return null;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const v = vi();
      if (v === null) return null;
      n.set(field, v);
    } else if (wire === 2) {
      const len = vi();
      if (len === null || at + len > buf.length) return null;
      b.set(field, buf.subarray(at, at + len));
      at += len;
    } else return null;
  }
  return { n, b };
}

/** { secVer, msg, case, body } with body's fields, or null when it is not a SessionData. */
function parseSession(buf) {
  const outer = fields(buf);
  if (outer === null) return null;
  const secVer = outer.n.get(2) ?? 0;
  const sec2 = outer.b.get(12);
  const otherProto = outer.b.has(10) || outer.b.has(11);
  if (sec2 === undefined) return { secVer, msg: null, otherProto };
  const payload = fields(sec2);
  if (payload === null) return null;
  const which = [20, 21, 22, 23].filter((f) => payload.b.has(f));
  const body = which.length === 1 ? fields(payload.b.get(which[0])) : null;
  return { secVer, msg: payload.n.get(1) ?? 0, case: which[0] ?? null, body, otherProto };
}

// ---------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------

const nonceOf = (sessionId, counter) => {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(counter >>> 0);
  return Buffer.concat([sessionId, c]);
};
function seal(key, nonce, plaintext) {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}
function open(key, nonce, sealed) {
  if (sealed.length < 16) return null;
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const out = d.update(sealed.subarray(0, sealed.length - 16));
  try {
    d.final();
  } catch {
    return null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export function verifyPairingVectors(dir, { mismatch, count, note }) {
  const ctx = { dir, mismatch, count, note };
  checkCodes(ctx);
  checkQr(ctx);
  checkAdverts(ctx);
  const srp = checkSrp(ctx);
  checkSecurity2(ctx, srp);
  checkScripts(ctx, srp);
  checkCounter(ctx, srp);
  return new Set(PAIRING_FILES);
}

function load(ctx, name, top) {
  let file;
  try {
    file = JSON.parse(readFileSync(join(ctx.dir, name), "utf8"));
  } catch (e) {
    ctx.mismatch(name, "(file)", `cannot be read: ${e.message}`);
    return { cases: [] };
  }
  for (const key of Object.keys(file))
    if (!["schemaVersion", "description", "cases", ...top].includes(key))
      ctx.mismatch(name, "(file)", `section "${key}" the script does not know`);
  if (file.schemaVersion !== 1) ctx.mismatch(name, "(file)", `schemaVersion ${file.schemaVersion}`);
  if (typeof file.description !== "string") ctx.mismatch(name, "(file)", "no description");
  if (!Array.isArray(file.cases) || file.cases.length === 0) {
    ctx.mismatch(name, "(file)", "no cases");
    file.cases = [];
  }
  if (
    top.includes("source") &&
    !/^ESP-IDF v6\.1\.1 \(commit [0-9a-f]{40}\)/u.test(file.source ?? "")
  )
    ctx.mismatch(name, "(file)", "source does not name ESP-IDF v6.1.1 and its commit");
  return file;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkCodes(ctx) {
  const F = "pairing-code.json";
  for (const c of load(ctx, F, []).cases) {
    const mine = readCode(c.text);
    const want = c.code === null ? null : { code: c.code, shown: c.shown, secret: c.secret };
    if (!same(mine, want))
      ctx.mismatch(F, c.name, `vector ${JSON.stringify(want)}, mine ${JSON.stringify(mine)}`);
    ctx.count("pairing code");
  }
}

function checkQr(ctx) {
  const F = "pairing-board-qr.json";
  for (const c of load(ctx, F, []).cases) {
    if (!same(readQr(c.text), c.qr)) ctx.mismatch(F, c.name, "read differently");
    ctx.count("board QR code");
  }
}

function checkAdverts(ctx) {
  const F = "pairing-advert.json";
  for (const c of load(ctx, F, []).cases) {
    if (!same(readAdvert(c.localName), c.advert)) ctx.mismatch(F, c.name, "read differently");
    ctx.count("pairing advertisement");
  }
}

/** Returns the SRP cases by name, each with its K. */
function checkSrp(ctx) {
  const F = "pairing-srp.json";
  const byName = new Map();
  for (const c of load(ctx, F, ["source"]).cases) {
    const salt = bytes(c.salt);
    const a = big(bytes(c.clientPrivate));
    const b = big(bytes(c.devicePrivate));
    const A = bytes(c.clientPublic);
    const B = bytes(c.devicePublic);
    const v = verifierOf(c.username, c.password, salt);
    const check = (field, got) => {
      if (hexOf(got) !== c[field]) ctx.mismatch(F, c.name, `${field} differs`);
      ctx.count("SRP value");
    };
    check("verifier", v);
    check("clientPublic", pad(pow(g, a)));
    check("devicePublic", devicePublicOf(big(v), b));
    const u = uOf(A, B);
    check("u", u);
    const x = xOf(c.username, c.password, salt);
    // S both ways: the board's (A v^u)^b, the phone's (B - k g^x)^(a + u x).
    const sBoard = pow((big(A) * pow(big(v), big(u))) % N, b);
    const sPhone = pow((((big(B) - ((k * pow(g, x)) % N)) % N) + N) % N, a + big(u) * x);
    if (sBoard !== sPhone) ctx.mismatch(F, c.name, "the board's S and the phone's differ");
    const K = sha512(minimal(sBoard));
    check("sessionKey", K);
    const M = proofOf(c.username, salt, A, B, K);
    check("clientProof", M);
    check("deviceProof", amkOf(A, M, K));
    if (salt.length !== 16) ctx.mismatch(F, c.name, "salt not 16 bytes");
    byName.set(c.name, { ...c, K });
  }
  return byName;
}

function checkSecurity2(ctx, srp) {
  const F = "pairing-security2.json";
  for (const c of load(ctx, F, ["source"]).cases) {
    const s = srp.get(c.srpCase);
    if (s === undefined) {
      ctx.mismatch(F, c.name, "names no SRP case");
      continue;
    }
    const A = bytes(s.clientPublic);
    const B = bytes(s.devicePublic);
    const M = proofOf(s.username, bytes(s.salt), A, B, s.K);
    const nonce = bytes(c.nonce);
    const expect = {
      command0: command0(s.username, A),
      response0: response0(B, bytes(s.salt)),
      command1: command1(M),
      response1: response1(amkOf(A, M, s.K), nonce),
    };
    for (const [field, want] of Object.entries(expect)) {
      if (hexOf(want) !== c[field]) ctx.mismatch(F, c.name, `${field} differs`);
      ctx.count("security 2 message");
    }
    if (nonce.length !== 12 || nonce.readUInt32BE(8) !== 1)
      ctx.mismatch(F, c.name, "nonce's counter is not 1");
    const key = s.K.subarray(0, 32);
    const id = nonce.subarray(0, 8);
    c.messages.forEach((m, i) => {
      const n = nonceOf(id, i + 1);
      if (hexOf(n) !== m.nonce) ctx.mismatch(F, `${c.name} #${i}`, "nonce is not the counter's");
      if (m.direction !== (i % 2 === 0 ? "toBoard" : "toPhone"))
        ctx.mismatch(F, `${c.name} #${i}`, "not request then answer");
      if (hexOf(seal(key, n, bytes(m.plaintext))) !== m.sealed)
        ctx.mismatch(F, `${c.name} #${i}`, "sealed differs");
      ctx.count("sealed setup message");
    });
  }
}

/** security2.c and protocomm.c's behaviour for one connection, from the case's salt and verifier. */
function boardModel(s, draws, versionText) {
  const st = { state: 0, counter: 0, version: versionText, drawn: 0 };
  const next = () => (st.drawn < draws.length ? bytes(draws[st.drawn++]) : null);
  const refuse = (event = null) => ({ answer: null, event, ran: false });
  return {
    st,
    write(endpoint, request) {
      if (endpoint === "proto-ver")
        return { answer: Buffer.from(versionText ?? ""), event: null, ran: false, version: true };
      if (endpoint === "prov-session") {
        const m = parseSession(request);
        if (m === null || m.secVer !== 2 || m.msg === null) return refuse();
        if (m.msg === 0) {
          if (m.case !== 20 || m.body === null) return refuse();
          if (st.state !== 0) st.state = 0;
          const A = m.body.b.get(2) ?? Buffer.alloc(0);
          const user = m.body.b.get(1) ?? Buffer.alloc(0);
          if (A.length !== 384 || user.length === 0) return refuse("invalidSecurityParams");
          const bBytes = next();
          if (bBytes === null) return { error: "the board draws a b the script does not list" };
          const v = big(bytes(s.verifier));
          const B = devicePublicOf(v, big(bBytes));
          if (big(A) % N === 0n) return refuse();
          const u = uOf(A, B);
          if (big(u) === 0n) return refuse();
          const S = pow((big(A) * pow(v, big(u))) % N, big(bBytes));
          Object.assign(st, { state: 1, A, B, user, K: sha512(minimal(S)) });
          return { answer: response0(B, bytes(s.salt)), event: null, ran: false };
        }
        if (m.msg === 2) {
          if (m.case !== 22 || m.body === null || st.state !== 1) return refuse();
          const proof = m.body.b.get(1) ?? Buffer.alloc(0);
          if (proof.length !== 64) return refuse();
          const M = sha512(HNxHG, sha512(st.user), bytes(s.salt), st.A, st.B, st.K);
          if (!proof.equals(M)) return refuse("credentialsMismatch");
          const id = next();
          if (id === null)
            return { error: "the board draws a session id the script does not list" };
          Object.assign(st, { state: 2, id, counter: 1, key: st.K.subarray(0, 32) });
          return {
            answer: response1(amkOf(st.A, M, st.K), nonceOf(id, 1)),
            event: "setupOk",
            ran: false,
          };
        }
        return refuse();
      }
      // hsn-setup: decrypt, the handler, encrypt; the counter steps after each.
      if (st.state !== 2 || st.counter === 0) return refuse();
      const plain = open(st.key, nonceOf(st.id, st.counter), request);
      if (plain === null) return refuse();
      st.counter = (st.counter + 1) >>> 0;
      const answer = plain.equals(Buffer.from([0xf1, 0x01]))
        ? "identity"
        : plain[0] === 0xf1 && plain[1] === 0x03
          ? Buffer.from([0xf1, 0x04, 0x00])
          : null;
      if (answer === null || st.counter === 0) return { answer: null, event: null, ran: true };
      const n = nonceOf(st.id, st.counter);
      st.counter = (st.counter + 1) >>> 0;
      return { answer: "sealed", nonce: n, ran: true, plainAnswer: answer, event: null };
    },
  };
}

function checkScripts(ctx, srp) {
  const F = "pairing-board-script.json";
  const file = load(ctx, F, ["source"]);
  const versionStep = file.cases[0]?.steps.find((s) => s.endpoint === "proto-ver");
  const versionText = versionStep?.answer ? bytes(versionStep.answer).toString("utf8") : null;
  let version;
  try {
    version = JSON.parse(versionText ?? "");
  } catch {
    version = null;
  }
  if (
    version === null ||
    version.v !== "hsn-pair/1" ||
    version.sec !== 2 ||
    !/^[0-9a-f]{12}$/u.test(version.chip) ||
    !/^\d+\.\d+\.\d+$/u.test(version.firmware) ||
    !Number.isInteger(version.role) ||
    Object.keys(version).length !== 5
  )
    ctx.mismatch(F, "proto-ver", "the board's text is not the pairing version");
  for (const c of file.cases) {
    const s = srp.get(c.srpCase);
    if (s === undefined) {
      ctx.mismatch(F, c.name, "names no SRP case");
      continue;
    }
    const board = boardModel(s, c.boardDraws, versionText);
    // The phone's a: each command 0's A must be g^a of the next one listed.
    let privates = 0;
    c.steps.forEach((step, i) => {
      const where = `${c.name} #${i}`;
      const request = bytes(step.request);
      if (step.endpoint === "prov-session") {
        const m = parseSession(request);
        const A = m?.body?.b.get(2);
        // A sent short (383 bytes) is the first bytes of the 384.
        const mine = hexOf(pad(pow(g, big(bytes(c.clientPrivates[privates] ?? "")))));
        if (
          m?.msg === 0 &&
          A !== undefined &&
          A.length > 0 &&
          big(A) % N !== 0n &&
          mine.startsWith(hexOf(A))
        )
          privates++;
      }
      const r = board.write(step.endpoint, request);
      if (r.error) return ctx.mismatch(F, where, r.error);
      if (r.answer === "sealed") {
        // Open the recorded answer at the model's counter: right key, nonce and counter.
        const got = step.answer === null ? null : open(board.st.key, r.nonce, bytes(step.answer));
        if (got === null)
          ctx.mismatch(F, where, "the recorded answer does not open at the model's counter");
        else if (r.plainAnswer === "identity") {
          if (
            got.length !== 22 ||
            got[0] !== 0xf1 ||
            got[1] !== 0x02 ||
            got[2] !== version?.role ||
            hexOf(got.subarray(3, 9)) !== version?.chip
          )
            ctx.mismatch(F, where, "the Identity is not the proto-ver board's");
        } else if (!got.equals(r.plainAnswer))
          ctx.mismatch(F, where, "the answer is not the Provision result");
      } else {
        const want = r.answer === null ? null : hexOf(r.answer);
        if (want !== step.answer)
          ctx.mismatch(
            F,
            where,
            want === null
              ? "the model refuses it"
              : step.answer === null
                ? "the model answers it"
                : "the answer differs",
          );
      }
      if ((r.event ?? null) !== step.event)
        ctx.mismatch(F, where, `event ${step.event}, model ${r.event ?? null}`);
      if (r.ran !== step.setupHandlerRan) ctx.mismatch(F, where, "setupHandlerRan differs");
      ctx.count("board script step");
    });
    if (privates !== c.clientPrivates.length)
      ctx.mismatch(F, c.name, "clientPrivates are not the command 0s' a");
    if (board.st.drawn !== c.boardDraws.length) ctx.mismatch(F, c.name, "boardDraws not all drawn");
    // The wrong password's proof is the one the script sent.
    if (c.wrongPassword !== null) {
      const first = c.steps.findIndex((st) => st.event === "credentialsMismatch");
      const a = big(bytes(c.clientPrivates[0] ?? ""));
      const A = pad(pow(g, a));
      const answer0 = c.steps[first - 1]?.answer;
      const B = answer0
        ? (parseSession(bytes(answer0))?.body?.b.get(2) ?? Buffer.alloc(0))
        : Buffer.alloc(0);
      const x = xOf(s.username, c.wrongPassword, bytes(s.salt));
      const u = uOf(A, B);
      const S = pow((((big(B) - ((k * pow(g, x)) % N)) % N) + N) % N, a + big(u) * x);
      const M = proofOf(s.username, bytes(s.salt), A, B, sha512(minimal(S)));
      if (hexOf(command1(M)) !== c.steps[first]?.request)
        ctx.mismatch(F, c.name, "the wrong code's command 1 is not its proof");
      ctx.count("board script step");
    }
  }
}

function checkCounter(ctx, srp) {
  const F = "pairing-security2-counter.json";
  const file = load(ctx, F, ["source", "srpCase", "key", "sessionId"]);
  const s = srp.get(file.srpCase);
  if (s === undefined || hexOf(s.K.subarray(0, 32)) !== file.key)
    ctx.mismatch(F, "(file)", "key is not the SRP case's");
  const key = bytes(file.key ?? "");
  const id = bytes(file.sessionId ?? "");
  for (const c of file.cases) {
    let counter = c.startCounter;
    c.messages.forEach((m, i) => {
      const where = `${c.name} #${i}`;
      if (m.counter !== counter)
        ctx.mismatch(F, where, "counters are not consecutive, wrapping at 2^32");
      const n = nonceOf(id, m.counter);
      if (hexOf(n) !== m.nonce) ctx.mismatch(F, where, "nonce");
      if (hexOf(seal(key, n, bytes(m.plaintext))) !== m.sealed)
        ctx.mismatch(F, where, "sealed differs");
      // security2.c refuses at 0; a request at 0xffffffff is opened but its answer cannot be sealed.
      const refused = m.counter === 0 || (m.direction === "toBoard" && m.counter === 0xffffffff);
      if (refused !== m.refused)
        ctx.mismatch(F, where, `refused ${m.refused}, the rule says ${refused}`);
      counter = (counter + 1) >>> 0;
      ctx.count("counter edge");
    });
  }
  ctx.note(
    "pairing-board-script.json's refusals are replayed against this file's model of security2.c; " +
      "the four ESP-IDF files are not made again here (that needs ESP-IDF: esp-idf/make-vectors.sh).",
  );
}

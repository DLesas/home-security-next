/**
 * Writes the app channel's own vectors, `packages/protocol/vectors/app-*.json` (docs/m2-design.md
 * section 10), in the formats `vector-formats.ts` freezes: every handshake with fixed keys, the
 * handshakes that must fail, the typed codes, the 128-bit secrets and the backup files. Fixed
 * keys and values only, no randomness, no clock: `app-vectors.test.ts` fails if a committed file
 * differs from what this writes. Run `bun packages/protocol/src/app/vectors/app-vectors.ts` to write them.
 *
 * The honest handshakes are made by `noise.ts`, whose Noise is checked against the published
 * vectors (`noise-published.test.ts`); the failing ones by `noise.ts` with keys an attacker would
 * use, or by hand where an attacker would send bytes no honest side can (low-order ephemerals).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex } from "../../bytes.ts";
import { BACKUP_FORMAT, type BackupHeader } from "../backup-interface.ts";
import { backupCodec, encodeBackupHeader } from "../backup.ts";
import {
  appIdentityBytes,
  formatIdentity,
  formatLinkAddress,
  formatLinkQr,
  formatTypedCode,
  label,
  linkPrologue,
  parseTypedCode,
  secretLookup,
  secretPsk,
  sessionPrologue,
  typedLookup,
  typedPsk,
  typedSecretBytes,
} from "../linking.ts";
import {
  type Handshake,
  NOISE_PATTERNS,
  type NoisePattern,
  type StaticKey,
  type TransportSession,
} from "../noise-interface.ts";
import { startHandshake, SymmetricState, x25519StaticKey } from "../noise.ts";

const encoder = new TextEncoder();
const IK = NOISE_PATTERNS.session;
const XX = NOISE_PATTERNS.link;

export const APP_VECTOR_DIRECTORY = join(import.meta.dir, "..", "..", "..", "vectors");

// ----- Fixed keys and values -----

interface KeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** A fixed 32-byte value: SHA-256 of `hsn-vector/<name>`. */
function fixed(name: string): Uint8Array {
  return sha256(encoder.encode(`hsn-vector/${name}`));
}

function keyPair(name: string): KeyPair {
  const privateKey = fixed(name);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

function staticOf(pair: KeyPair): StaticKey {
  const key = x25519StaticKey(pair.privateKey);
  if (!key.ok) throw new Error("a fixed static key was refused");
  return key.value;
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

const HUB = keyPair("hub-static");
const OTHER_HUB = keyPair("other-hub-static");
const BROWSER = keyPair("browser-static");
const PHONE = keyPair("phone-static");
const HUB_IDENTITY = appIdentityBytes(sha256, HUB.publicKey);
const HUB_IDENTITY_TEXT = formatIdentity(HUB_IDENTITY);

const HUB_VERSION = "0.2.0";
const APP_VERSION = "0.2.0";
const ADDRESSES = ["192.168.1.20", "fd00::20"];
const LAN_PORT = 8444;
const FINGERPRINT = fixed("certificate-fingerprint");
const BACKUP_KEY = fixed("backup-key");
const BACKUP_EPOCH = 3;

/** The 128-bit secrets of the link and restore vectors, each with what it carries. */
const SECRETS = {
  qr: fixed("secret-qr").slice(0, 16),
  linkAddress: fixed("secret-link-address").slice(0, 16),
  restore: fixed("secret-restore").slice(0, 16),
} as const;

/** The typed code of the typed-code link vector. */
const TYPED = { tokenId: 0x4_a3c1, secret: 0x5_1b2c_3d4en } as const;

/**
 * Points of order dividing 8 (u-coordinates, little-endian), and non-canonical encodings of them:
 * every X25519 with one of these is all zero (RFC 7748; noble's list, libsodium's).
 */
const P = 2n ** 255n - 19n;
const LOW_ORDER: readonly (readonly [string, bigint])[] = [
  ["0", 0n],
  ["1", 1n],
  [
    "an order-8 point",
    325606250916557431795983626356110631294008115727848805560023387167927233504n,
  ],
  [
    "the other order-8 point",
    39382357235489614581723060781553021112529911719440698176882885853963445705823n,
  ],
  ["p − 1", P - 1n],
  ["p (0, not reduced)", P],
  ["p + 1 (1, not reduced)", P + 1n],
  ["0 with the top bit set", 2n ** 255n],
];

export function lowOrderPoint(u: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let value = u;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

export const LOW_ORDER_POINTS: readonly (readonly [string, Uint8Array])[] = LOW_ORDER.map(
  ([name, u]) => [name, lowOrderPoint(u)],
);

/** A static key whose public key is low order, as an attacker holds it: its own DH is anything. */
function lowOrderStatic(publicKey: Uint8Array): StaticKey {
  return { publicKey, dh: () => Promise.resolve(fixed("attacker-dh")) };
}

// ----- Running a handshake -----

type From = "initiator" | "responder";

interface HandshakeSide {
  readonly staticKey: StaticKey;
  readonly ephemeral: KeyPair;
  readonly remoteStatic?: Uint8Array;
}

async function start(
  pattern: NoisePattern,
  initiator: boolean,
  prologue: Uint8Array,
  side: HandshakeSide,
  psk: Uint8Array | undefined,
) {
  const handshake = startHandshake({
    pattern,
    initiator,
    prologue,
    staticKey: side.staticKey,
    ephemeral: side.ephemeral,
    ...(side.remoteStatic === undefined ? {} : { remoteStatic: side.remoteStatic }),
    // The XXpsk3 responder takes its key by `setPsk` after message 1 (`afterRead`).
    ...(psk === undefined || !initiator ? {} : { psk }),
  });
  if (!handshake.ok) throw new Error(`a vector's handshake did not start: ${handshake.error}`);
  return Promise.resolve(handshake.value);
}

/** Reads message `index`, and gives an XXpsk3 responder its key after message 1, as the hub does. */
async function afterRead(
  reader: Handshake,
  message: Uint8Array,
  index: number,
  psk: Uint8Array | undefined,
): Promise<void> {
  must(await reader.readMessage(message), "read");
  if (index === 0 && psk !== undefined) must(reader.setPsk(psk), "setPsk");
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: string }, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${result.error}`);
  return result.value;
}

interface Run {
  readonly messages: readonly { from: From; payload: Uint8Array; message: Uint8Array }[];
  readonly handshakeHash: Uint8Array;
  readonly transport: readonly { from: From; plaintext: Uint8Array; message: Uint8Array }[];
}

/** An honest handshake between two sides, then its transport messages. */
async function honest(
  pattern: NoisePattern,
  prologue: Uint8Array,
  psk: Uint8Array | undefined,
  initiatorSide: HandshakeSide,
  responderSide: HandshakeSide,
  payloads: readonly Uint8Array[],
  transport: readonly { from: From; plaintext: Uint8Array }[],
): Promise<Run> {
  const initiator = await start(pattern, true, prologue, initiatorSide, psk);
  const responder = await start(pattern, false, prologue, responderSide, psk);
  const messages: { from: From; payload: Uint8Array; message: Uint8Array }[] = [];
  for (const [i, payload] of payloads.entries()) {
    const from: From = i % 2 === 0 ? "initiator" : "responder";
    const [writer, reader] = from === "initiator" ? [initiator, responder] : [responder, initiator];
    const message = must(await writer.writeMessage(payload), "write");
    await afterRead(reader, message, i, psk);
    messages.push({ from, payload, message });
  }
  if (!initiator.complete || !responder.complete) throw new Error("a handshake did not complete");
  const handshakeHash = initiator.handshakeHash();
  const sessions: Record<From, TransportSession> = {
    initiator: must(initiator.split(), "split"),
    responder: must(responder.split(), "split"),
  };
  const sent = transport.map(({ from, plaintext }) => {
    const message = must(sessions[from].encrypt(plaintext), "encrypt");
    must(sessions[from === "initiator" ? "responder" : "initiator"].decrypt(message), "decrypt");
    return { from, plaintext, message };
  });
  return { messages, handshakeHash, transport: sent };
}

// ----- app-noise.json: every handshake -----

const hubHello = (client: { id: number; person: number | null; kind: string }) =>
  json({ proto: 1, hub: HUB_VERSION, boot: 3, rev: 41, client, features: [] });
// Message 2 says whether the client asks for a new person's name (step 1, wave 2): no, here.
const linkHub = json({ hub: HUB_VERSION, proto: 1, askName: false });

interface NoiseVectorPlan {
  readonly name: string;
  readonly pattern: NoisePattern;
  readonly purpose: "session" | "link" | "restore";
  readonly carrier?: "qr" | "linkAddress" | "typedCode";
  readonly prologue: Uint8Array;
  readonly psk?: Uint8Array;
  readonly initiator: KeyPair;
  readonly responder: KeyPair;
  readonly ephemerals: string;
  readonly payloads: readonly Uint8Array[];
  readonly transport: readonly { from: From; plaintext: Uint8Array }[];
}

function noisePlans(): readonly NoiseVectorPlan[] {
  const session = sessionPrologue(HUB_IDENTITY);
  const link = linkPrologue("link");
  const restore = linkPrologue("restore");
  const client = { id: 7, person: 2, kind: "web" };
  return [
    {
      name: "session (IK), a browser, no first request; then one transport message of every kind",
      pattern: IK,
      purpose: "session",
      prologue: session,
      initiator: BROWSER,
      responder: HUB,
      ephemerals: "session-1",
      payloads: [json({ proto: [1, 1], app: APP_VERSION }), hubHello(client)],
      transport: [
        { from: "initiator", plaintext: json({ t: "req", id: 1, op: "pong", body: {} }) },
        { from: "responder", plaintext: json({ t: "res", id: 1, ok: true, body: {} }) },
        {
          from: "initiator",
          plaintext: json({ t: "req", id: 2, seq: 41, op: "mode.switch", body: { mode: 1 } }),
        },
        {
          from: "responder",
          plaintext: json({
            t: "res",
            id: 2,
            ok: false,
            error: { code: "seqTooLow", detail: { last: 41 } },
          }),
        },
        {
          from: "initiator",
          plaintext: json({ t: "req", id: 3, seq: 42, op: "mode.switch", body: { mode: 1 } }),
        },
        {
          from: "responder",
          plaintext: json({
            t: "res",
            id: 3,
            ok: true,
            body: { armed: [4, 5], disarmed: [], waiting: [6] },
            repeat: true,
          }),
        },
        { from: "responder", plaintext: json({ t: "evt", rev: 42, ev: "ping", body: {} }) },
      ],
    },
    {
      name: "session (IK), a phone, with a first request (the lock-screen Disarm)",
      pattern: IK,
      purpose: "session",
      prologue: session,
      initiator: PHONE,
      responder: HUB,
      ephemerals: "session-2",
      payloads: [
        json({
          proto: [1, 1],
          app: APP_VERSION,
          first: { t: "req", id: 1, seq: 9, op: "disarm", body: { target: "mine" } },
        }),
        hubHello({ id: 8, person: 2, kind: "phone" }),
      ],
      transport: [
        {
          from: "responder",
          plaintext: json({
            t: "res",
            id: 1,
            ok: true,
            body: { disarmed: [4, 5, 6], alarmEnded: true },
          }),
        },
        { from: "initiator", plaintext: json({ t: "req", id: 2, op: "pong", body: {} }) },
      ],
    },
    {
      name: "link (XXpsk3) from a QR code: a phone for a new person, given the backup key",
      pattern: XX,
      purpose: "link",
      carrier: "qr",
      prologue: link,
      psk: secretPsk(sha256, SECRETS.qr),
      initiator: PHONE,
      responder: HUB,
      ephemerals: "link-qr",
      payloads: [
        json({ proto: [1, 1], find: secretLookup(sha256, SECRETS.qr) }),
        linkHub,
        json({ name: "Anna’s phone", kind: "phone", person: { name: "Anna" } }),
      ],
      transport: [
        {
          from: "responder",
          plaintext: json({
            client: 8,
            person: 2,
            backupKey: { key: base64url(BACKUP_KEY), epoch: BACKUP_EPOCH },
          }),
        },
      ],
    },
    {
      name: "link (XXpsk3) from a link address: another browser of an existing person",
      pattern: XX,
      purpose: "link",
      carrier: "linkAddress",
      prologue: link,
      psk: secretPsk(sha256, SECRETS.linkAddress),
      initiator: BROWSER,
      responder: HUB,
      ephemerals: "link-address",
      payloads: [
        json({ proto: [1, 1], find: secretLookup(sha256, SECRETS.linkAddress) }),
        linkHub,
        json({ name: "Kitchen laptop", kind: "web" }),
      ],
      transport: [{ from: "responder", plaintext: json({ client: 7, person: 2 }) }],
    },
    {
      name: "link (XXpsk3) from a typed code: a browser for a new person; the lookup is the token id",
      pattern: XX,
      purpose: "link",
      carrier: "typedCode",
      prologue: link,
      psk: typedPsk(sha256, TYPED.secret),
      initiator: BROWSER,
      responder: HUB,
      ephemerals: "link-typed",
      payloads: [
        json({ proto: [1, 1], find: typedLookup(TYPED.tokenId) }),
        linkHub,
        json({ name: "Ben’s laptop", kind: "web", person: { name: "Ben" } }),
      ],
      transport: [{ from: "responder", plaintext: json({ client: 9, person: 3 }) }],
    },
    {
      name: "restore (XXpsk3): the hub proves the pre-shared key (message 4) before the phone sends the backup key (message 5)",
      pattern: XX,
      purpose: "restore",
      carrier: "qr",
      prologue: restore,
      psk: secretPsk(sha256, SECRETS.restore),
      initiator: PHONE,
      responder: HUB,
      ephemerals: "restore",
      payloads: [
        json({ proto: [1, 1], find: secretLookup(sha256, SECRETS.restore) }),
        linkHub,
        json({ app: APP_VERSION }),
      ],
      transport: [
        {
          from: "responder",
          plaintext: json({
            identity: formatIdentity(appIdentityBytes(sha256, OTHER_HUB.publicKey)),
            epoch: BACKUP_EPOCH,
            madeMs: 1_794_096_000_000,
            lastChangeMs: 1_794_009_600_000,
          }),
        },
        {
          from: "initiator",
          plaintext: json({ key: base64url(BACKUP_KEY), epoch: BACKUP_EPOCH }),
        },
        { from: "responder", plaintext: json({ ok: true }) },
      ],
    },
  ];
}

function pairJson(pair: KeyPair) {
  return { private: toHex(pair.privateKey), public: toHex(pair.publicKey) };
}

async function noiseVectors() {
  const out = [];
  for (const plan of noisePlans()) {
    const ie = keyPair(`${plan.ephemerals}/initiator-ephemeral`);
    const re = keyPair(`${plan.ephemerals}/responder-ephemeral`);
    const run = await honest(
      plan.pattern,
      plan.prologue,
      plan.psk,
      {
        staticKey: staticOf(plan.initiator),
        ephemeral: ie,
        ...(plan.pattern === IK ? { remoteStatic: plan.responder.publicKey } : {}),
      },
      { staticKey: staticOf(plan.responder), ephemeral: re },
      plan.payloads,
      plan.transport,
    );
    out.push({
      name: plan.name,
      pattern: plan.pattern,
      purpose: plan.purpose,
      ...(plan.carrier === undefined ? {} : { carrier: plan.carrier }),
      prologue: toHex(plan.prologue),
      ...(plan.psk === undefined ? {} : { psk: toHex(plan.psk) }),
      initiator: { static: pairJson(plan.initiator), ephemeral: pairJson(ie) },
      responder: { static: pairJson(plan.responder), ephemeral: pairJson(re) },
      messages: run.messages.map((m) => ({
        from: m.from,
        payload: toHex(m.payload),
        message: toHex(m.message),
      })),
      handshakeHash: toHex(run.handshakeHash),
      transport: run.transport.map((m) => ({
        from: m.from,
        plaintext: toHex(m.plaintext),
        message: toHex(m.message),
      })),
    });
  }
  return out;
}

// ----- app-noise-failures.json: what each side must refuse -----

interface Failure {
  readonly name: string;
  readonly pattern: NoisePattern;
  readonly side: From;
  readonly prologue: Uint8Array;
  readonly psk?: Uint8Array;
  readonly staticKey: KeyPair;
  readonly ephemeral: KeyPair;
  readonly remoteStatic?: Uint8Array;
  readonly messages: readonly Uint8Array[];
  readonly expect: string;
}

const EMPTY = new Uint8Array(0);

/** The messages a side writes, with the empty payload, as the failure vectors' harness does. */
async function emptyHandshake(
  pattern: NoisePattern,
  prologue: Uint8Array,
  psk: Uint8Array | undefined,
  initiatorSide: HandshakeSide,
  responderSide: HandshakeSide,
): Promise<Run> {
  const count = pattern === IK ? 2 : 3;
  return honest(
    pattern,
    prologue,
    psk,
    initiatorSide,
    responderSide,
    Array.from({ length: count }, () => EMPTY),
    [
      { from: "initiator", plaintext: json({ t: "req", id: 1, op: "pong", body: {} }) },
      { from: "initiator", plaintext: json({ t: "req", id: 2, op: "pong", body: {} }) },
      { from: "initiator", plaintext: json({ t: "req", id: 3, op: "pong", body: {} }) },
    ],
  );
}

/** Message i of a run, which must exist. */
function message(run: Run, i: number): Uint8Array {
  const m = run.messages[i];
  if (m === undefined) throw new Error(`no message ${i}`);
  return m.message;
}

function transportMessage(run: Run, i: number): Uint8Array {
  const m = run.transport[i];
  if (m === undefined) throw new Error(`no transport message ${i}`);
  return m.message;
}

/** One message written by a side alone (the first message of a pattern). */
async function firstMessage(
  pattern: NoisePattern,
  prologue: Uint8Array,
  psk: Uint8Array | undefined,
  side: HandshakeSide,
): Promise<Uint8Array> {
  const handshake = await start(pattern, true, prologue, side, psk);
  return must(await handshake.writeMessage(EMPTY), "write");
}

/** XXpsk3 message 1 with a chosen ephemeral public key, which no honest side would send. */
function xxFirstMessageWith(prologue: Uint8Array, ephemeralPublic: Uint8Array): Uint8Array {
  const symmetric = new SymmetricState(XX);
  symmetric.mixHash(prologue);
  symmetric.mixHash(ephemeralPublic);
  symmetric.mixKey(ephemeralPublic);
  return concat(ephemeralPublic, must(symmetric.encryptAndHash(EMPTY), "encrypt"));
}

async function failureVectors(): Promise<Failure[]> {
  const session = sessionPrologue(HUB_IDENTITY);
  const link = linkPrologue("link");
  const restore = linkPrologue("restore");
  const psk = secretPsk(sha256, SECRETS.qr);
  const wrongPsk = secretPsk(sha256, fixed("secret-wrong").slice(0, 16));
  const restorePsk = secretPsk(sha256, SECRETS.restore);
  const hubE = keyPair("failure/hub-ephemeral");
  const hubE2 = keyPair("failure/hub-ephemeral-2");
  const clientE = keyPair("failure/client-ephemeral");
  const hub: HandshakeSide = { staticKey: staticOf(HUB), ephemeral: hubE };
  const browser: HandshakeSide = { staticKey: staticOf(BROWSER), ephemeral: clientE };
  const browserIk: HandshakeSide = { ...browser, remoteStatic: HUB.publicKey };
  const out: Failure[] = [];
  const hubSide = { side: "responder", staticKey: HUB, ephemeral: hubE } as const;
  const clientSide = { side: "initiator", staticKey: BROWSER, ephemeral: clientE } as const;

  // A wrong pre-shared key, and a hub that does not know the pre-shared key.
  const wrong = await emptyHandshake(XX, link, wrongPsk, browser, hub);
  out.push({
    name: "link: message 3 sealed with another pre-shared key",
    pattern: XX,
    ...hubSide,
    prologue: link,
    psk,
    messages: [message(wrong, 0), message(wrong, 2)],
    expect: "decryptFailed",
  });
  // Message 2 does not depend on the pre-shared key, and the keys after message 3 depend only on
  // the key, so a run where both sides hold the wrong key gives exactly the impostor's message 4.
  const linkResult = await honest(
    XX,
    link,
    wrongPsk,
    browser,
    hub,
    [EMPTY, EMPTY, EMPTY],
    [{ from: "responder", plaintext: json({ client: 7, person: 2 }) }],
  );
  out.push({
    name: "link: message 4 from a hub that does not know the pre-shared key (the client sends nothing secret before it decrypts)",
    pattern: XX,
    ...clientSide,
    prologue: link,
    psk,
    remoteStatic: HUB.publicKey,
    messages: [message(linkResult, 1), transportMessage(linkResult, 0)],
    expect: "decryptFailed",
  });
  const restoreImpostor = await honest(
    XX,
    restore,
    wrongPsk,
    { staticKey: staticOf(PHONE), ephemeral: clientE },
    hub,
    [EMPTY, EMPTY, EMPTY],
    [{ from: "responder", plaintext: json({ identity: HUB_IDENTITY_TEXT, epoch: 3 }) }],
  );
  out.push({
    name: "restore: message 4 (the offer) from a hub that does not know the pre-shared key; the phone never sends the backup key",
    pattern: XX,
    side: "initiator",
    staticKey: PHONE,
    ephemeral: clientE,
    prologue: restore,
    psk: restorePsk,
    remoteStatic: HUB.publicKey,
    messages: [message(restoreImpostor, 1), transportMessage(restoreImpostor, 0)],
    expect: "decryptFailed",
  });

  // A hub key that does not match the identity the QR code or link address carries.
  for (const [purpose, prologue, key] of [
    ["link", link, psk],
    ["restore", restore, restorePsk],
  ] as const) {
    const other = await emptyHandshake(XX, prologue, key, browser, {
      staticKey: staticOf(OTHER_HUB),
      ephemeral: hubE,
    });
    out.push({
      name: `${purpose}: message 2 carries a hub key that does not hash to the identity given (remoteStatic is the hub key the code names)`,
      pattern: XX,
      ...clientSide,
      prologue,
      psk: key,
      remoteStatic: HUB.publicKey,
      messages: [message(other, 1)],
      expect: "identityMismatch",
    });
  }
  const wrongHub = await firstMessage(IK, session, undefined, {
    ...browser,
    remoteStatic: OTHER_HUB.publicKey,
  });
  out.push({
    name: "session: message 1 made for another hub's static key",
    pattern: IK,
    ...hubSide,
    prologue: session,
    messages: [wrongHub],
    expect: "decryptFailed",
  });

  // A prologue of another purpose, or of another version.
  const otherPrologues: readonly [string, NoisePattern, Uint8Array, Uint8Array, Uint8Array?][] = [
    ["session: message 1 made with the link prologue", IK, session, link],
    [
      "session: message 1 made with version 2's prologue (hsn-session/2)",
      IK,
      session,
      concat(label("hsn-session/2"), HUB_IDENTITY),
    ],
    [
      "session: message 1 made with another hub's identity in the prologue",
      IK,
      session,
      sessionPrologue(appIdentityBytes(sha256, OTHER_HUB.publicKey)),
    ],
    ["link: message 1 made with the restore prologue", XX, link, restore, psk],
    ["restore: message 1 made with the link prologue", XX, restore, link, restorePsk],
    [
      "link: message 1 made with version 2's prologue (hsn-link/2)",
      XX,
      link,
      label("hsn-link/2"),
      psk,
    ],
  ];
  for (const [name, pattern, prologue, theirs, key] of otherPrologues) {
    out.push({
      name,
      pattern,
      ...hubSide,
      prologue,
      ...(key === undefined ? {} : { psk: key }),
      messages: [await firstMessage(pattern, theirs, key, pattern === IK ? browserIk : browser)],
      expect: "decryptFailed",
    });
  }

  // A replayed message 1, and transport messages out of order.
  const original = await emptyHandshake(IK, session, undefined, browserIk, hub);
  out.push({
    name: "session: a replayed message 1 draws a message 2 nobody can answer: the recorded first transport message fails under the new hub ephemeral",
    pattern: IK,
    side: "responder",
    staticKey: HUB,
    ephemeral: hubE2,
    prologue: session,
    messages: [message(original, 0), transportMessage(original, 0)],
    expect: "decryptFailed",
  });
  for (const [name, order] of [
    ["session: a transport message skipped (0, then 2)", [0, 2]],
    ["session: a transport message repeated (0, then 0)", [0, 0]],
    ["session: transport messages swapped (1 before 0)", [1]],
  ] as const) {
    out.push({
      name,
      pattern: IK,
      ...hubSide,
      prologue: session,
      messages: [message(original, 0), ...order.map((i) => transportMessage(original, i))],
      expect: "decryptFailed",
    });
  }
  const flipped = transportMessage(original, 0).slice();
  flipped[0] = (flipped[0] ?? 0) ^ 0x01;
  out.push({
    name: "session: a transport message with one bit changed",
    pattern: IK,
    ...hubSide,
    prologue: session,
    messages: [message(original, 0), flipped],
    expect: "decryptFailed",
  });

  // Low-order public keys: every DH with one is all zero, and ends the handshake.
  for (const [pointName, point] of LOW_ORDER_POINTS) {
    out.push({
      name: `session: message 1's ephemeral is ${pointName} (es)`,
      pattern: IK,
      ...hubSide,
      prologue: session,
      messages: [concat(point, new Uint8Array(48 + 16))],
      expect: "allZeroDh",
    });
  }
  for (const [pointName, point] of LOW_ORDER_POINTS.slice(0, 3)) {
    out.push({
      name: `session: message 2's ephemeral is ${pointName} (ee)`,
      pattern: IK,
      ...clientSide,
      prologue: session,
      remoteStatic: HUB.publicKey,
      messages: [concat(point, new Uint8Array(16))],
      expect: "allZeroDh",
    });
    out.push({
      name: `link: message 2's ephemeral is ${pointName} (ee)`,
      pattern: XX,
      ...clientSide,
      prologue: link,
      psk,
      messages: [concat(point, new Uint8Array(48 + 16))],
      expect: "allZeroDh",
    });
    out.push({
      name: `link: message 1's ephemeral is ${pointName}; the hub refuses as it writes message 2 (ee)`,
      pattern: XX,
      ...hubSide,
      prologue: link,
      psk,
      messages: [xxFirstMessageWith(link, point)],
      expect: "allZeroDh",
    });
  }
  for (const [pointName, point] of [LOW_ORDER_POINTS[0], LOW_ORDER_POINTS[2]].filter(
    (p) => p !== undefined,
  )) {
    const attacker = lowOrderStatic(point);
    const ik = await firstMessage(IK, session, undefined, {
      staticKey: attacker,
      ephemeral: clientE,
      remoteStatic: HUB.publicKey,
    });
    out.push({
      name: `session: message 1's static key is ${pointName} (ss)`,
      pattern: IK,
      ...hubSide,
      prologue: session,
      messages: [ik],
      expect: "allZeroDh",
    });
    const m2 = await partial(XX, link, psk, browser, { staticKey: attacker, ephemeral: hubE }, 2);
    out.push({
      name: `link: message 2's static key is ${pointName} (es)`,
      pattern: XX,
      ...clientSide,
      prologue: link,
      psk,
      messages: [m2],
      expect: "allZeroDh",
    });
    const m3 = await partial(XX, link, psk, { staticKey: attacker, ephemeral: clientE }, hub, 3);
    out.push({
      name: `link: message 3's static key is ${pointName} (se)`,
      pattern: XX,
      ...hubSide,
      prologue: link,
      psk,
      messages: [
        await firstMessage(XX, link, psk, { staticKey: attacker, ephemeral: clientE }),
        m3,
      ],
      expect: "allZeroDh",
    });
  }

  // Messages of the wrong size.
  const m1 = message(original, 0);
  out.push(
    {
      name: "session: message 1 one byte short of its shortest (96 bytes)",
      pattern: IK,
      ...hubSide,
      prologue: session,
      messages: [m1.slice(0, 95)],
      expect: "badMessage",
    },
    {
      name: "link: message 1 one byte short of its shortest (48 bytes)",
      pattern: XX,
      ...hubSide,
      prologue: link,
      psk,
      messages: [message(wrong, 0).slice(0, 47)],
      expect: "badMessage",
    },
    {
      name: "session: message 1 shorter than its ephemeral key (20 bytes)",
      pattern: IK,
      ...hubSide,
      prologue: session,
      messages: [m1.slice(0, 20)],
      expect: "badMessage",
    },
    {
      name: "link: message 3 shorter than its encrypted static key (47 bytes)",
      pattern: XX,
      ...hubSide,
      prologue: link,
      psk,
      messages: [message(wrong, 0), message(wrong, 2).slice(0, 47)],
      expect: "badMessage",
    },
    {
      name: "session: a transport message shorter than its tag",
      pattern: IK,
      ...hubSide,
      prologue: session,
      messages: [m1, transportMessage(original, 0).slice(0, 15)],
      expect: "badMessage",
    },
    {
      name: "session: message 1 of 65,536 bytes",
      pattern: IK,
      ...hubSide,
      prologue: session,
      messages: [concat(m1, new Uint8Array(65_536 - m1.length))],
      expect: "tooLong",
    },
    {
      name: "session: a transport message of 65,536 bytes",
      pattern: IK,
      ...hubSide,
      prologue: session,
      messages: [m1, new Uint8Array(65_536)],
      expect: "tooLong",
    },
  );
  return out;
}

/**
 * Message `upTo` (1-based) of a handshake in which each side writes the empty payload, as the
 * attacker side makes it: the other side is honest up to the message before.
 */
async function partial(
  pattern: NoisePattern,
  prologue: Uint8Array,
  psk: Uint8Array | undefined,
  initiatorSide: HandshakeSide,
  responderSide: HandshakeSide,
  upTo: number,
): Promise<Uint8Array> {
  const initiator = await start(pattern, true, prologue, initiatorSide, psk);
  const responder = await start(pattern, false, prologue, responderSide, psk);
  let last: Uint8Array = EMPTY;
  for (let i = 0; i < upTo; i++) {
    const [writer, reader] = i % 2 === 0 ? [initiator, responder] : [responder, initiator];
    last = must(await writer.writeMessage(EMPTY), "write");
    if (i < upTo - 1) await afterRead(reader, last, i, psk);
  }
  return last;
}

function failureJson(f: Failure) {
  return {
    name: f.name,
    pattern: f.pattern,
    side: f.side,
    prologue: toHex(f.prologue),
    ...(f.psk === undefined ? {} : { psk: toHex(f.psk) }),
    staticKey: pairJson(f.staticKey),
    ephemeral: pairJson(f.ephemeral),
    ...(f.remoteStatic === undefined ? {} : { remoteStatic: toHex(f.remoteStatic) }),
    messages: f.messages.map(toHex),
    expect: f.expect,
  };
}

// ----- app-typed-code.json and app-link-secrets.json -----

interface TypedPlan {
  readonly tokenId: number;
  readonly secret: bigint;
}

/** A value whose check symbol is one of Crockford's five extra symbols (32 to 36). */
function extraCheckSymbolCode(): TypedPlan {
  for (let secret = 0x1_2345_6789n; ; secret++) {
    const code = formatTypedCode({ tokenId: 0xabcde, secret }) ?? "";
    if ("*~$=U".includes(code.slice(-1))) return { tokenId: 0xabcde, secret };
  }
}

function typedVariants(code: string): { text: string; valid: boolean }[] {
  const plain = code.replaceAll("-", "");
  const variants = [
    { text: code, valid: true },
    { text: code.toLowerCase(), valid: true },
    { text: plain, valid: true },
    { text: ` ${code.replaceAll("-", " ")} `, valid: true },
  ];
  const lookalike = code.replaceAll("1", "l").replaceAll("0", "O");
  if (lookalike !== code) variants.push({ text: lookalike, valid: true });
  const first = plain.startsWith("7") ? "8" : "7";
  variants.push({ text: first + plain.slice(1), valid: false });
  const at = plain.split("").findIndex((c, i) => i < 10 && c !== plain[i + 1]);
  if (at >= 0) {
    const swapped =
      plain.slice(0, at) + (plain[at + 1] ?? "") + (plain[at] ?? "") + plain.slice(at + 2);
    variants.push({ text: swapped, valid: false });
  }
  variants.push({ text: plain.slice(0, 11), valid: false });
  variants.push({ text: `${plain}0`, valid: false });
  variants.push({ text: `U${plain.slice(1)}`, valid: false });
  return variants;
}

function typedCodeVectors() {
  const plans: TypedPlan[] = [
    TYPED,
    { tokenId: 0, secret: 0n },
    { tokenId: 2 ** 20 - 1, secret: 2n ** 35n - 1n },
    { tokenId: 0x01_010, secret: 0x1_0101_0101n },
    extraCheckSymbolCode(),
  ];
  return plans.map((plan) => {
    const code = formatTypedCode(plan);
    if (code === undefined) throw new Error("a typed code was refused");
    const typed = typedVariants(code);
    for (const t of typed) {
      const parsed = parseTypedCode(t.text);
      const readBack = parsed?.tokenId === plan.tokenId && parsed.secret === plan.secret;
      if (readBack !== t.valid || (!t.valid && parsed !== undefined)) {
        throw new Error(`typed code ${JSON.stringify(t.text)}: not as the vector says`);
      }
    }
    return {
      code,
      tokenId: plan.tokenId,
      secret: toHex(typedSecretBytes(plan.secret)),
      lookup: typedLookup(plan.tokenId),
      psk: toHex(typedPsk(sha256, plan.secret)),
      typed,
    };
  });
}

function linkSecretVectors() {
  return (["qr", "linkAddress", "restore"] as const).map((which) => {
    const secret = SECRETS[which];
    const qr = { identity: HUB_IDENTITY_TEXT, secret, addresses: ADDRESSES, port: LAN_PORT };
    return {
      secret: toHex(secret),
      lookup: secretLookup(sha256, secret),
      psk: toHex(secretPsk(sha256, secret)),
      hubStaticPublic: toHex(HUB.publicKey),
      identity: HUB_IDENTITY_TEXT,
      qr: formatLinkQr(
        { ...qr, fingerprint: FINGERPRINT },
        which === "restore" ? "restore" : "link",
      ),
      linkAddress: formatLinkAddress(ADDRESSES[0] ?? "", LAN_PORT, HUB_IDENTITY_TEXT, secret),
    };
  });
}

// ----- app-backup.json -----

function database(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  out.set(encoder.encode("SQLite format 3\0").subarray(0, bytes));
  for (let i = 16; i < bytes; i++) out[i] = (i * 31 + (i >>> 8)) & 0xff;
  return out;
}

const CHUNK = BACKUP_FORMAT.chunkBytes + 16;
const HEADER = BACKUP_FORMAT.headerBytes;

function edited(file: Uint8Array, at: number, value: number): Uint8Array {
  const out = file.slice();
  out[at] = value;
  return out;
}

function xored(file: Uint8Array, at: number): Uint8Array {
  return edited(file, at, (file[at] ?? 0) ^ 0x01);
}

function chunkOf(file: Uint8Array, i: number): Uint8Array {
  return file.subarray(HEADER + i * CHUNK, HEADER + (i + 1) * CHUNK);
}

function backupVectors() {
  const header = (flags: number, salt: string): BackupHeader => ({
    format: 1,
    flags,
    identity: HUB_IDENTITY,
    epoch: BACKUP_EPOCH,
    madeMs: 1_794_096_000_000,
    schema: 2,
    salt: fixed(salt).slice(0, 8),
    lastChangeMs: 1_794_009_600_000,
  });
  const make = (
    name: string,
    h: BackupHeader,
    db: Uint8Array,
    tamper: (file: Uint8Array) => { file: Uint8Array; expect: string }[],
  ) => {
    const file = must(backupCodec.seal(BACKUP_KEY, h, db), "seal");
    return {
      name,
      backupKey: toHex(BACKUP_KEY),
      header: toHex(must(encodeBackupHeader(h), "header")),
      database: toHex(db),
      file: toHex(file),
      tamper: tamper(file).map((t) => ({ file: toHex(t.file), expect: t.expect })),
    };
  };
  return [
    make("one chunk of 300 bytes", header(0, "salt-1"), database(300), (file) => [
      { file: edited(file, 3, 0x43), expect: "badMagic" },
      { file: edited(file, 4, 2), expect: "badFormat" },
      { file: edited(file, 5, 0x02), expect: "badFormat" },
      { file: edited(file, 5, 0x80), expect: "badFormat" },
      { file: edited(file, 54, 1), expect: "badFormat" },
      { file: edited(file, 63, 1), expect: "badFormat" },
      { file: edited(file, 33, 1), expect: "badFormat" },
      { file: edited(file, 53, 1), expect: "badFormat" },
      { file: file.slice(0, 40), expect: "truncated" },
      { file: file.slice(0, HEADER), expect: "truncated" },
      { file: file.slice(0, HEADER + 15), expect: "truncated" },
      { file: xored(file, 5), expect: "badFormat" },
      { file: xored(file, 6), expect: "decryptFailed" },
      { file: xored(file, 22), expect: "decryptFailed" },
      { file: xored(file, 26), expect: "decryptFailed" },
      { file: xored(file, 34), expect: "decryptFailed" },
      { file: xored(file, 38), expect: "decryptFailed" },
      { file: xored(file, 46), expect: "decryptFailed" },
      { file: xored(file, HEADER), expect: "decryptFailed" },
      { file: xored(file, file.length - 1), expect: "decryptFailed" },
      { file: concat(file, Uint8Array.of(0)), expect: "decryptFailed" },
      { file: file.slice(0, file.length - 1), expect: "decryptFailed" },
    ]),
    make("an empty database: one empty chunk", header(0, "salt-2"), database(0), (file) => [
      { file: file.slice(0, HEADER), expect: "truncated" },
      { file: xored(file, HEADER + 3), expect: "decryptFailed" },
    ]),
    make(
      "exactly one full chunk (64 KiB): no empty chunk after it",
      header(0, "salt-3"),
      database(BACKUP_FORMAT.chunkBytes),
      (file) => [{ file: concat(file, new Uint8Array(16)), expect: "decryptFailed" }],
    ),
    make(
      "three chunks",
      header(0, "salt-4"),
      database(2 * BACKUP_FORMAT.chunkBytes + 1000),
      (file) => {
        const h = file.subarray(0, HEADER);
        const [c0, c1, c2] = [chunkOf(file, 0), chunkOf(file, 1), chunkOf(file, 2)];
        return [
          { file: concat(h, c1, c0, c2), expect: "decryptFailed" },
          { file: concat(h, c0, c1), expect: "cut" },
          { file: concat(h, c0), expect: "cut" },
          { file: concat(h, c0, c2), expect: "decryptFailed" },
          { file: concat(h, c0, c1, c2, c2), expect: "decryptFailed" },
          { file: file.slice(0, HEADER + CHUNK + 1000), expect: "decryptFailed" },
          { file: file.slice(0, HEADER + 2 * CHUNK + 10), expect: "truncated" },
          { file: edited(file, 5, 1), expect: "badFormat" },
        ];
      },
    ),
  ];
}

// ----- The files -----

function file(description: string, vectors: readonly unknown[]): string {
  return `${JSON.stringify({ description, vectors }, null, 2)}\n`;
}

const NOISE_DESCRIPTION =
  "Every handshake of the app channel (docs/m2-design.md sections 5 and 10) with fixed keys, as exact bytes: Noise_IK_25519_ChaChaPoly_SHA256 for sessions, Noise_XXpsk3_25519_ChaChaPoly_SHA256 for linking and restore. Run both sides from the keys and the prologue (the IK initiator is given the responder's static public key; the XXpsk3 initiator is given psk at the start, the responder by setPsk right after it reads message 1): writing each payload must give exactly `message`, reading `message` must give `payload`, both sides must end with `handshakeHash`, and after the split each `plaintext` must encrypt to exactly `message` and decrypt back, in the order listed (each direction has its own nonce). Payloads are the UTF-8 JSON of packages/protocol/src/app/handshake.ts and envelope.ts. A link or restore vector's psk and its LinkHello `find` are those of an entry of app-link-secrets.json (QR code, link address, restore) or app-typed-code.json (typed code).";

const FAILURE_DESCRIPTION =
  "Handshakes and sessions that must be refused (docs/m2-design.md sections 5 and 10). Start one handshake on `side` with `pattern`, `prologue`, `staticKey`, `ephemeral` (as the fixed ephemeral), `psk` (an XXpsk3 responder takes it by setPsk right after it reads message 1), and `remoteStatic` only when `side` is an IK initiator. Then: whenever it is the side's turn to write a handshake message, it writes one with the empty payload (also first, for an initiator, and after the last given message); it reads the given `messages` in order, handshake messages until the handshake completes, then it splits and decrypts the rest as transport messages. Every step must succeed until the last given message: reading it, or the write that follows it, must fail with `expect`, and the side must then refuse any further call. `identityMismatch` is the client's own check, not Noise's: for an XXpsk3 initiator, `remoteStatic` is the hub key whose identity the QR code or link address names (16 bytes of SHA-256, section 5), and after reading the message that carries the hub's static key, that key's identity must equal it. Low-order public keys are u = 0, 1, the two points of order 8, p − 1, p, p + 1 and 2^255 (each X25519 with them is all zero).";

const TYPED_DESCRIPTION =
  "Typed linking codes (docs/m2-design.md section 5): 12 characters of Crockford base32 shown as XXXX-XXXX-XXXX, the 20-bit token id (4 characters), the 35-bit secret (7 characters) and a check character (the 55-bit value mod 37, Crockford's symbols, 32 to 36 being * ~ $ = U). `secret` is the 35 bits as 5 bytes big-endian, `lookup` the token id's 4 characters (LinkHello's `find`), `psk` SHA-256 of the ASCII bytes hsn-link/1, a zero byte, and the 5 bytes. Each of `typed` is what a person might type: `valid` ones (case, spaces and dashes, I and L for 1, O for 0 forgiven) must read back to this token id and secret; the others must be refused, never read as another code.";

const SECRETS_DESCRIPTION =
  "128-bit link and restore secrets (docs/m2-design.md sections 5 and 9): `lookup` is the first 4 bytes of SHA-256 of the ASCII bytes hsn-find/1, a zero byte and the secret, as 8 hex digits; `psk` SHA-256 of hsn-link/1, a zero byte and the secret (restore's are made as linking's); `identity` the first 16 bytes of SHA-256 of `hubStaticPublic` as 26 characters of lower-case base32 without padding; `qr` the token's QR code (hsn://link/1, or hsn://restore/1 for the restore token, with addresses 192.168.1.20 and fd00::20, port 8444 and a fixed certificate fingerprint); `linkAddress` the link address the same secret makes on 192.168.1.20 (only link tokens are ever sent as one).";

const BACKUP_DESCRIPTION =
  "Backup files (docs/m2-design.md section 9): a 64-byte header (integers little-endian), then the database in chunks of 64 KiB (the last holds the rest, 0 to 64 KiB), each sealed with ChaCha20-Poly1305 under HKDF-SHA256(ikm = backupKey, salt = the header's 8-byte salt, info = the ASCII text hsn-backup/1, 32 bytes); chunk i's nonce is four zero bytes then i as 8 bytes big-endian, its associated data the header and one byte, 1 on the last chunk and 0 on the others. Sealing `database` under `header` with `backupKey` must give exactly `file`; opening `file` must give `database`. Each `tamper` file must be refused with `expect`: badMagic, badFormat (format, an unknown flag bit, a nonzero reserved byte, a time past 2^53 − 1), truncated (shorter than the header, or no whole tag after it), decryptFailed (any change the tags catch, chunks reordered, dropped or added), cut (the file ends where a chunk that is not the last ends).";

/** Every app vector file, as its text. */
export async function appVectorFiles(): Promise<ReadonlyMap<string, string>> {
  return new Map([
    ["app-noise.json", file(NOISE_DESCRIPTION, await noiseVectors())],
    [
      "app-noise-failures.json",
      file(FAILURE_DESCRIPTION, (await failureVectors()).map(failureJson)),
    ],
    ["app-typed-code.json", file(TYPED_DESCRIPTION, typedCodeVectors())],
    ["app-link-secrets.json", file(SECRETS_DESCRIPTION, linkSecretVectors())],
    ["app-backup.json", file(BACKUP_DESCRIPTION, backupVectors())],
  ]);
}

if (import.meta.main) {
  const files = await appVectorFiles();
  for (const [name, text] of files) writeFileSync(join(APP_VECTOR_DIRECTORY, name), text);
  console.log(`wrote ${files.size} app vector files to ${APP_VECTOR_DIRECTORY}`);
}

/**
 * Writes the relay's vectors, `packages/protocol/vectors/relay-*.json` (docs/m4-design.md section
 * 11), in the formats `../vector-formats.ts` freezes: the XN handshakes of the hub link and the
 * relay link and those that must fail, sealed pushes as exact bytes and `h` strings that must not
 * open, and the links' text and binary frames. Fixed keys and values only, no randomness, no clock:
 * `relay-vectors.test.ts` fails if a committed file differs from what this writes. Run
 * `bun packages/protocol/src/relay/vectors/relay-vectors.ts` to write them.
 *
 * Honest handshakes and seals are made by the package's own code (`noise.ts`, checked against the
 * published XN vectors; `seal.ts`); what no honest side would send (low-order keys, bad padding,
 * altered bytes) is made by hand. `packages/protocol/verify/verify-relay-vectors.mjs` rebuilds all
 * of it with Node's own cryptography, without this code.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex } from "../../bytes.ts";
import type { Handshake, StaticKey } from "../../app/noise-interface.ts";
import { startHandshake, x25519StaticKey } from "../../app/noise.ts";
import { NOISE_PATTERNS } from "../../app/noise-interface.ts";
import { LOW_ORDER_POINTS } from "../../app/vectors/app-vectors.ts";
import { RELAY_CLOSE, RELAY_LIMITS } from "../constants.ts";
import {
  encodeRelayHello,
  encodeRelayJoin,
  encodeRelayPeerHello,
  encodeRelayWelcome,
  NO_STATIC_KEY,
  relayCloseReconnect,
  relayIdentity,
  relayLinkPrologue,
  type RelayLinkKind,
  startRelayInitiator,
  startRelayResponder,
} from "../link-handshake.ts";
import { type PushContent, pushContentBytes, type PushKey } from "../push.ts";
import { pushAad, pushSealer, relayAlertContent, toBase64url } from "../seal.ts";
import { type CompactValue, RELAY_VECTOR_FILES } from "../vector-formats.ts";
import { compactRuns } from "./compact.ts";

export const RELAY_VECTOR_DIRECTORY = join(import.meta.dir, "..", "..", "..", "vectors");

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

// ----- Fixed keys and values -----

interface KeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** A fixed 32-byte value: SHA-256 of `hsn-vector/<name>`, as the app's vectors make theirs. */
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

function must<T>(result: { ok: true; value: T } | { ok: false; error: string }, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${result.error}`);
  return result.value;
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

function flipped(bytes: Uint8Array, at: number, mask = 0x01): Uint8Array {
  const out = bytes.slice();
  out[at] = (out[at] ?? 0) ^ mask;
  return out;
}

const pairJson = (pair: KeyPair) => ({
  private: toHex(pair.privateKey),
  public: toHex(pair.publicKey),
});

/** The hub's app static key: the same as the app vectors' hub (QR2: one key for IK and XN). */
const HUB = keyPair("hub-static");
const OTHER_HUB = keyPair("other-hub-static");
/** A self-hosted relay's own static key, for its link to the push service (D142). */
const RELAY = keyPair("relay-static");
const HUB_EPHEMERAL = keyPair("relay-xn/hub-ephemeral");
const HUB_EPHEMERAL_2 = keyPair("relay-xn/hub-ephemeral-2");
const RELAY_EPHEMERAL = keyPair("relay-xn/relay-ephemeral");
const RELAY_EPHEMERAL_2 = keyPair("relay-xn/relay-ephemeral-2");
const PEER_EPHEMERAL = keyPair("relay-xn/relay-link-initiator-ephemeral");
const PUSH_EPHEMERAL = keyPair("relay-xn/push-service-ephemeral");
const HUB_IDENTITY = relayIdentity(HUB.publicKey) ?? "";

const VERSION = "0.4.0";
const WELCOME_LIMITS = {
  maxRosterBytes: RELAY_LIMITS.maxRosterBytes,
  maxPushItemsPerFrame: RELAY_LIMITS.maxPushItemsPerFrame,
  maxReleasePieceBytes: RELAY_LIMITS.maxReleasePieceBytes,
  maxRestartWithinMs: RELAY_LIMITS.maxRestartWithinMs,
} as const;

// ----- relay-xn.json -----

type From = "initiator" | "responder";

interface XnRun {
  readonly messages: readonly { from: From; payload: Uint8Array; message: Uint8Array }[];
  readonly handshakeHash: Uint8Array;
  readonly transport: readonly { from: From; plaintext: Uint8Array; message: Uint8Array }[];
}

/** An XN handshake between two sides, then transport messages. */
async function xnRun(
  initiator: Handshake,
  responder: Handshake,
  payloads: readonly Uint8Array[],
  transport: readonly { from: From; plaintext: Uint8Array }[],
): Promise<XnRun> {
  const messages: { from: From; payload: Uint8Array; message: Uint8Array }[] = [];
  for (const [i, payload] of payloads.entries()) {
    const from: From = i % 2 === 0 ? "initiator" : "responder";
    const [writer, reader] = from === "initiator" ? [initiator, responder] : [responder, initiator];
    const message = must(await writer.writeMessage(payload), "write");
    must(await reader.readMessage(message), "read");
    messages.push({ from, payload, message });
  }
  if (!initiator.complete || !responder.complete) throw new Error("an XN run did not complete");
  const handshakeHash = initiator.handshakeHash();
  const sessions = {
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

const initiatorOf = (link: RelayLinkKind, key: StaticKey, ephemeral: KeyPair) =>
  must(startRelayInitiator(link, key, ephemeral), "start initiator");
const responderOf = (link: RelayLinkKind, ephemeral: KeyPair) =>
  must(startRelayResponder(link, ephemeral), "start responder");

interface XnPlan {
  readonly name: string;
  readonly link: RelayLinkKind;
  readonly initiator: KeyPair;
  readonly initiatorEphemeral: KeyPair;
  readonly responderEphemeral: KeyPair;
  readonly payloads: readonly [Uint8Array, Uint8Array, Uint8Array];
}

function xnPlans(): readonly XnPlan[] {
  const join = must(encodeRelayJoin({}), "join");
  return [
    {
      name: "hub link: a hub joins its relay",
      link: "hub",
      initiator: HUB,
      initiatorEphemeral: HUB_EPHEMERAL,
      responderEphemeral: RELAY_EPHEMERAL,
      payloads: [
        must(encodeRelayHello({ proto: [1, 1], hub: VERSION }), "hello"),
        must(
          encodeRelayWelcome({
            proto: 1,
            relay: VERSION,
            roles: ["relay", "releases"],
            limits: WELCOME_LIMITS,
          }),
          "welcome",
        ),
        join,
      ],
    },
    {
      name: "hub link: a newer hub (versions 1 to 3) joins a relay that speaks 1",
      link: "hub",
      initiator: HUB,
      initiatorEphemeral: HUB_EPHEMERAL_2,
      responderEphemeral: RELAY_EPHEMERAL_2,
      payloads: [
        must(encodeRelayHello({ proto: [1, 3], hub: "2.10.0" }), "hello"),
        must(
          encodeRelayWelcome({
            proto: 1,
            relay: VERSION,
            roles: ["relay", "push", "names", "releases"],
            limits: WELCOME_LIMITS,
          }),
          "welcome",
        ),
        join,
      ],
    },
    {
      name: "relay link: a self-hosted relay joins the push service",
      link: "relay",
      initiator: RELAY,
      initiatorEphemeral: PEER_EPHEMERAL,
      responderEphemeral: PUSH_EPHEMERAL,
      payloads: [
        must(encodeRelayPeerHello({ proto: [1, 1], relay: VERSION }), "peer hello"),
        must(
          encodeRelayWelcome({
            proto: 1,
            relay: VERSION,
            roles: ["push", "releases"],
            limits: WELCOME_LIMITS,
          }),
          "welcome",
        ),
        join,
      ],
    },
  ];
}

async function xnVectors() {
  const out = [];
  for (const plan of xnPlans()) {
    const run = await xnRun(
      initiatorOf(plan.link, staticOf(plan.initiator), plan.initiatorEphemeral),
      responderOf(plan.link, plan.responderEphemeral),
      plan.payloads,
      [
        { from: "initiator", plaintext: encoder.encode("transport, initiator to responder") },
        { from: "responder", plaintext: encoder.encode("transport, responder to initiator") },
        { from: "initiator", plaintext: EMPTY },
      ],
    );
    out.push({
      name: plan.name,
      pattern: NOISE_PATTERNS.relay,
      link: plan.link,
      prologue: toHex(relayLinkPrologue(plan.link)),
      initiator: { static: pairJson(plan.initiator), ephemeral: pairJson(plan.initiatorEphemeral) },
      responder: { ephemeral: pairJson(plan.responderEphemeral) },
      messages: run.messages.map((m) => ({
        from: m.from,
        payload: toHex(m.payload),
        message: toHex(m.message),
      })),
      handshakeHash: toHex(run.handshakeHash),
      identity: relayIdentity(plan.initiator.publicKey) ?? "",
      transport: run.transport.map((m) => ({
        from: m.from,
        plaintext: toHex(m.plaintext),
        message: toHex(m.message),
      })),
    });
  }
  return out;
}

/** The three messages with empty payloads, as the failure vectors' harness writes them. */
async function emptyRun(
  link: RelayLinkKind,
  initiatorKey: StaticKey,
  initiatorEphemeral: KeyPair,
  responderEphemeral: KeyPair,
): Promise<readonly [Uint8Array, Uint8Array, Uint8Array]> {
  const run = await xnRun(
    initiatorOf(link, initiatorKey, initiatorEphemeral),
    responderOf(link, responderEphemeral),
    [EMPTY, EMPTY, EMPTY],
    [],
  );
  const [m1, m2, m3] = run.messages.map((m) => m.message);
  if (m1 === undefined || m2 === undefined || m3 === undefined) throw new Error("short run");
  return [m1, m2, m3];
}

/**
 * The three messages as the initiator writes them, with empty payloads, the responder reading only
 * messages 1 and 2: for an initiator whose message 3 the responder must refuse.
 */
async function initiatorRun(
  link: RelayLinkKind,
  initiatorKey: StaticKey,
): Promise<readonly [Uint8Array, Uint8Array]> {
  const initiator = initiatorOf(link, initiatorKey, HUB_EPHEMERAL);
  const responder = responderOf(link, RELAY_EPHEMERAL);
  const m1 = must(await initiator.writeMessage(EMPTY), "write 1");
  must(await responder.readMessage(m1), "read 1");
  const m2 = must(await responder.writeMessage(EMPTY), "write 2");
  must(await initiator.readMessage(m2), "read 2");
  const m3 = must(await initiator.writeMessage(EMPTY), "write 3");
  return [m1, m3];
}

/** A responder's message 2 (empty payload) after it reads `message1` with `prologue`. */
async function message2After(
  prologue: Uint8Array,
  message1: Uint8Array,
  ephemeral: KeyPair,
): Promise<Uint8Array> {
  const responder = must(
    startHandshake({
      pattern: NOISE_PATTERNS.relay,
      initiator: false,
      prologue,
      staticKey: NO_STATIC_KEY,
      ephemeral,
    }),
    "start",
  );
  must(await responder.readMessage(message1), "read message 1");
  return must(await responder.writeMessage(EMPTY), "write message 2");
}

/** A static key whose public key is not the one its Diffie-Hellman uses. */
function claimedStatic(claimed: Uint8Array, held: KeyPair): StaticKey {
  return {
    publicKey: claimed,
    dh: (theirPublic: Uint8Array) =>
      Promise.resolve(x25519.getSharedSecret(held.privateKey, theirPublic)),
  };
}

/** A low-order static key as an attacker holds it: its own Diffie-Hellman is anything. */
function lowOrderStatic(publicKey: Uint8Array): StaticKey {
  return { publicKey, dh: () => Promise.resolve(fixed("attacker-dh")) };
}

interface XnFailure {
  readonly name: string;
  readonly side: From;
  readonly link: RelayLinkKind;
  readonly ephemeral: KeyPair;
  readonly messages: readonly Uint8Array[];
  readonly expect: "allZeroDh" | "badMessage" | "decryptFailed" | "wrongState" | "tooLong";
}

async function xnFailures(): Promise<readonly XnFailure[]> {
  const hubKey = staticOf(HUB);
  const [m1, m2, m3] = await emptyRun("hub", hubKey, HUB_EPHEMERAL, RELAY_EPHEMERAL);
  const [p1, , p3] = await emptyRun("relay", staticOf(RELAY), PEER_EPHEMERAL, PUSH_EPHEMERAL);
  const garbageTag = fixed("relay-xn/garbage-tag").slice(0, 16);
  const failures: XnFailure[] = [];
  const responder = (
    name: string,
    messages: readonly Uint8Array[],
    expect: XnFailure["expect"],
    link: RelayLinkKind = "hub",
    ephemeral: KeyPair = RELAY_EPHEMERAL,
  ) => failures.push({ name, side: "responder", link, ephemeral, messages, expect });
  const initiator = (
    name: string,
    messages: readonly Uint8Array[],
    expect: XnFailure["expect"],
    link: RelayLinkKind = "hub",
    ephemeral: KeyPair = HUB_EPHEMERAL,
  ) => failures.push({ name, side: "initiator", link, ephemeral, messages, expect });

  // Replays: message 3 depends on the relay's fresh ephemeral, message 2 on the hub's.
  responder(
    "hub link: message 3 replayed against a new message 2 (another relay ephemeral)",
    [m1, m3],
    "decryptFailed",
    "hub",
    RELAY_EPHEMERAL_2,
  );
  responder(
    "relay link: message 3 replayed against a new message 2",
    [p1, p3],
    "decryptFailed",
    "relay",
    RELAY_EPHEMERAL_2,
  );
  initiator(
    "hub link: message 2 replayed to a hub with a new ephemeral",
    [m2],
    "decryptFailed",
    "hub",
    HUB_EPHEMERAL_2,
  );

  // A wrong static key: message 3 sends one public key, its `se` uses another private key.
  const [w1, w3] = await initiatorRun("hub", claimedStatic(HUB.publicKey, OTHER_HUB));
  responder(
    "hub link: message 3 sends the hub's public key from a side that does not hold its private key",
    [w1, w3],
    "decryptFailed",
  );

  // Wrong prologues: the initiator's message 2 check catches them.
  initiator(
    "hub link: message 2 from a responder using the relay link's prologue (hsn-relay-peer/1)",
    [await message2After(relayLinkPrologue("relay"), m1, RELAY_EPHEMERAL)],
    "decryptFailed",
  );
  initiator(
    "relay link: message 2 from a responder using the hub link's prologue (hsn-relay/1)",
    [await message2After(relayLinkPrologue("hub"), p1, PUSH_EPHEMERAL)],
    "decryptFailed",
    "relay",
    PEER_EPHEMERAL,
  );
  initiator(
    "hub link: message 2 from a responder whose prologue lacks the zero byte",
    [await message2After(encoder.encode("hsn-relay/1"), m1, RELAY_EPHEMERAL)],
    "decryptFailed",
  );
  initiator(
    "hub link: message 2 from a responder that read message 1 with one payload byte added",
    [
      await message2After(
        relayLinkPrologue("hub"),
        concat(m1, Uint8Array.of(0x78)),
        RELAY_EPHEMERAL,
      ),
    ],
    "decryptFailed",
  );

  // Altered bytes.
  initiator(
    "hub link: message 2 with one bit changed in its tag",
    [flipped(m2, m2.length - 1)],
    "decryptFailed",
  );
  initiator(
    "hub link: message 2 with one bit changed in its ephemeral key",
    [flipped(m2, 0, 0x02)],
    "decryptFailed",
  );
  responder(
    "hub link: message 3 with one bit changed in its encrypted static key",
    [m1, flipped(m3, 0)],
    "decryptFailed",
  );
  responder(
    "hub link: message 3 with one bit changed in its tag",
    [m1, flipped(m3, m3.length - 1)],
    "decryptFailed",
  );

  // Low-order keys: every Diffie-Hellman with one is all zero.
  for (const [label, point] of LOW_ORDER_POINTS) {
    responder(
      `hub link: message 1's ephemeral is ${label}; the relay refuses as it writes message 2 (ee)`,
      [point],
      "allZeroDh",
    );
    initiator(
      `hub link: message 2's ephemeral is ${label} (ee)`,
      [concat(point, garbageTag)],
      "allZeroDh",
    );
    const [l1, l3] = await initiatorRun("hub", lowOrderStatic(point));
    responder(`hub link: message 3's static key is ${label} (se)`, [l1, l3], "allZeroDh");
  }

  // Lengths.
  responder(
    "hub link: message 1 shorter than its ephemeral key (31 bytes)",
    [m1.slice(0, 31)],
    "badMessage",
  );
  initiator(
    "hub link: message 2 one byte short of its shortest (47 bytes)",
    [m2.slice(0, 47)],
    "badMessage",
  );
  responder(
    "hub link: message 3 one byte short of its shortest (63 bytes)",
    [m1, m3.slice(0, 63)],
    "badMessage",
  );
  responder(
    "hub link: message 1 of 65,536 bytes",
    [concat(m1, new Uint8Array(65_536 - m1.length))],
    "tooLong",
  );
  initiator(
    "hub link: message 2 of 65,536 bytes",
    [concat(m2, new Uint8Array(65_536 - m2.length))],
    "tooLong",
  );
  return failures;
}

async function xnFailureVectors() {
  return (await xnFailures()).map((f) => ({
    name: f.name,
    pattern: NOISE_PATTERNS.relay,
    side: f.side,
    prologue: toHex(relayLinkPrologue(f.link)),
    ...(f.side === "initiator" ? { staticKey: pairJson(f.link === "hub" ? HUB : RELAY) } : {}),
    ephemeral: pairJson(f.ephemeral),
    messages: f.messages.map(toHex),
    expect: f.expect,
  }));
}

// ----- relay-push.json -----

const PUSH_KEY: PushKey = {
  key: fixed("push-key"),
  keyId: fixed("push-key-id").slice(0, 8),
};
const OTHER_PUSH_KEY = fixed("other-push-key");
const OTHER_KEY_ID = fixed("other-push-key-id").slice(0, 8);
const nonceOf = (name: string) => fixed(`push-nonce/${name}`).slice(0, 12);

const countdown: PushContent = {
  v: 1,
  hub: HUB_IDENTITY,
  n: {
    seq: 4812,
    atMs: 1_763_456_789_012,
    clockOk: true,
    kind: "countdown",
    category: "countdown",
    critical: true,
    device: 7,
    cause: 4810,
  },
  delayed: false,
  names: { device: "Front door", mode: "Away" },
  detail: { seconds: 30 },
  actions: ["disarm"],
  armed: true,
};

/** Content padded with `detail.pad` to exactly `bytes` of UTF-8 JSON. */
function sized(base: PushContent, bytes: number): PushContent {
  const empty: PushContent = { ...base, detail: { ...base.detail, pad: "" } };
  const missing = bytes - pushContentBytes(empty).length;
  if (missing < 0) throw new Error("content already too long");
  const content: PushContent = { ...base, detail: { ...base.detail, pad: "x".repeat(missing) } };
  if (pushContentBytes(content).length !== bytes) throw new Error("could not size content");
  return content;
}

interface SealPlan {
  readonly name: string;
  readonly content: PushContent;
}

function sealPlans(): readonly SealPlan[] {
  const utf8Names: PushContent = {
    ...countdown,
    n: {
      ...countdown.n,
      kind: "doorUnexpected",
      category: "stateUnexpected",
      critical: false,
      seq: 4813,
    },
    names: { device: "Küche – Tür 🚪", person: "José", client: "Ana’s phone", mode: "Nacht" },
    detail: { note: 'a "quoted" word, a back\\slash, a tab\tand 日本語' },
    actions: [],
  };
  return [
    { name: "countdown with Disarm", content: countdown },
    {
      name: "alarm, sent late (delayed)",
      content: {
        ...countdown,
        n: { ...countdown.n, seq: 4815, kind: "alarm", category: "alarm", cause: 4812 },
        delayed: true,
        detail: { sirens: 2, local: false },
      },
    },
    {
      name: "presence offer with Arm away, nothing armed, no detail",
      content: {
        v: 1,
        hub: HUB_IDENTITY,
        n: {
          seq: 5001,
          atMs: 1_763_460_000_000,
          clockOk: false,
          kind: "presenceAwayOffer",
          category: "armDisarm",
          critical: false,
          device: null,
          cause: null,
        },
        delayed: false,
        names: { person: "Ana" },
        actions: ["armAway"],
        armed: false,
      },
    },
    { name: "names and detail in UTF-8 beyond ASCII, with JSON escapes", content: utf8Names },
    {
      name: "a name whose UTF-8 holds the byte 0x80 (À is c3 80): the mark is the last non-zero byte",
      content: { ...countdown, names: { device: "À" }, detail: { values: -12.5, ok: true } },
    },
    {
      name: "the relay's unreachable alert, sealed by the hub, armed",
      content: relayAlertContent("unreachable", HUB_IDENTITY, true),
    },
    {
      name: "the relay's back alert, sealed by the hub, not armed",
      content: relayAlertContent("back", HUB_IDENTITY, false),
    },
    {
      name: "content of 1,279 bytes: the mark is the last byte, no zeros",
      content: sized(utf8Names, 1279),
    },
    { name: "content of 1,278 bytes: the mark, then one zero", content: sized(countdown, 1278) },
    { name: "content of 1,024 bytes", content: sized(countdown, 1024) },
    {
      name: "a name of 64 code points that are 128 UTF-16 units (64 doors, U+1F6AA)",
      content: { ...countdown, names: { device: "🚪".repeat(64) } },
    },
  ];
}

function sealVectors() {
  return sealPlans().map((plan) => {
    const nonce = nonceOf(plan.name);
    const h = must(pushSealer.seal(plan.content, PUSH_KEY, nonce), plan.name);
    const contentJson = pushContentBytes(plan.content);
    const padded = new Uint8Array(1280);
    padded.set(contentJson);
    padded[contentJson.length] = 0x80;
    const sealed = concat(
      nonce,
      chacha20poly1305(PUSH_KEY.key, nonce, pushAad(PUSH_KEY.keyId)).encrypt(padded),
    );
    return {
      name: plan.name,
      key: toHex(PUSH_KEY.key),
      keyId: toHex(PUSH_KEY.keyId),
      nonce: toHex(nonce),
      content: plan.content,
      contentJson: toHex(contentJson),
      aad: toHex(pushAad(PUSH_KEY.keyId)),
      padded: toHex(padded),
      sealed: toHex(sealed),
      h,
    };
  });
}

/** `h` from a 1,280-byte plaintext sealed by hand, with any associated data. */
function sealRaw(
  padded: Uint8Array,
  name: string,
  key: Uint8Array = PUSH_KEY.key,
  keyIdInH: Uint8Array = PUSH_KEY.keyId,
  aad: Uint8Array = pushAad(PUSH_KEY.keyId),
): string {
  if (padded.length !== 1280) throw new Error("not 1,280 bytes");
  const nonce = nonceOf(name);
  const body = concat(nonce, chacha20poly1305(key, nonce, aad).encrypt(padded));
  return `1.${toHex(keyIdInH)}.${toBase64url(body)}`;
}

/** Bytes padded the right way: content, 0x80, zeros. */
function padded(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(1280);
  out.set(content);
  out[content.length] = 0x80;
  return out;
}

type OpenError = "badFormat" | "unknownKey" | "decryptFailed" | "badPadding" | "badContent";

function openVectors() {
  const good = must(pushSealer.seal(countdown, PUSH_KEY, nonceOf("open-base")), "base");
  const [, , body = ""] = good.split(".");
  const keyIdHex = toHex(PUSH_KEY.keyId);
  const content = pushContentBytes(countdown);
  const json = (value: unknown) => encoder.encode(JSON.stringify(value));
  /** Changes the base64url character at `at` to another that changes the bytes. */
  const charChanged = (text: string, at: number) =>
    `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;
  const cases: {
    name: string;
    h: string;
    expect: OpenError;
    key?: Uint8Array;
    keyId?: Uint8Array;
  }[] = [
    // The form: 1.<16 lowercase hex>.<1,744 base64url>, exactly 1,763 characters.
    { name: "empty", h: "", expect: "badFormat" },
    { name: "truncated by one character (1,762)", h: good.slice(0, -1), expect: "badFormat" },
    { name: "truncated to its version and key id", h: `1.${keyIdHex}.`, expect: "badFormat" },
    { name: "oversized by one character (1,764)", h: `${good}A`, expect: "badFormat" },
    { name: "oversized by a newline at the end", h: `${good}\n`, expect: "badFormat" },
    { name: "a space before it", h: ` ${good}`, expect: "badFormat" },
    { name: "version 2", h: `2${good.slice(1)}`, expect: "badFormat" },
    { name: "version 0", h: `0${good.slice(1)}`, expect: "badFormat" },
    { name: "version written 01", h: `01${good.slice(1)}`, expect: "badFormat" },
    {
      name: "key id in upper-case hex",
      h: `1.${keyIdHex.toUpperCase()}.${body}`,
      expect: "badFormat",
    },
    { name: "key id of 15 hex digits", h: `1.${keyIdHex.slice(1)}.${body}A`, expect: "badFormat" },
    {
      name: "base64 with + (not base64url)",
      h: `1.${keyIdHex}.+${body.slice(1)}`,
      expect: "badFormat",
    },
    {
      name: "base64 with / (not base64url)",
      h: `1.${keyIdHex}./${body.slice(1)}`,
      expect: "badFormat",
    },
    {
      name: "a padding = in place of the last character",
      h: `${good.slice(0, -1)}=`,
      expect: "badFormat",
    },
    { name: "colons in place of the dots", h: good.replaceAll(".", ":"), expect: "badFormat" },
    // The key.
    {
      name: "a key id the opener holds no key for",
      h: must(
        pushSealer.seal(countdown, { key: PUSH_KEY.key, keyId: OTHER_KEY_ID }, nonceOf("other id")),
        "other id",
      ),
      expect: "unknownKey",
    },
    {
      name: "the wrong key under the right key id",
      h: good,
      key: OTHER_PUSH_KEY,
      expect: "decryptFailed",
    },
    // The tag.
    {
      name: "one bit changed in the tag (last character)",
      h: charChanged(good, good.length - 1),
      expect: "decryptFailed",
    },
    {
      name: "one character changed in the ciphertext",
      h: charChanged(good, 19 + 16 + 100),
      expect: "decryptFailed",
    },
    {
      name: "one character changed in the nonce",
      h: charChanged(good, 19),
      expect: "decryptFailed",
    },
    {
      name: "the key id in h changed to one whose key is the sealing key: the associated data binds it",
      h: `1.${toHex(OTHER_KEY_ID)}.${body}`,
      key: PUSH_KEY.key,
      keyId: OTHER_KEY_ID,
      expect: "decryptFailed",
    },
    {
      name: "sealed with associated data lacking the zero byte",
      h: sealRaw(
        padded(content),
        "aad without zero",
        PUSH_KEY.key,
        PUSH_KEY.keyId,
        concat(encoder.encode("hsn-push/1"), PUSH_KEY.keyId),
      ),
      expect: "decryptFailed",
    },
    {
      name: "sealed with the label hsn-push/2",
      h: sealRaw(
        padded(content),
        "aad label 2",
        PUSH_KEY.key,
        PUSH_KEY.keyId,
        concat(encoder.encode("hsn-push/2"), Uint8Array.of(0), PUSH_KEY.keyId),
      ),
      expect: "decryptFailed",
    },
    // The padding: the last non-zero byte must be 0x80.
    {
      name: "no mark: the content, then zeros",
      h: sealRaw(concat(content, new Uint8Array(1280 - content.length)), "no mark"),
      expect: "badPadding",
    },
    { name: "all zeros", h: sealRaw(new Uint8Array(1280), "all zeros"), expect: "badPadding" },
    {
      name: "the mark 0x81 in place of 0x80",
      h: sealRaw(flipped(padded(content), content.length), "mark 81"),
      expect: "badPadding",
    },
    {
      name: "a non-zero byte after the mark",
      h: sealRaw(
        (() => {
          const p = padded(content);
          p[content.length + 2] = 0x05;
          return p;
        })(),
        "byte after mark",
      ),
      expect: "badPadding",
    },
    {
      name: "the last byte 0x01",
      h: sealRaw(
        (() => {
          const p = padded(content);
          p[1279] = 0x01;
          return p;
        })(),
        "last byte 1",
      ),
      expect: "badPadding",
    },
    {
      name: "1,280 bytes of content, no room for the mark",
      h: sealRaw(concat(content, encoder.encode("x".repeat(1280 - content.length))), "no room"),
      expect: "badPadding",
    },
    // The content: UTF-8 JSON that PushContent accepts.
    {
      name: "an empty content (the mark first)",
      h: sealRaw(padded(EMPTY), "empty content"),
      expect: "badContent",
    },
    {
      name: "two marks: the content ends in 0x80, which is not UTF-8 JSON",
      h: sealRaw(padded(concat(content, Uint8Array.of(0x80))), "two marks"),
      expect: "badContent",
    },
    {
      name: "not UTF-8",
      h: sealRaw(padded(Uint8Array.of(0x7b, 0xff, 0xfe, 0x7d)), "not utf8"),
      expect: "badContent",
    },
    {
      name: "UTF-8 that is not JSON",
      h: sealRaw(padded(encoder.encode("countdown")), "not json"),
      expect: "badContent",
    },
    { name: "a JSON array", h: sealRaw(padded(json([countdown])), "array"), expect: "badContent" },
    {
      name: "content version 2",
      h: sealRaw(padded(json({ ...countdown, v: 2 })), "v2"),
      expect: "badContent",
    },
    {
      name: "a field PushContent does not name",
      h: sealRaw(padded(json({ ...countdown, class: "critical" })), "extra"),
      expect: "badContent",
    },
    {
      name: "a field missing (armed)",
      h: sealRaw(
        padded(json(Object.fromEntries(Object.entries(countdown).filter(([k]) => k !== "armed")))),
        "missing",
      ),
      expect: "badContent",
    },
    {
      name: "a hub identity of 25 characters",
      h: sealRaw(padded(json({ ...countdown, hub: HUB_IDENTITY.slice(1) })), "short hub"),
      expect: "badContent",
    },
    {
      name: "two actions",
      h: sealRaw(padded(json({ ...countdown, actions: ["disarm", "armAway"] })), "two actions"),
      expect: "badContent",
    },
    {
      name: "a name of 65 characters",
      h: sealRaw(padded(json({ ...countdown, names: { device: "x".repeat(65) } })), "long name"),
      expect: "badContent",
    },
    {
      name: "a name of 65 code points (65 doors, 130 UTF-16 units)",
      h: sealRaw(padded(json({ ...countdown, names: { device: "🚪".repeat(65) } })), "65 doors"),
      expect: "badContent",
    },
  ];
  return cases.map((c) => ({
    name: c.name,
    key: toHex(c.key ?? PUSH_KEY.key),
    keyId: toHex(c.keyId ?? PUSH_KEY.keyId),
    h: c.h,
    expect: c.expect,
  }));
}

// ----- relay-frames.json -----

const IDENTITY = HUB_IDENTITY;
const KEY_ID = toHex(PUSH_KEY.keyId);
const APNS_TOKEN = "a1b2c3d4".repeat(8);
const FCM_TOKEN = "fYw3:APA91bH-example_token-0123456789";

function alertsFor(keyId: Uint8Array) {
  const key: PushKey = { key: PUSH_KEY.key, keyId };
  return {
    unreachable: must(
      pushSealer.seal(
        relayAlertContent("unreachable", IDENTITY, true),
        key,
        nonceOf("roster unreachable"),
      ),
      "alert",
    ),
    back: must(
      pushSealer.seal(relayAlertContent("back", IDENTITY, true), key, nonceOf("roster back")),
      "alert",
    ),
  };
}

const ALERTS = alertsFor(PUSH_KEY.keyId);
const H = ALERTS.unreachable;

const hubOffer = {
  kind: "hub",
  version: "0.5.0",
  platform: "linux-arm64",
  file: "hsn-hub-0.5.0-linux-arm64.hsnr",
  bytes: 112_000_000,
  sha256: toHex(fixed("release-hub")),
};
const firmwareOffer = {
  kind: "firmware",
  version: "1.4.0",
  target: "esp32s3",
  roles: [1, 2, 3],
  file: "hsn-firmware-1.4.0.hsnf",
  bytes: 1_500_000,
  sha256: toHex(fixed("release-firmware")),
};

/**
 * An `h` of the right form that opens to nothing: what the frames' schemas check is the form, and
 * its run of `A`s lets the largest frames be written compactly (`compactRuns`).
 */
const FORM_H = `1.${KEY_ID}.${"A".repeat(1744)}`;

function target(i: number, token: string, h: { unreachable: string; back: string } = ALERTS) {
  return {
    key: toHex(sha256(Uint8Array.of(i)).slice(0, 8)),
    platform: "fcm",
    env: "production",
    token,
    unreachable: h.unreachable,
    back: h.back,
  };
}

const FORM_ALERTS = { unreachable: FORM_H, back: FORM_H };

/** A roster whose text is exactly `bytes` long (all ASCII), from FCM targets with long tokens. */
function rosterOfBytes(bytes: number): string {
  const targets = [target(0, "t".repeat(4096), FORM_ALERTS)];
  const textOf = () => JSON.stringify({ t: "roster", rev: 9, targets });
  while (textOf().length < bytes)
    targets.push(target(targets.length, "t".repeat(4096), FORM_ALERTS));
  const last = targets.length - 1;
  targets[last] = target(last, "t".repeat(4096 - (textOf().length - bytes)), FORM_ALERTS);
  const text = textOf();
  if (text.length !== bytes) throw new Error("could not size the roster");
  return text;
}

type Schema = "hubToRelay" | "relayToHub" | "relayToPush" | "pushToRelay";

function textVectors() {
  const vectors: { name: string; schema: Schema; text: CompactValue; accept: boolean }[] = [];
  const add = (schema: Schema, accept: boolean, name: string, frame: unknown) =>
    vectors.push({
      name,
      schema,
      text: compactRuns(typeof frame === "string" ? frame : JSON.stringify(frame), 1),
      accept,
    });
  const pushItem = { id: 1, key: KEY_ID, h: H };
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...pushItem, id: i + 1, h: FORM_H }));
  const relayItem = {
    id: 1,
    hub: IDENTITY,
    platform: "fcm",
    env: "production",
    token: FCM_TOKEN,
    h: H,
  };
  const roster = {
    t: "roster",
    rev: 3,
    targets: [
      { key: KEY_ID, platform: "apns", env: "development", token: APNS_TOKEN, ...ALERTS },
      { ...target(1, FCM_TOKEN) },
    ],
  };

  // hub → relay
  const yes = (name: string, frame: unknown) => add("hubToRelay", true, name, frame);
  const no = (name: string, frame: unknown) => add("hubToRelay", false, name, frame);
  yes("ping", { t: "ping", n: 0 });
  yes("ping, n the largest u32", { t: "ping", n: 4_294_967_295 });
  yes("close with 1013 (the channel refused the stream)", { t: "close", stream: 5, code: 1013 });
  yes("close with 4004 (M2's CLOSE codes pass through)", {
    t: "close",
    stream: 4_294_967_295,
    code: 4004,
  });
  yes("roster of two targets", roster);
  yes("roster of no targets", { t: "roster", rev: 0, targets: [] });
  yes("roster of exactly 131,072 bytes", rosterOfBytes(131_072));
  yes("push of one item", { t: "push", items: [pushItem] });
  yes("push of 32 items", { t: "push", items: items(32) });
  yes("restarting for an update, 600,000 ms", {
    t: "restarting",
    reason: "update",
    withinMs: 600_000,
  });
  yes("restarting for a restore, 0 ms", { t: "restarting", reason: "restore", withinMs: 0 });
  yes("release.check with firmware", {
    t: "release.check",
    platform: "darwin-arm64",
    running: "0.4.0",
    firmware: "1.3.2",
  });
  yes("release.check without firmware", {
    t: "release.check",
    platform: "windows-x64",
    running: "0.4.0",
  });
  yes("release.get of 262,144 bytes", {
    t: "release.get",
    id: 7,
    file: hubOffer.file,
    offset: 262_144,
    length: 262_144,
  });
  yes("release.get of a firmware file, 1 byte", {
    t: "release.get",
    id: 0,
    file: firmwareOffer.file,
    offset: 0,
    length: 1,
  });
  no("roster of 131,073 bytes", rosterOfBytes(131_073));
  no("ping, n -1", { t: "ping", n: -1 });
  no("ping, n 2^32", { t: "ping", n: 4_294_967_296 });
  no("ping, n 1.5", { t: "ping", n: 1.5 });
  no("ping, n as text", { t: "ping", n: "1" });
  no("ping with a field it does not name", { t: "ping", n: 1, at: 2 });
  no("ping without n", { t: "ping" });
  no("close with 1001 (the relay's code, not the hub's)", { t: "close", stream: 5, code: 1001 });
  no("close with 4404", { t: "close", stream: 5, code: 4404 });
  no("close with 4005", { t: "close", stream: 5, code: 4005 });
  no("close of stream 2^32", { t: "close", stream: 4_294_967_296, code: 1000 });
  no("roster with a key id twice", { ...roster, targets: [roster.targets[0], roster.targets[0]] });
  no("roster with an APNs token that is not hex", {
    ...roster,
    targets: [{ ...roster.targets[0], token: FCM_TOKEN }],
  });
  no("roster with an unreachable alert not of h's form", {
    ...roster,
    targets: [{ ...roster.targets[0], unreachable: "1.x" }],
  });
  no("push of no items", { t: "push", items: [] });
  no("push of 33 items", { t: "push", items: items(33) });
  no("push item id 0", { t: "push", items: [{ ...pushItem, id: 0 }] });
  no("push item with envelope B's class (defined, unused)", {
    t: "push",
    items: [{ ...pushItem, class: "critical" }],
  });
  no("push item in the relay link's form", { t: "push", items: [relayItem] });
  no("restarting within 600,001 ms", { t: "restarting", reason: "update", withinMs: 600_001 });
  no("restarting for an upgrade", { t: "restarting", reason: "upgrade", withinMs: 1000 });
  no("release.get of 262,145 bytes", {
    t: "release.get",
    id: 7,
    file: hubOffer.file,
    offset: 0,
    length: 262_145,
  });
  no("release.get of 0 bytes", {
    t: "release.get",
    id: 7,
    file: hubOffer.file,
    offset: 0,
    length: 0,
  });
  no("release.get of a file not named as releases are", {
    t: "release.get",
    id: 7,
    file: "../hsn.db",
    offset: 0,
    length: 1,
  });
  no("release.check for an unknown platform", {
    t: "release.check",
    platform: "windows-arm64",
    running: "0.4.0",
  });
  no("name.claim (not in this version)", { t: "name.claim", name: "abcdefghijklmnop" });
  no("joined (the relay's frame)", { t: "joined", identity: IDENTITY });
  no("an unknown t", { t: "hello" });
  no("no t", { n: 1 });
  no("not JSON", '{"t":"ping",');
  no("a JSON array", '[{"t":"ping","n":1}]');
  no("a JSON string", '"ping"');
  no("empty", "");

  // relay → hub
  const r = (accept: boolean, name: string, frame: unknown) =>
    add("relayToHub", accept, name, frame);
  r(true, "joined", { t: "joined", identity: IDENTITY });
  r(true, "pong", { t: "pong", n: 0 });
  r(true, "open a session stream", {
    t: "open",
    stream: 0,
    path: "session",
    peer: "relay-0123456789abcdef",
  });
  r(true, "open a link stream, stream the largest u32", {
    t: "open",
    stream: 4_294_967_295,
    path: "link",
    peer: "relay-fedcba9876543210",
  });
  r(true, "open a restore stream", {
    t: "open",
    stream: 9,
    path: "restore",
    peer: "relay-0000000000000000",
  });
  r(true, "close with 4410 (the relay's)", { t: "close", stream: 9, code: 4410 });
  r(true, "close with 1000 (the phone's own)", { t: "close", stream: 9, code: 1000 });
  r(true, "rosterAck", { t: "rosterAck", rev: 3 });
  r(true, "pushResult with each outcome", {
    t: "pushResult",
    results: [
      { id: 1, outcome: "accepted" },
      { id: 2, outcome: "badToken" },
      { id: 3, outcome: "limited" },
      { id: 4, outcome: "failed" },
    ],
  });
  r(true, "restartingAck", { t: "restartingAck" });
  r(true, "release.offer of both kinds", {
    t: "release.offer",
    releases: [hubOffer, firmwareOffer],
  });
  r(true, "release.offer of none", { t: "release.offer", releases: [] });
  r(true, "release.error with retryAfterMs", {
    t: "release.error",
    id: 7,
    reason: "limit",
    retryAfterMs: 3_600_000,
  });
  r(true, "release.error without retryAfterMs", { t: "release.error", id: 7, reason: "notFound" });
  r(true, "limit", { t: "limit", what: "pushes", retryAfterMs: 60_000 });
  r(false, "joined with an identity in upper case", {
    t: "joined",
    identity: IDENTITY.toUpperCase(),
  });
  r(false, "open with a peer of 15 hex digits", {
    t: "open",
    stream: 1,
    path: "session",
    peer: "relay-0123456789abcde",
  });
  r(false, "open with an upper-case peer", {
    t: "open",
    stream: 1,
    path: "session",
    peer: "relay-0123456789ABCDEF",
  });
  r(false, "open of the path hub", {
    t: "open",
    stream: 1,
    path: "hub",
    peer: "relay-0123456789abcdef",
  });
  r(false, "close with 999", { t: "close", stream: 1, code: 999 });
  r(false, "close with 5000", { t: "close", stream: 1, code: 5000 });
  r(false, "pushResult of no results", { t: "pushResult", results: [] });
  r(false, "pushResult with the outcome ok", {
    t: "pushResult",
    results: [{ id: 1, outcome: "ok" }],
  });
  r(false, "release.offer of two hub releases", {
    t: "release.offer",
    releases: [hubOffer, hubOffer],
  });
  r(false, "release.offer of a firmware file over a hub's name", {
    t: "release.offer",
    releases: [{ ...firmwareOffer, file: hubOffer.file }],
  });
  r(false, "limit naming what this version does not", {
    t: "limit",
    what: "everything",
    retryAfterMs: 0,
  });
  r(false, "push (the hub's frame)", { t: "push", items: [pushItem] });

  // relay → push service
  const p = (accept: boolean, name: string, frame: unknown) =>
    add("relayToPush", accept, name, frame);
  p(true, "push of an FCM item", { t: "push", items: [relayItem] });
  p(true, "push of an APNs development item", {
    t: "push",
    items: [{ ...relayItem, id: 2, platform: "apns", env: "development", token: APNS_TOKEN }],
  });
  p(true, "ping", { t: "ping", n: 1 });
  p(true, "release.check", { t: "release.check", platform: "linux-x64", running: "0.4.0" });
  p(true, "release.get", { t: "release.get", id: 1, file: hubOffer.file, offset: 0, length: 4096 });
  p(false, "push item with envelope B's class (defined, unused)", {
    t: "push",
    items: [{ ...relayItem, class: "ordinary" }],
  });
  p(false, "push item without the hub's identity", {
    t: "push",
    items: [Object.fromEntries(Object.entries(relayItem).filter(([k]) => k !== "hub"))],
  });
  p(false, "push item for APNs with an FCM token", {
    t: "push",
    items: [{ ...relayItem, platform: "apns" }],
  });
  p(false, "push item in the hub link's form", { t: "push", items: [pushItem] });
  p(false, "push of 32 items with 4,096-character tokens: schema-valid, over 131,072 bytes", {
    t: "push",
    items: Array.from({ length: 32 }, (_, i) => ({
      ...relayItem,
      id: i + 1,
      token: "t".repeat(4096),
      h: FORM_H,
    })),
  });
  p(false, "roster (a hub's frame)", roster);
  p(false, "restarting (a hub's frame)", { t: "restarting", reason: "update", withinMs: 1 });

  // push service → relay
  const s = (accept: boolean, name: string, frame: unknown) =>
    add("pushToRelay", accept, name, frame);
  s(true, "joined, naming the relay's own identity", {
    t: "joined",
    identity: relayIdentity(RELAY.publicKey),
  });
  s(true, "pong", { t: "pong", n: 1 });
  s(true, "pushResult", { t: "pushResult", results: [{ id: 1, outcome: "limited" }] });
  s(true, "release.offer", { t: "release.offer", releases: [firmwareOffer] });
  s(true, "release.error", { t: "release.error", id: 1, reason: "unavailable" });
  s(true, "limit", { t: "limit", what: "releases", retryAfterMs: 1 });
  s(false, "open (a relay's frame to a hub)", {
    t: "open",
    stream: 1,
    path: "session",
    peer: "relay-0123456789abcdef",
  });
  s(false, "close", { t: "close", stream: 1, code: 1000 });
  s(false, "rosterAck", { t: "rosterAck", rev: 1 });
  s(false, "restartingAck", { t: "restartingAck" });
  return vectors;
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function binaryVectors() {
  /** Bytes that differ from each other at both ends, and a run of 0xa5 between when long. */
  const message = (n: number) =>
    Uint8Array.from({ length: n }, (_, i) =>
      n > 64 && i >= 16 && i < n - 16 ? 0xa5 : (i * 7 + 3) & 0xff,
    );
  const hex = (bytes: Uint8Array) => compactRuns(toHex(bytes), 2);
  const stream = (name: string, id: number, payload: Uint8Array) => ({
    name,
    bytes: hex(concat(Uint8Array.of(1), u32le(id), payload)),
    frame: { kind: 1, stream: id, message: hex(payload) },
  });
  const piece = (name: string, id: number, payload: Uint8Array) => ({
    name,
    bytes: hex(concat(Uint8Array.of(2), u32le(id), payload)),
    frame: { kind: 2, id, bytes: hex(payload) },
  });
  const refused = (
    name: string,
    bytes: Uint8Array,
    expect: "truncated" | "unknownKind" | "badLength",
  ) => ({
    name,
    bytes: hex(bytes),
    expect,
  });
  return [
    stream("stream data: stream 1, a 1-byte message", 1, message(1)),
    stream(
      "stream data: stream 0x01020304 (little-endian), a 48-byte message",
      0x0102_0304,
      message(48),
    ),
    stream("stream data: stream 0", 0, message(16)),
    stream("stream data: stream the largest u32", 0xffff_ffff, message(32)),
    stream("stream data: a message of 65,535 bytes, the largest", 2, message(65_535)),
    piece("release piece: request 7, 1 byte", 7, message(1)),
    piece("release piece: request 0x0a0b0c0d, 1,000 bytes", 0x0a0b_0c0d, message(1000)),
    piece("release piece: 262,144 bytes, the largest", 3, message(262_144)),
    refused("empty", EMPTY, "truncated"),
    refused("kind 1 alone", Uint8Array.of(1), "truncated"),
    refused("kind 1 and three bytes of the stream number", Uint8Array.of(1, 0, 0, 0), "truncated"),
    refused("kind 2 and three bytes of the request id", Uint8Array.of(2, 7, 0, 0), "truncated"),
    refused("kind 0", concat(Uint8Array.of(0), u32le(1), message(8)), "unknownKind"),
    refused("kind 3", concat(Uint8Array.of(3), u32le(1), message(8)), "unknownKind"),
    refused("kind 255", concat(Uint8Array.of(255), u32le(1), message(8)), "unknownKind"),
    refused("kind 3 alone: the kind is read before the length", Uint8Array.of(3), "unknownKind"),
    refused("kind 1 with no message", concat(Uint8Array.of(1), u32le(1)), "badLength"),
    refused("kind 2 with no bytes", concat(Uint8Array.of(2), u32le(1)), "badLength"),
    refused(
      "kind 1 with a message of 65,536 bytes",
      concat(Uint8Array.of(1), u32le(1), message(65_536)),
      "badLength",
    ),
    refused(
      "kind 2 with 262,145 bytes",
      concat(Uint8Array.of(2), u32le(1), message(262_145)),
      "badLength",
    ),
  ];
}

/** Every close code of a hub link or a relay link, and what the closed side does next. */
function closeVectors() {
  return Object.entries(RELAY_CLOSE).map(([name, code]) => ({
    name,
    code,
    reconnect: relayCloseReconnect(code),
  }));
}

// ----- The files -----

const XN_DESCRIPTION =
  "The relay's links' handshake, Noise_XN_25519_ChaChaPoly_SHA256 (docs/m4-design.md section 3, D125, D142): -> e; <- e, ee; -> s, se. `link` hub is a hub's link (/v1/hub, prologue the ASCII bytes hsn-relay/1 and a zero byte), `link` relay a relay's link to the push service (/v1/relay, hsn-relay-peer/1 and a zero byte). The initiator (the hub, or the relay) has a static key; the responder (the relay, or the push service) has none. `handshakes`: run both sides from the keys and the prologue: writing each payload must give exactly `message`, reading `message` must give `payload`, both sides must end with `handshakeHash`, and the responder must then hold the initiator's static public key, whose `identity` is the first 16 bytes of its SHA-256 as 26 characters of lower-case base32 without padding (what the relay answers in joined {identity}). Payloads are UTF-8 JSON: message 1 RelayHello {proto: [min, max], hub} on a hub link or RelayPeerHello {proto, relay} on a relay link, message 2 RelayWelcome {proto, relay, roles, limits}, message 3 RelayJoin {}. After the split each `plaintext` must encrypt to `message` and decrypt back, in order; the links never use Noise transport (their frames go in the clear inside TLS), so these only prove the split. `failures`: start one side with `prologue`, `staticKey` (the initiator only) and `ephemeral` as its fixed ephemeral. Whenever it is the side's turn to write a handshake message, it writes one with the empty payload (first, for the initiator, and after the last given message); it reads the given `messages` in order. Every step must succeed until the last given message: reading it, or the write that follows it, must fail with `expect` (allZeroDh, a Diffie-Hellman result of all zeros; badMessage, shorter than its tokens need; decryptFailed, a tag that does not verify; tooLong, over 65,535 bytes), and the side must then refuse any further call. Low-order public keys are u = 0, 1, the two points of order 8, p − 1, p, p + 1 and 2^255.";

const PUSH_DESCRIPTION =
  'Sealed pushes (docs/m4-design.md section 5, D126, D127): h = "1." keyId (16 lower-case hex) "." base64url(nonce (12) ‖ ChaCha20-Poly1305(key, nonce, aad, padded)), base64url as RFC 4648 section 5 without padding, always 1,763 characters; aad = the ASCII bytes hsn-push/1, a zero byte and the 8-byte key id; padded = the UTF-8 JSON of PushContent, the byte 0x80, then zero bytes up to 1,280 bytes (content at most 1,279 bytes). `seal`: sealing `contentJson` with `key`, `keyId` and `nonce` must give exactly `aad`, `padded`, `sealed` (nonce, ciphertext, 16-byte tag) and `h`; opening `h` with `key` held under `keyId` must give `content`. `contentJson` is the exact bytes sealed; `content` is the same as an object. `open`: the opener holds `key` under `keyId` and no other key; opening `h` must be refused with `expect`, checked in this order: badFormat (anything but 1, a dot, 16 lower-case hex digits, a dot and 1,744 base64url characters: another version, a truncated or oversized h, whitespace, upper-case hex, + / or =); unknownKey (no key held for h\'s key id); decryptFailed (the tag does not verify: a wrong key, any changed byte, other associated data); badPadding (the last byte that is not zero is not 0x80, or there is none); badContent (the bytes before that last 0x80 are not UTF-8 JSON of a PushContent). A PushContent is an object with exactly these fields, and no others at any level: v 1; hub, 26 characters of a-z and 2-7; n, an object of seq (an integer 0 to 2^53 − 1), atMs (an integer 0 to 2^53 − 1), clockOk (a boolean), kind (1 to 64 characters), category (one of sensorSilentWhileDisarmed, sirenPathLost, gatewayOffline, batteryLow, armDisarm, updates, countdown, alarm, localAlarm, tamper, longPress, sensorSilentWhileArmed, sirenSilent, jamming, scheduleMissedOrHeldBack, disk, newClient, backup, hub, stateUnexpected), critical (a boolean), device (null or an integer 1 to 2^32 − 1) and cause (null or an integer 0 to 2^53 − 1); delayed, a boolean; names, an object with any of device, person, client, mode and schedule, each 1 to 64 characters; detail, optional, an object whose keys are 1 to 64 characters and whose values are strings, finite numbers or booleans; actions, an array of none or one of disarm and armAway; armed, a boolean. Lengths of text are counted in Unicode code points, not UTF-16 units or bytes: 🚪 (U+1F6AA) is one, a letter and its combining accent two. The relay\'s two alerts are contents of kind hub_unreachable and hub_back, category hub, n.seq 0, n.atMs 0, n.clockOk false, not critical: the phone decides their loudness from the home\'s last armed state it saw (D96) and takes their time from their arrival.';

const FRAMES_DESCRIPTION =
  "The relay's links' frames (docs/m4-design.md section 3). Long values are written compactly: `text`, `bytes`, `frame.message` and `frame.bytes` are each either the value itself (text, or hex) or an array of pieces to join in order, each piece either the value's text itself or {\"repeat\": text, \"times\": n}, that text written n times (n from 1 to 16,777,216); for hex fields every piece is hex and the joined text is the bytes' hex. Some frames carry an h of the right form that opens to nothing (1, the key id, a dot and 1,744 A's), since only the form is the frames' to check. `text`: one WebSocket text message travelling as `schema` names (hubToRelay and relayToHub on /v1/hub; relayToPush and pushToRelay on /v1/relay), which the receiver must accept as a frame (`accept` true) or refuse (false), refusing closes the link with 4400. A text frame is one JSON object whose `t` names it, with exactly the fields of section 3's tables (packages/protocol/src/relay/frames.ts) and no others, and at most 131,072 bytes of UTF-8, checked before parsing: a frame over it is refused even when its fields are valid, and a sender splits such a frame (the relay's push items) into several. `binary`: one WebSocket binary message: byte 0 the kind, then a u32 little-endian, then the payload. Kind 1, stream data: the stream number, then one Noise message of 1 to 65,535 bytes. Kind 2, a release piece: release.get's request id, then 1 to 262,144 bytes. Decoding `bytes` must give `frame`, and encoding `frame` must give `bytes`; or decoding must be refused with `expect`, checked in this order: truncated (no bytes at all), unknownKind (byte 0 not 1 or 2), truncated (fewer than 5 bytes), badLength (a payload of no bytes or over its kind's bound). `closes`: every close code of a hub link or a relay link, by `name` and `code`, and what the side whose link it closes does next (`reconnect`): backoff, reconnect on its back-off (1, 2, 4, 8, 16, 32 s, then every 60 s); wait, wait the last `limit` frame's retryAfterMs or 10 minutes first (4001 replaced, 4426 no shared version, 4429 over a limit); never (4403 refused: the operator refused this key), stop reconnecting, report it once, and try again only after the configuration changes or the side restarts. A link that drops with no code is backoff.";

function file(json: Record<string, unknown>): string {
  return `${JSON.stringify({ schemaVersion: 1, ...json }, null, 2)}\n`;
}

/** Every relay vector file, as its text. */
export async function relayVectorFiles(): Promise<ReadonlyMap<string, string>> {
  return new Map([
    [
      RELAY_VECTOR_FILES.xn,
      file({
        description: XN_DESCRIPTION,
        handshakes: await xnVectors(),
        failures: await xnFailureVectors(),
      }),
    ],
    [
      RELAY_VECTOR_FILES.push,
      file({ description: PUSH_DESCRIPTION, seal: sealVectors(), open: openVectors() }),
    ],
    [
      RELAY_VECTOR_FILES.frames,
      file({
        description: FRAMES_DESCRIPTION,
        text: textVectors(),
        binary: binaryVectors(),
        closes: closeVectors(),
      }),
    ],
  ]);
}

if (import.meta.main) {
  const files = await relayVectorFiles();
  for (const [name, text] of files) writeFileSync(join(RELAY_VECTOR_DIRECTORY, name), text);
  console.log(`wrote ${files.size} relay vector files to ${RELAY_VECTOR_DIRECTORY}`);
}

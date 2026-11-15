/**
 * The Noise state machine against our own vectors (app-noise.json, app-noise-failures.json) and
 * the rules of docs/m2-design.md section 5 that the vectors cannot show: the all-zero check on a
 * static key's own DH function, calls out of turn, a failure ending everything, the size limits,
 * nonce exhaustion and wiping.
 */
import { describe, expect, test } from "bun:test";
import { diffieHellman, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromHex, toHex } from "../bytes.ts";
import { LOW_ORDER_POINTS } from "./vectors/app-vectors.ts";
import { appReply, parseEvent, parseRequest } from "./envelope.ts";
import {
  clientHello,
  hubHello,
  linkHello,
  linkHubPayload,
  linkRequest,
  linkResult,
  restoreHello,
  restoreKey,
  restoreOffer,
  restoreResult,
} from "./handshake.ts";
import { appIdentityBytes, linkPrologue, sessionPrologue } from "./linking.ts";
import {
  type Handshake,
  type HandshakeOptions,
  NOISE_PATTERNS,
  type StaticKey,
  type TransportSession,
} from "./noise-interface.ts";
import {
  CipherState,
  isAllZero,
  matchesIdentity,
  NoiseHandshake,
  NoiseTransport,
  startHandshake,
  x25519StaticKey,
} from "./noise.ts";
import { noiseFailureVector, noiseVector, vectorFile } from "./vector-formats.ts";

const IK = NOISE_PATTERNS.session;
const XX = NOISE_PATTERNS.link;
const VECTORS = join(import.meta.dir, "..", "..", "vectors");
const decoder = new TextDecoder();

const noise = vectorFile(noiseVector).parse(
  JSON.parse(readFileSync(join(VECTORS, "app-noise.json"), "utf8")),
);
const failures = vectorFile(noiseFailureVector).parse(
  JSON.parse(readFileSync(join(VECTORS, "app-noise-failures.json"), "utf8")),
);

function staticKey(privateHex: string): StaticKey {
  const key = x25519StaticKey(fromHex(privateHex));
  if (!key.ok) throw new Error("bad static key");
  return key.value;
}

function pair(p: { private: string; public: string }) {
  return { privateKey: fromHex(p.private), publicKey: fromHex(p.public) };
}

function started(options: HandshakeOptions): Handshake {
  const handshake = startHandshake(options);
  if (!handshake.ok) throw new Error(`cannot start: ${handshake.error}`);
  return handshake.value;
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const fixedKey = (name: string) => sha256(new TextEncoder().encode(`noise-test/${name}`));
const keys = (name: string) => {
  const privateKey = fixedKey(name);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
};
const hub = keys("hub");
const client = keys("client");
const psk = fixedKey("psk");
const prologue = new Uint8Array([1, 2, 3]);

function ikPair(): [Handshake, Handshake] {
  return [
    started({
      pattern: IK,
      initiator: true,
      prologue,
      staticKey: staticKey(toHex(client.privateKey)),
      remoteStatic: hub.publicKey,
    }),
    started({
      pattern: IK,
      initiator: false,
      prologue,
      staticKey: staticKey(toHex(hub.privateKey)),
    }),
  ];
}

function xxPair(): [Handshake, Handshake] {
  return [
    started({
      pattern: XX,
      initiator: true,
      prologue,
      psk,
      staticKey: staticKey(toHex(client.privateKey)),
    }),
    started({
      pattern: XX,
      initiator: false,
      prologue,
      staticKey: staticKey(toHex(hub.privateKey)),
    }),
  ];
}

/** An XXpsk3 responder, made without its pre-shared key. */
function xxResponder(): Handshake {
  return started({
    pattern: XX,
    initiator: false,
    prologue,
    staticKey: staticKey(toHex(hub.privateKey)),
  });
}

/** Runs a handshake to its end; an XXpsk3 responder `b` is given `psk` after message 1. */
async function complete(a: Handshake, b: Handshake): Promise<[TransportSession, TransportSession]> {
  let writer = a;
  let reader = b;
  let read = 0;
  while (!a.complete || !b.complete) {
    value(await reader.readMessage(value(await writer.writeMessage(new Uint8Array(0)))));
    if (read++ === 0 && b instanceof NoiseHandshake && b.needsPsk()) value(b.setPsk(psk));
    [writer, reader] = [reader, writer];
  }
  return [value(a.split()), value(b.split())];
}

// ----- app-noise.json -----

const PAYLOADS = {
  session: [clientHello, hubHello],
  link: [linkHello, linkHubPayload, linkRequest],
  restore: [linkHello, linkHubPayload, restoreHello],
} as const;

function checkTransportPayload(purpose: string, from: string, i: number, text: string): void {
  const parsed: unknown = JSON.parse(text);
  if (purpose === "session") {
    const ok =
      from === "initiator"
        ? parseRequest(parsed).ok
        : appReply.safeParse(parsed).success || parseEvent(parsed).ok;
    expect(ok).toBe(true);
  } else if (purpose === "link") {
    expect(linkResult.safeParse(parsed).success).toBe(true);
  } else {
    // Messages 4, 5 and 6 (section 5, "Restore's messages").
    const schema = [restoreOffer, restoreKey, restoreResult][i];
    expect(schema?.safeParse(parsed).success).toBe(true);
  }
}

describe("app-noise.json: every handshake, as exact bytes", () => {
  test("covers a session with and without first, a link from each carrier, and a restore", () => {
    const kinds = noise.vectors.map((v) => `${v.purpose}/${v.carrier ?? ""}`);
    expect(kinds.toSorted()).toEqual(
      [
        "link/linkAddress",
        "link/qr",
        "link/typedCode",
        "restore/qr",
        "session/",
        "session/",
      ].toSorted(),
    );
    const firsts = noise.vectors
      .filter((v) => v.purpose === "session")
      .map(
        (v) =>
          "first" in
          clientHello.parse(JSON.parse(decoder.decode(fromHex(v.messages[0]?.payload ?? "")))),
      );
    expect(firsts.toSorted()).toEqual([false, true]);
  });

  test.each(noise.vectors.map((v) => [v.name, v] as const))("%s", async (_, v) => {
    // The prologue of its purpose (section 5, "Prologues").
    const identity = appIdentityBytes(sha256, fromHex(v.responder.static.public));
    const expectedPrologue =
      v.purpose === "session" ? sessionPrologue(identity) : linkPrologue(v.purpose);
    expect(v.prologue).toBe(toHex(expectedPrologue));
    expect(v.pattern).toBe(v.purpose === "session" ? IK : XX);
    const start = (initiator: boolean) => {
      const side = initiator ? v.initiator : v.responder;
      return started({
        pattern: v.pattern,
        initiator,
        prologue: fromHex(v.prologue),
        staticKey: staticKey(side.static.private),
        ephemeral: pair(side.ephemeral),
        ...(v.pattern === IK && initiator
          ? { remoteStatic: fromHex(v.responder.static.public) }
          : {}),
        ...(v.psk === undefined || !initiator ? {} : { psk: fromHex(v.psk) }),
      });
    };
    const initiator = start(true);
    const responder = start(false);
    for (const [i, m] of v.messages.entries()) {
      expect(m.from).toBe(i % 2 === 0 ? "initiator" : "responder");
      const [writer, reader] =
        m.from === "initiator" ? [initiator, responder] : [responder, initiator];
      expect(toHex(value(await writer.writeMessage(fromHex(m.payload))))).toBe(m.message);
      expect(toHex(value(await reader.readMessage(fromHex(m.message))))).toBe(m.payload);
      // The hub learns the token from message 1's `find`, then takes its key.
      if (i === 0 && v.psk !== undefined) value(responder.setPsk(fromHex(v.psk)));
      const schema = PAYLOADS[v.purpose][i];
      expect(schema?.safeParse(JSON.parse(decoder.decode(fromHex(m.payload)))).success).toBe(true);
    }
    expect(toHex(initiator.handshakeHash())).toBe(v.handshakeHash);
    expect(toHex(responder.handshakeHash())).toBe(v.handshakeHash);
    expect(toHex(initiator.remoteStatic() ?? new Uint8Array())).toBe(v.responder.static.public);
    expect(toHex(responder.remoteStatic() ?? new Uint8Array())).toBe(v.initiator.static.public);
    const sessions = { initiator: value(initiator.split()), responder: value(responder.split()) };
    for (const [i, t] of v.transport.entries()) {
      const to = t.from === "initiator" ? "responder" : "initiator";
      expect(toHex(value(sessions[t.from].encrypt(fromHex(t.plaintext))))).toBe(t.message);
      expect(toHex(value(sessions[to].decrypt(fromHex(t.message))))).toBe(t.plaintext);
      checkTransportPayload(v.purpose, t.from, i, decoder.decode(fromHex(t.plaintext)));
    }
  });

  test("the client of a link or restore checks the hub's key against the identity it was given", () => {
    for (const v of noise.vectors.filter((x) => x.purpose !== "session")) {
      const identity = appIdentityBytes(sha256, fromHex(v.responder.static.public));
      expect(matchesIdentity(fromHex(v.responder.static.public), identity)).toBe(true);
      expect(matchesIdentity(fromHex(v.initiator.static.public), identity)).toBe(false);
    }
  });
});

// ----- app-noise-failures.json -----

type FailureVector = (typeof failures.vectors)[number];

/** The harness `app-noise-failures.json`'s description states. */
async function runFailure(v: FailureVector): Promise<{ error: string; after: string }> {
  const initiator = v.side === "initiator";
  const handshake = started({
    pattern: v.pattern,
    initiator,
    prologue: fromHex(v.prologue),
    staticKey: staticKey(v.staticKey.private),
    ephemeral: pair(v.ephemeral),
    ...(v.pattern === IK && initiator && v.remoteStatic !== undefined
      ? { remoteStatic: fromHex(v.remoteStatic) }
      : {}),
    ...(v.psk === undefined || !initiator ? {} : { psk: fromHex(v.psk) }),
  });
  const myTurn = (written: number) => (written % 2 === 0) === initiator;
  let processed = 0;
  let transport: TransportSession | undefined;
  const refuseAfter = (): string => {
    const again =
      transport === undefined ? handshake.split() : transport.decrypt(new Uint8Array(16));
    return again.ok ? "accepted" : again.error;
  };
  const writeIfTurn = async (): Promise<string | undefined> => {
    if (!handshake.complete && myTurn(processed)) {
      const written = await handshake.writeMessage(new Uint8Array(0));
      if (!written.ok) return written.error;
      processed += 1;
    }
    if (handshake.complete && transport === undefined) {
      const split = handshake.split();
      if (!split.ok) return split.error;
      transport = split.value;
    }
    return undefined;
  };
  const first = await writeIfTurn();
  if (first !== undefined) return { error: `early ${first}`, after: "" };
  for (const [i, hex] of v.messages.entries()) {
    const last = i === v.messages.length - 1;
    let error: string | undefined;
    if (transport === undefined) {
      const read = await handshake.readMessage(fromHex(hex));
      if (read.ok) {
        processed += 1;
        if (processed === 1 && !initiator && v.psk !== undefined) {
          const given = handshake.setPsk(fromHex(v.psk));
          if (!given.ok) error = given.error;
        }
        const carriesHubKey = v.pattern === XX && initiator && processed === 2;
        if (carriesHubKey && v.remoteStatic !== undefined) {
          const identity = appIdentityBytes(sha256, fromHex(v.remoteStatic));
          if (!matchesIdentity(handshake.remoteStatic() ?? new Uint8Array(), identity)) {
            error = "identityMismatch";
          }
        }
        error ??= await writeIfTurn();
      } else {
        error = read.error;
      }
    } else {
      const read = transport.decrypt(fromHex(hex));
      if (!read.ok) error = read.error;
    }
    if (error !== undefined) {
      return last
        ? { error, after: error === "identityMismatch" ? "n/a" : refuseAfter() }
        : { error: `early ${error}`, after: "" };
    }
  }
  return { error: "accepted", after: "" };
}

describe("app-noise-failures.json: every refusal", () => {
  test("covers each rejection section 10 lists", () => {
    const names = failures.vectors.map((v) => v.name).join("\n");
    for (const needle of [
      "another pre-shared key",
      "does not know the pre-shared key",
      "does not hash to the identity",
      "another hub's static key",
      "with the link prologue",
      "with the restore prologue",
      "version 2's prologue",
      "replayed message 1",
      "skipped",
      "repeated",
      "swapped",
      "ephemeral is 0",
      "static key is 0",
    ]) {
      expect(names).toContain(needle);
    }
    const expects = new Set(failures.vectors.map((v) => v.expect));
    for (const e of ["allZeroDh", "badMessage", "decryptFailed", "tooLong", "identityMismatch"]) {
      expect(expects.has(e as FailureVector["expect"])).toBe(true);
    }
  });

  test.each(failures.vectors.map((v) => [v.name, v] as const))("%s", async (_, v) => {
    const outcome = await runFailure(v);
    expect(outcome.error).toBe(v.expect);
    // A failure ends the handshake or the session: any further call is refused.
    if (outcome.after !== "n/a") expect(outcome.after).toBe("wrongState");
  });

  test("the low-order points are low order: OpenSSL's X25519 gives all zero or refuses", () => {
    const scalar = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), fixedKey("x")]),
      format: "der",
      type: "pkcs8",
    });
    for (const [, point] of LOW_ORDER_POINTS) {
      const publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), point]),
        format: "der",
        type: "spki",
      });
      let shared: Uint8Array | undefined;
      try {
        shared = diffieHellman({ privateKey: scalar, publicKey });
      } catch {
        shared = undefined;
      }
      expect(shared === undefined || isAllZero(shared)).toBe(true);
    }
  });
});

// ----- Rules the vectors cannot show -----

describe("all-zero Diffie-Hellman results end the handshake (section 5)", () => {
  const zeroStatic = (publicKey: Uint8Array): StaticKey => ({
    publicKey,
    dh: () => Promise.resolve(new Uint8Array(32)),
  });

  test("a static key's DH function that returns all zero, whatever the library does", async () => {
    // The hub's static key answers zero: its first DH (es, on reading message 1) must end it.
    const [initiator] = ikPair();
    const responder = started({
      pattern: IK,
      initiator: false,
      prologue,
      staticKey: zeroStatic(hub.publicKey),
    });
    const m1 = value(await initiator.writeMessage(new Uint8Array(0)));
    const read = await responder.readMessage(m1);
    expect(read.ok ? "accepted" : read.error).toBe("allZeroDh");
    expect(responder.split().ok).toBe(false);
  });

  test("a static key's DH function that rejects (Web Crypto's deriveBits on a low-order key)", async () => {
    const initiator = started({
      pattern: IK,
      initiator: true,
      prologue,
      remoteStatic: hub.publicKey,
      staticKey: {
        publicKey: client.publicKey,
        dh: () => Promise.reject(new Error("OperationError")),
      },
    });
    const written = await initiator.writeMessage(new Uint8Array(0));
    expect(written.ok ? "accepted" : written.error).toBe("allZeroDh");
  });

  test("a DH function that returns the wrong length", async () => {
    const initiator = started({
      pattern: IK,
      initiator: true,
      prologue,
      remoteStatic: hub.publicKey,
      staticKey: {
        publicKey: client.publicKey,
        dh: () => Promise.resolve(new Uint8Array(31).fill(1)),
      },
    });
    const written = await initiator.writeMessage(new Uint8Array(0));
    expect(written.ok ? "accepted" : written.error).toBe("allZeroDh");
  });

  test("an IK initiator given a low-order hub key refuses to write message 1", async () => {
    for (const [, point] of LOW_ORDER_POINTS) {
      const initiator = started({
        pattern: IK,
        initiator: true,
        prologue,
        remoteStatic: point,
        staticKey: staticKey(toHex(client.privateKey)),
      });
      const written = await initiator.writeMessage(new Uint8Array(0));
      expect(written.ok ? "accepted" : written.error).toBe("allZeroDh");
    }
  });
});

describe("the handshake's state (section 5)", () => {
  test("options a pattern cannot use are refused", () => {
    const s = staticKey(toHex(client.privateKey));
    const refused: HandshakeOptions[] = [
      { pattern: IK, initiator: true, prologue, staticKey: s },
      { pattern: IK, initiator: false, prologue, staticKey: s, remoteStatic: hub.publicKey },
      { pattern: IK, initiator: true, prologue, staticKey: s, remoteStatic: hub.publicKey, psk },
      { pattern: IK, initiator: true, prologue, staticKey: s, remoteStatic: new Uint8Array(31) },
      { pattern: XX, initiator: true, prologue, staticKey: s },
      { pattern: XX, initiator: false, prologue, staticKey: s, psk },
      { pattern: XX, initiator: true, prologue, staticKey: s, psk: new Uint8Array(31) },
      { pattern: XX, initiator: true, prologue, staticKey: s, psk, remoteStatic: hub.publicKey },
      {
        pattern: XX,
        initiator: true,
        prologue,
        staticKey: s,
        psk,
        ephemeral: { privateKey: client.privateKey, publicKey: hub.publicKey },
      },
      {
        pattern: XX,
        initiator: true,
        prologue,
        psk,
        staticKey: { ...s, publicKey: new Uint8Array(33) },
      },
    ];
    for (const options of refused) {
      const result = startHandshake(options);
      expect(result.ok ? "accepted" : result.error).toBe("wrongState");
    }
    expect(x25519StaticKey(new Uint8Array(31)).ok).toBe(false);
  });

  test("a call out of turn is refused, and ends the handshake", async () => {
    const [initiator, responder] = xxPair();
    const early = await responder.writeMessage(new Uint8Array(0));
    expect(early.ok ? "accepted" : early.error).toBe("wrongState");
    const m1 = value(await initiator.writeMessage(new Uint8Array(0)));
    const after = await responder.readMessage(m1);
    expect(after.ok ? "accepted" : after.error).toBe("wrongState");
    const again = await initiator.writeMessage(new Uint8Array(0));
    expect(again.ok ? "accepted" : again.error).toBe("wrongState");
  });

  test("split before the handshake completes, or twice, is refused", async () => {
    const [a] = ikPair();
    expect(a.split().ok).toBe(false);
    const [e, f] = ikPair();
    value(await f.readMessage(value(await e.writeMessage(new Uint8Array(0)))));
    value(await e.readMessage(value(await f.writeMessage(new Uint8Array(0)))));
    expect(e.split().ok).toBe(true);
    const second = e.split();
    expect(second.ok ? "accepted" : second.error).toBe("wrongState");
  });

  test("two calls at once are refused", async () => {
    const [initiator] = ikPair();
    const [first, second] = await Promise.all([
      initiator.writeMessage(new Uint8Array(0)),
      initiator.writeMessage(new Uint8Array(0)),
    ]);
    expect(first.ok).toBe(false);
    expect(second.ok ? "accepted" : second.error).toBe("wrongState");
  });

  test("a handshake message past 65,535 bytes is refused before anything is computed", async () => {
    const [initiator] = ikPair();
    // Message 1 of IK is 96 bytes plus the payload: 65,440 bytes of payload is one too many.
    const written = await initiator.writeMessage(new Uint8Array(65_535 - 96 + 1));
    expect(written.ok ? "accepted" : written.error).toBe("tooLong");
    const [fits] = ikPair();
    const ok = await fits.writeMessage(new Uint8Array(65_535 - 96));
    expect(ok.ok && ok.value.length).toBe(65_535);
  });

  test("a payload that fails to decrypt ends the handshake", async () => {
    const [initiator, responder] = ikPair();
    const m1 = value(await initiator.writeMessage(new Uint8Array(0)));
    m1[m1.length - 1] = (m1[m1.length - 1] ?? 0) ^ 1;
    const read = await responder.readMessage(m1);
    expect(read.ok ? "accepted" : read.error).toBe("decryptFailed");
    expect(responder.complete).toBe(false);
  });

  test("setPsk after message 1 completes the handshake, read before the key is known", async () => {
    // LinkHello's `find` names the token: the hub reads message 1 with no key, then takes it.
    const [initiator] = xxPair();
    const responder = xxResponder();
    const m1 = value(await initiator.writeMessage(new TextEncoder().encode("find")));
    expect(decoder.decode(value(await responder.readMessage(m1)))).toBe("find");
    expect(responder.setPsk(psk).ok).toBe(true);
    value(await initiator.readMessage(value(await responder.writeMessage(new Uint8Array(0)))));
    value(await responder.readMessage(value(await initiator.writeMessage(new Uint8Array(0)))));
    expect(initiator.complete && responder.complete).toBe(true);
    expect(toHex(initiator.handshakeHash())).toBe(toHex(responder.handshakeHash()));
  });

  test("setPsk after message 2 is written, still before message 3, also works", async () => {
    const [initiator] = xxPair();
    const responder = xxResponder();
    value(await responder.readMessage(value(await initiator.writeMessage(new Uint8Array(0)))));
    value(await initiator.readMessage(value(await responder.writeMessage(new Uint8Array(0)))));
    expect(responder.setPsk(psk).ok).toBe(true);
    value(await responder.readMessage(value(await initiator.writeMessage(new Uint8Array(0)))));
    expect(responder.complete).toBe(true);
  });

  const refusedSetPsk = (r: { ok: boolean; error?: string }) => (r.ok ? "accepted" : r.error);

  test("setPsk twice, before message 1, after message 3, on the wrong side, or of the wrong length is wrongState and ends the handshake", async () => {
    const read1 = async () => {
      const [initiator] = xxPair();
      const responder = xxResponder();
      value(await responder.readMessage(value(await initiator.writeMessage(new Uint8Array(0)))));
      return { initiator, responder };
    };
    const twice = await read1();
    expect(twice.responder.setPsk(psk).ok).toBe(true);
    expect(refusedSetPsk(twice.responder.setPsk(psk))).toBe("wrongState");
    expect((await twice.responder.writeMessage(new Uint8Array(0))).ok).toBe(false);

    expect(refusedSetPsk(xxResponder().setPsk(psk))).toBe("wrongState");

    const [i3, r3] = [xxPair()[0], xxResponder()];
    value(await r3.readMessage(value(await i3.writeMessage(new Uint8Array(0)))));
    value(r3.setPsk(psk));
    value(await i3.readMessage(value(await r3.writeMessage(new Uint8Array(0)))));
    value(await r3.readMessage(value(await i3.writeMessage(new Uint8Array(0)))));
    expect(refusedSetPsk(r3.setPsk(psk))).toBe("wrongState");

    const [initiator] = xxPair();
    expect(refusedSetPsk(initiator.setPsk(psk))).toBe("wrongState");
    const [, ikResponder] = ikPair();
    expect(refusedSetPsk(ikResponder.setPsk(psk))).toBe("wrongState");
    const short = await read1();
    expect(refusedSetPsk(short.responder.setPsk(new Uint8Array(31)))).toBe("wrongState");
    expect((await short.responder.writeMessage(new Uint8Array(0))).ok).toBe(false);
  });

  test("message 3 read without setPsk is wrongState, and nothing is computed", async () => {
    const [initiator] = xxPair();
    const responder = xxResponder();
    value(await responder.readMessage(value(await initiator.writeMessage(new Uint8Array(0)))));
    value(await initiator.readMessage(value(await responder.writeMessage(new Uint8Array(0)))));
    const m3 = value(await initiator.writeMessage(new Uint8Array(0)));
    const read = await responder.readMessage(m3);
    expect(read.ok ? "accepted" : read.error).toBe("wrongState");
    expect(responder.remoteStatic()).toBeUndefined();
  });

  test("a wrong pre-shared key fails at message 3 and wipes the keys", async () => {
    const [initiator] = xxPair();
    const handshake = xxResponder();
    if (!(handshake instanceof NoiseHandshake)) throw new Error("start");
    value(await handshake.readMessage(value(await initiator.writeMessage(new Uint8Array(0)))));
    value(handshake.setPsk(fixedKey("another psk")));
    value(await initiator.readMessage(value(await handshake.writeMessage(new Uint8Array(0)))));
    expect(handshake.heldSecrets().some((secret) => !isAllZero(secret))).toBe(true);
    const read = await handshake.readMessage(
      value(await initiator.writeMessage(new Uint8Array(0))),
    );
    expect(read.ok ? "accepted" : read.error).toBe("decryptFailed");
    expect(handshake.heldSecrets().every(isAllZero)).toBe(true);
    expect(handshake.split().ok).toBe(false);
  });

  test("keys are wiped when the handshake splits, and when it fails", async () => {
    const ephemeral = keys("wipe-ephemeral");
    const given = ephemeral.privateKey.slice();
    const handshake = startHandshake({
      pattern: IK,
      initiator: true,
      prologue,
      remoteStatic: hub.publicKey,
      staticKey: staticKey(toHex(client.privateKey)),
      ephemeral,
    });
    if (!handshake.ok || !(handshake.value instanceof NoiseHandshake)) throw new Error("start");
    const initiator = handshake.value;
    const responder = started({
      pattern: IK,
      initiator: false,
      prologue,
      staticKey: staticKey(toHex(hub.privateKey)),
    });
    const [a] = await complete(initiator, responder);
    expect(initiator.heldSecrets().every(isAllZero)).toBe(true);
    // The caller's own copy of its ephemeral key is left alone.
    expect(toHex(ephemeral.privateKey)).toBe(toHex(given));
    // A transport session that fails wipes both its keys.
    if (!(a instanceof NoiseTransport)) throw new Error("transport");
    expect(a.heldKeys().length).toBe(2);
    expect(a.decrypt(new Uint8Array(16)).ok).toBe(false);
    expect(a.heldKeys().length).toBe(0);
    const [c] = ikPair();
    if (!(c instanceof NoiseHandshake)) throw new Error("start");
    expect(c.heldSecrets().some((s) => !isAllZero(s))).toBe(true);
    expect((await c.readMessage(new Uint8Array(96))).ok).toBe(false);
    expect(c.heldSecrets().every(isAllZero)).toBe(true);
  });
});

describe("transport messages (section 5)", () => {
  test("in order only; a failure ends the session", async () => {
    const [a, b] = await complete(...ikPair());
    const m0 = value(a.encrypt(new Uint8Array([0])));
    const m1 = value(a.encrypt(new Uint8Array([1])));
    expect(b.decrypt(m1).ok).toBe(false);
    const after = b.decrypt(m0);
    expect(after.ok ? "accepted" : after.error).toBe("wrongState");
  });

  test("a plaintext of 65,519 bytes fits; one more is refused", async () => {
    const [a, b] = await complete(...xxPair());
    const fits = value(a.encrypt(new Uint8Array(65_519)));
    expect(fits.length).toBe(65_535);
    expect(value(b.decrypt(fits)).length).toBe(65_519);
    const tooLong = a.encrypt(new Uint8Array(65_520));
    expect(tooLong.ok ? "accepted" : tooLong.error).toBe("tooLong");
    expect(a.encrypt(new Uint8Array(1)).ok).toBe(false);
  });

  test("each direction has its own key and nonce", async () => {
    const [a, b] = await complete(...ikPair());
    const fromA = value(a.encrypt(new Uint8Array([7])));
    const fromB = value(b.encrypt(new Uint8Array([7])));
    expect(toHex(fromA)).not.toBe(toHex(fromB));
    expect(b.decrypt(fromB).ok).toBe(false);
  });

  test("a CipherState refuses once its nonce reaches 2^64 − 1 (Noise 5.1)", () => {
    const cipher = new CipherState();
    cipher.initializeKey(fixedKey("nonce"));
    cipher.setNonce(2n ** 64n - 2n);
    expect(cipher.encryptWithAd(new Uint8Array(0), new Uint8Array(1)).ok).toBe(true);
    const exhausted = cipher.encryptWithAd(new Uint8Array(0), new Uint8Array(1));
    expect(exhausted.ok ? "accepted" : exhausted.error).toBe("nonceExhausted");
    const reader = new CipherState();
    reader.initializeKey(fixedKey("nonce"));
    reader.setNonce(2n ** 64n - 1n);
    const read = reader.decryptWithAd(new Uint8Array(0), new Uint8Array(17));
    expect(read.ok ? "accepted" : read.error).toBe("nonceExhausted");
  });

  test("a session's key is never logged: errors carry only their code", async () => {
    const [a] = await complete(...ikPair());
    const failed = a.decrypt(new Uint8Array(20));
    expect(failed).toEqual({ ok: false, error: "decryptFailed" });
  });
});

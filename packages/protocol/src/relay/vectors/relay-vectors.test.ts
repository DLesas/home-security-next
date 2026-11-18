/**
 * The committed relay vectors (`vectors/relay-*.json`) are exactly what `relay-vectors.ts` writes,
 * each reads with the format `vector-formats.ts` freezes, and the package's own code meets every
 * case: XN from the keys in the file (both sides), sealing to the exact `h`, every refusal with its
 * reason, every frame accepted or refused as the file says. The independent check is
 * `verify/verify-relay-vectors.mjs`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { fromHex, toHex } from "../../bytes.ts";
import type { Handshake, NoiseError, TransportSession } from "../../app/noise-interface.ts";
import { startHandshake, x25519StaticKey, NO_STATIC_KEY } from "../../app/noise.ts";
import { NOISE_PATTERNS } from "../../app/noise-interface.ts";
import { relayBinaryCodec } from "../binary.ts";
import { RELAY_CLOSE } from "../constants.ts";
import { RELAY_BINARY_KIND, type RelayBinaryFrame } from "../frames.ts";
import {
  decodeRelayHello,
  decodeRelayJoin,
  decodeRelayPeerHello,
  decodeRelayWelcome,
  provedIdentity,
  relayCloseReconnect,
  relayLinkPrologue,
  startRelayInitiator,
  startRelayResponder,
} from "../link-handshake.ts";
import { pushContentBytes } from "../push.ts";
import { pushAad, pushOpener, pushSealer } from "../seal.ts";
import { decodeTextFrame } from "../text.ts";
import {
  compactHex,
  compactText,
  RELAY_VECTOR_FILES,
  relayFramesFile,
  relayPushFile,
  relayXnFile,
} from "../vector-formats.ts";
import { compactRuns, expandCompact } from "./compact.ts";
import { RELAY_VECTOR_DIRECTORY, relayVectorFiles } from "./relay-vectors.ts";

const generated = await relayVectorFiles();
const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(RELAY_VECTOR_DIRECTORY, name), "utf8"));
const xn = relayXnFile.parse(read(RELAY_VECTOR_FILES.xn));
const push = relayPushFile.parse(read(RELAY_VECTOR_FILES.push));
const frames = relayFramesFile.parse(read(RELAY_VECTOR_FILES.frames));

function must<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const pairOf = (pair: { private: string; public: string }) => ({
  privateKey: fromHex(pair.private),
  publicKey: fromHex(pair.public),
});

describe("committed relay vectors", () => {
  test("the generator writes the three files and no other", () => {
    expect([...generated.keys()].sort()).toEqual(Object.values(RELAY_VECTOR_FILES).sort());
  });

  test.each([...generated.keys()])(
    "%s matches the generator (run `bun packages/protocol/src/relay/vectors/relay-vectors.ts`)",
    (name) => {
      expect(readFileSync(join(RELAY_VECTOR_DIRECTORY, name), "utf8")).toBe(
        generated.get(name) ?? "",
      );
    },
  );

  test("each file reads with its frozen format", () => {
    expect(xn.handshakes.length).toBeGreaterThan(0);
    expect(push.seal.length).toBeGreaterThan(0);
    expect(frames.binary.length).toBeGreaterThan(0);
  });
});

describe("relay-xn.json: both sides from the file's keys", () => {
  test.each(xn.handshakes.map((v) => [v.name, v] as const))("%s", async (_, v) => {
    const link = v.link;
    expect(toHex(relayLinkPrologue(link))).toBe(v.prologue);
    const initiator = must(
      startRelayInitiator(
        link,
        must(x25519StaticKey(fromHex(v.initiator.static.private))),
        pairOf(v.initiator.ephemeral),
      ),
    );
    const responder = must(startRelayResponder(link, pairOf(v.responder.ephemeral)));
    const decoders = [
      link === "hub" ? decodeRelayHello : decodeRelayPeerHello,
      decodeRelayWelcome,
      decodeRelayJoin,
    ];
    for (const [i, m] of v.messages.entries()) {
      const [writer, reader] =
        m.from === "initiator" ? [initiator, responder] : [responder, initiator];
      expect(toHex(must(await writer.writeMessage(fromHex(m.payload))))).toBe(m.message);
      const payload = must(await reader.readMessage(fromHex(m.message)));
      expect(toHex(payload)).toBe(m.payload);
      expect(decoders[i]?.(payload).ok).toBe(true);
    }
    expect(toHex(initiator.handshakeHash())).toBe(v.handshakeHash);
    expect(toHex(responder.handshakeHash())).toBe(v.handshakeHash);
    expect(toHex(responder.remoteStatic() ?? new Uint8Array(0))).toBe(v.initiator.static.public);
    expect(provedIdentity(responder)).toBe(v.identity);
    const sessions: Record<"initiator" | "responder", TransportSession> = {
      initiator: must(initiator.split()),
      responder: must(responder.split()),
    };
    for (const t of v.transport) {
      const other = t.from === "initiator" ? "responder" : "initiator";
      expect(toHex(must(sessions[t.from].encrypt(fromHex(t.plaintext))))).toBe(t.message);
      expect(toHex(must(sessions[other].decrypt(fromHex(t.message))))).toBe(t.plaintext);
    }
  });

  test.each(xn.failures.map((v) => [v.name, v] as const))("refused: %s", async (_, v) => {
    const initiator = v.side === "initiator";
    const started = startHandshake({
      pattern: NOISE_PATTERNS.relay,
      initiator,
      prologue: fromHex(v.prologue),
      staticKey:
        v.staticKey === undefined
          ? NO_STATIC_KEY
          : must(x25519StaticKey(fromHex(v.staticKey.private))),
      ephemeral: pairOf(v.ephemeral),
    });
    const side: Handshake = must(started);
    const empty = new Uint8Array(0);
    let writes = 0; // handshake messages through, either way
    const myTurn = () => !side.complete && (initiator ? writes % 2 === 0 : writes % 2 === 1);
    let error: NoiseError | undefined;
    let failedAt = -1;
    const write = async () => {
      while (myTurn()) {
        const w = await side.writeMessage(empty);
        if (!w.ok) return w.error;
        writes += 1;
      }
      return undefined;
    };
    error = await write();
    for (const [i, m] of v.messages.entries()) {
      if (error !== undefined) break;
      const r = await side.readMessage(fromHex(m));
      writes += 1;
      error = r.ok ? await write() : r.error;
      failedAt = i;
    }
    expect({ error, at: failedAt }).toEqual({ error: v.expect, at: v.messages.length - 1 });
    // A failure ends the handshake: every further call is refused.
    expect(await side.writeMessage(empty)).toEqual({ ok: false, error: "wrongState" });
    expect(await side.readMessage(fromHex(v.messages[0] ?? ""))).toEqual({
      ok: false,
      error: "wrongState",
    });
  });
});

describe("relay-push.json", () => {
  test.each(push.seal.map((v) => [v.name, v] as const))("sealed: %s", (_, v) => {
    const key = { key: fromHex(v.key), keyId: fromHex(v.keyId) };
    expect(toHex(pushContentBytes(v.content))).toBe(v.contentJson);
    expect(toHex(pushAad(key.keyId))).toBe(v.aad);
    expect(pushSealer.seal(v.content, key, fromHex(v.nonce))).toEqual({ ok: true, value: v.h });
    // The padded plaintext and the sealed bytes, from the file alone.
    const sealed = fromHex(v.sealed);
    expect(toHex(sealed.slice(0, 12))).toBe(v.nonce);
    const padded = chacha20poly1305(key.key, sealed.slice(0, 12), fromHex(v.aad)).decrypt(
      sealed.slice(12),
    );
    expect(toHex(padded)).toBe(v.padded);
    expect(v.h).toBe(`1.${v.keyId}.${Buffer.from(sealed).toString("base64url")}`);
    const opened = pushOpener.open(v.h, (id) => (toHex(id) === v.keyId ? key.key : undefined));
    expect(opened).toEqual({ ok: true, value: v.content });
  });

  test.each(push.open.map((v) => [v.name, v] as const))("refused: %s", (_, v) => {
    const opened = pushOpener.open(v.h, (id) =>
      toHex(id) === v.keyId ? fromHex(v.key) : undefined,
    );
    expect(opened).toEqual({ ok: false, error: v.expect });
  });
});

describe("relay-frames.json", () => {
  const text = frames.text.map((v) => ({ ...v, text: expandCompact(v.text) }));
  const binary = frames.binary.map((v) => ({ ...v, bytes: fromHex(expandCompact(v.bytes)) }));

  test.each(text.map((v) => [`${v.schema}: ${v.name}`, v] as const))("%s", (_, v) => {
    expect(decodeTextFrame(v.schema, v.text).ok).toBe(v.accept);
  });

  test.each(binary.map((v) => [v.name, v] as const))("%s", (_, v) => {
    const decoded = relayBinaryCodec.decode(v.bytes);
    if (v.frame === undefined) {
      expect(decoded).toEqual({ ok: false, error: v.expect ?? "truncated" });
      return;
    }
    const frame: RelayBinaryFrame =
      v.frame.kind === RELAY_BINARY_KIND.streamData
        ? { kind: 1, stream: v.frame.stream, message: fromHex(expandCompact(v.frame.message)) }
        : { kind: 2, id: v.frame.id, bytes: fromHex(expandCompact(v.frame.bytes)) };
    expect(decoded).toEqual({ ok: true, value: frame });
    const encoded = relayBinaryCodec.encode(frame);
    expect(encoded.ok && toHex(encoded.value)).toBe(toHex(v.bytes));
  });

  test("the largest of each, and one past it, are there, written compactly", () => {
    const sizes = (kind: number, accepted: boolean) =>
      binary
        .filter((v) => v.bytes[0] === kind && (v.frame !== undefined) === accepted)
        .map((v) => v.bytes.length);
    expect(sizes(1, true)).toContain(65_540);
    expect(sizes(1, false)).toContain(65_541);
    expect(sizes(2, true)).toContain(262_149);
    expect(sizes(2, false)).toContain(262_150);
    const textSizes = (accept: boolean) =>
      text.filter((v) => v.accept === accept).map((v) => new TextEncoder().encode(v.text).length);
    expect(textSizes(true)).toContain(131_072);
    expect(textSizes(false)).toContain(131_073);
    for (const big of frames.binary.filter((v) => expandCompact(v.bytes).length > 4096))
      expect(typeof big.bytes).not.toBe("string");
  });
});

describe("relay-frames.json: the links' close codes", () => {
  test("every RELAY_CLOSE code, once, with what the closed side does next", () => {
    expect(frames.closes.map((c) => [c.name, c.code])).toEqual(Object.entries(RELAY_CLOSE));
    for (const c of frames.closes)
      expect([c.code, relayCloseReconnect(c.code)]).toEqual([c.code, c.reconnect]);
    expect(frames.closes.find((c) => c.code === 4403)).toEqual({
      name: "refused",
      code: 4403,
      reconnect: "never",
    });
  });
});

describe("compact values", () => {
  test("pieces join in order; a repeat is written its times", () => {
    expect(expandCompact("00ff")).toBe("00ff");
    expect(expandCompact(["01", { repeat: "a5", times: 3 }, "02"])).toBe("01a5a5a502");
    expect(expandCompact([{ repeat: "ab", times: 1 }])).toBe("ab");
    expect(compactText.safeParse([{ repeat: "", times: 2 }]).success).toBe(false);
    expect(compactText.safeParse([{ repeat: "a", times: 0 }]).success).toBe(false);
    expect(compactText.safeParse([]).success).toBe(false);
    expect(compactHex.safeParse([{ repeat: "a", times: 2 }]).success).toBe(false);
    expect(compactHex.safeParse([{ repeat: "AB", times: 2 }]).success).toBe(false);
    expect(compactHex.safeParse([{ repeat: "ab", times: 2, extra: 1 }]).success).toBe(false);
  });

  test("runs become repeats, by whole units, and read back", () => {
    expect(compactRuns("abc", 1)).toBe("abc");
    expect(compactRuns(`x${"t".repeat(40)}y`, 1)).toEqual(["x", { repeat: "t", times: 40 }, "y"]);
    expect(compactRuns("t".repeat(31), 1)).toBe("t".repeat(31));
    // A run of a5 bytes that starts at an odd hex digit is still read by whole bytes.
    const hex = `0${"5a".repeat(40)}0`;
    expect(expandCompact(compactRuns(hex, 2))).toBe(hex);
    for (const sample of [`01${"a5".repeat(100)}02${"00".repeat(33)}`, "ab".repeat(32), ""])
      expect(expandCompact(compactRuns(sample, 2))).toBe(sample);
  });
});

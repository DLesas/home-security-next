/**
 * The Noise state machine against the published Noise test vectors (docs/m2-design.md section
 * 10): every vector of our two pattern names in cacophony's and snow's sets, kept byte for byte
 * in `vectors/noise-published/` with their source and SHA-256 in `sources.json`. The files are
 * data: only the fields of the Noise wiki's vector format are read.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";
import { fromHex, toHex } from "../bytes.ts";
import { NOISE_PATTERNS, type NoisePattern, type TransportSession } from "./noise-interface.ts";
import { startHandshake, x25519StaticKey } from "./noise.ts";

const DIRECTORY = join(import.meta.dir, "..", "..", "vectors", "noise-published");
const OUR_PATTERNS: readonly string[] = Object.values(NOISE_PATTERNS);

const sources = z
  .strictObject({
    description: z.string(),
    retrieved: z.string(),
    files: z.array(
      z.strictObject({
        file: z.string(),
        url: z.string(),
        repository: z.string(),
        commit: z.string(),
        sha256: z.string(),
        patterns: z.record(z.string(), z.int()),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(join(DIRECTORY, "sources.json"), "utf8")));

const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/u);
/** The Noise wiki's format, only the fields our two patterns use; anything else is ignored. */
const publishedVector = z.object({
  protocol_name: z.string(),
  fail: z.boolean().optional(),
  init_prologue: hex,
  init_psks: z.array(hex).optional(),
  init_static: hex.optional(),
  init_ephemeral: hex,
  init_remote_static: hex.optional(),
  resp_prologue: hex,
  resp_psks: z.array(hex).optional(),
  resp_static: hex.optional(),
  resp_ephemeral: hex,
  handshake_hash: hex.optional(),
  messages: z.array(z.object({ payload: hex, ciphertext: hex })),
});
type PublishedVector = z.infer<typeof publishedVector>;

function ours(file: string): readonly PublishedVector[] {
  const all = z
    .object({ vectors: z.array(z.unknown()) })
    .parse(JSON.parse(readFileSync(join(DIRECTORY, file), "utf8")));
  return all.vectors
    .filter((v) =>
      OUR_PATTERNS.includes(z.object({ protocol_name: z.string() }).parse(v).protocol_name),
    )
    .map((v) => publishedVector.parse(v));
}

function staticKey(privateHex: string | undefined) {
  const key = x25519StaticKey(fromHex(privateHex ?? ""));
  if (!key.ok) throw new Error("bad static key in a published vector");
  return key.value;
}

function ephemeral(privateHex: string) {
  const privateKey = fromHex(privateHex);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

function start(v: PublishedVector, initiator: boolean) {
  const pattern = v.protocol_name as NoisePattern;
  const side = initiator
    ? {
        prologue: v.init_prologue,
        psks: v.init_psks,
        s: v.init_static,
        e: v.init_ephemeral,
        rs: v.init_remote_static,
      }
    : {
        prologue: v.resp_prologue,
        psks: v.resp_psks,
        s: v.resp_static,
        e: v.resp_ephemeral,
        rs: undefined,
      };
  const psk = side.psks?.[0];
  const handshake = startHandshake({
    pattern,
    initiator,
    prologue: fromHex(side.prologue),
    staticKey: staticKey(side.s),
    ephemeral: ephemeral(side.e),
    ...(side.rs === undefined ? {} : { remoteStatic: fromHex(side.rs) }),
    // The XXpsk3 responder is given its key by `setPsk` after message 1 (m2-design.md section 5).
    ...(psk === undefined || !initiator ? {} : { psk: fromHex(psk) }),
  });
  if (!handshake.ok) throw new Error(`cannot start: ${handshake.error}`);
  return handshake.value;
}

/** Runs one vector: the messages alternate, initiator first, handshake then transport. */
async function run(v: PublishedVector): Promise<void> {
  const initiator = start(v, true);
  const responder = start(v, false);
  let initiatorTransport: TransportSession | undefined;
  let responderTransport: TransportSession | undefined;
  for (const [i, m] of v.messages.entries()) {
    const fromInitiator = i % 2 === 0;
    const payload = fromHex(m.payload);
    if (initiatorTransport === undefined || responderTransport === undefined) {
      const [writer, reader] = fromInitiator ? [initiator, responder] : [responder, initiator];
      const written = await writer.writeMessage(payload);
      expect(written.ok && toHex(written.value)).toBe(m.ciphertext);
      const read = await reader.readMessage(fromHex(m.ciphertext));
      expect(read.ok && toHex(read.value)).toBe(m.payload);
      const responderPsk = v.resp_psks?.[0];
      if (i === 0 && responderPsk !== undefined) {
        expect(responder.setPsk(fromHex(responderPsk)).ok).toBe(true);
      }
      if (initiator.complete && responder.complete) {
        if (v.handshake_hash !== undefined) {
          expect(toHex(initiator.handshakeHash())).toBe(v.handshake_hash);
          expect(toHex(responder.handshakeHash())).toBe(v.handshake_hash);
        }
        const a = initiator.split();
        const b = responder.split();
        if (!a.ok || !b.ok) throw new Error("split failed");
        initiatorTransport = a.value;
        responderTransport = b.value;
      }
    } else {
      const [writer, reader] = fromInitiator
        ? [initiatorTransport, responderTransport]
        : [responderTransport, initiatorTransport];
      const written = writer.encrypt(payload);
      expect(written.ok && toHex(written.value)).toBe(m.ciphertext);
      const read = reader.decrypt(fromHex(m.ciphertext));
      expect(read.ok && toHex(read.value)).toBe(m.payload);
    }
  }
  expect(initiatorTransport).toBeDefined();
}

describe("published Noise vectors (Noise revision 34)", () => {
  test.each(sources.files.map((f) => f.file))(
    "%s is the file its source published (SHA-256)",
    (file) => {
      const entry = sources.files.find((f) => f.file === file);
      expect(toHex(sha256(readFileSync(join(DIRECTORY, file))))).toBe(entry?.sha256 ?? "");
    },
  );

  test.each(sources.files.map((f) => f.file))(
    "%s holds the vectors sources.json counts",
    (file) => {
      const entry = sources.files.find((f) => f.file === file);
      const vectors = ours(file);
      for (const pattern of OUR_PATTERNS) {
        expect(vectors.filter((v) => v.protocol_name === pattern).length).toBe(
          entry?.patterns[pattern] ?? -1,
        );
      }
    },
  );

  test("both pattern names are covered by at least one published vector", () => {
    const all = sources.files.flatMap((f) => ours(f.file));
    for (const pattern of OUR_PATTERNS) {
      expect(all.some((v) => v.protocol_name === pattern)).toBe(true);
    }
  });

  for (const file of sources.files.map((f) => f.file)) {
    for (const [i, v] of ours(file).entries()) {
      test(`${file} #${i}: ${v.protocol_name}, ${v.messages.length} messages`, async () => {
        expect(v.fail ?? false).toBe(false);
        await run(v);
      });
    }
  }
});

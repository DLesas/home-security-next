/**
 * The file formats of the app channel's vectors, `packages/protocol/vectors/app-*.json`
 * (docs/m2-design.md section 10, "Protocol package"). Owner A1 writes the files against these
 * schemas; both ends test against them on every build. Bytes are lowercase hex, as in the device
 * protocol's vectors.
 */
import { z } from "zod";
import { NOISE_PATTERNS, type NoiseError } from "./noise-interface.ts";

const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/u, "lowercase hex");
const key32 = hex.length(64);

const keyPair = z.strictObject({ private: key32, public: key32 }).readonly();

const NOISE_ERRORS = [
  "allZeroDh",
  "badMessage",
  "decryptFailed",
  "wrongState",
  "tooLong",
  "nonceExhausted",
] as const satisfies readonly NoiseError[];

/** One handshake with fixed keys, as exact bytes (`app-noise.json`). */
export const noiseVector = z
  .strictObject({
    name: z.string(),
    pattern: z.enum([NOISE_PATTERNS.session, NOISE_PATTERNS.link]),
    purpose: z.enum(["session", "link", "restore"]),
    /** How the token was carried, for link and restore. */
    carrier: z.enum(["qr", "linkAddress", "typedCode", "console"]).optional(),
    prologue: hex,
    psk: key32.optional(),
    initiator: z.strictObject({ static: keyPair, ephemeral: keyPair }).readonly(),
    responder: z.strictObject({ static: keyPair, ephemeral: keyPair }).readonly(),
    /** Each handshake message in order, with its payload in clear. */
    messages: z
      .array(
        z
          .strictObject({
            from: z.enum(["initiator", "responder"]),
            payload: hex,
            message: hex,
          })
          .readonly(),
      )
      .readonly(),
    handshakeHash: key32,
    /** Transport messages after the split: one of every message kind (section 10). */
    transport: z
      .array(
        z
          .strictObject({
            from: z.enum(["initiator", "responder"]),
            plaintext: hex,
            message: hex,
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();

/** A handshake that must fail, and how (`app-noise-failures.json`). */
export const noiseFailureVector = z
  .strictObject({
    name: z.string(),
    pattern: z.enum([NOISE_PATTERNS.session, NOISE_PATTERNS.link]),
    /** Which side checks, and the message (by index) it is given. */
    side: z.enum(["initiator", "responder"]),
    prologue: hex,
    psk: key32.optional(),
    staticKey: keyPair,
    ephemeral: keyPair,
    remoteStatic: key32.optional(),
    /** The messages it is given, in order; the last is refused. */
    messages: z.array(hex).readonly(),
    expect: z.enum(NOISE_ERRORS).or(z.literal("identityMismatch")),
  })
  .readonly();

/** A typed code and what follows from it (`app-typed-code.json`). */
export const typedCodeVector = z
  .strictObject({
    code: z.string(),
    tokenId: z
      .int()
      .min(0)
      .max(2 ** 20 - 1),
    /** The 35-bit secret as its 5 bytes, big-endian. */
    secret: hex.length(10),
    lookup: z.string().length(4),
    psk: key32,
    /** Codes a person might type for the same token: each must read back to it, or be refused. */
    typed: z.array(z.strictObject({ text: z.string(), valid: z.boolean() }).readonly()).readonly(),
  })
  .readonly();

/** A 128-bit secret's lookup, pre-shared key and carriers (`app-link-secrets.json`). */
export const linkSecretVector = z
  .strictObject({
    secret: hex.length(32),
    lookup: hex.length(8),
    psk: key32,
    hubStaticPublic: key32,
    identity: z.string().length(26),
    qr: z.string(),
    linkAddress: z.string(),
  })
  .readonly();

/** An operation's body, accepted or refused by section 6's schemas (`app-schemas.json`). */
export const schemaVector = z
  .strictObject({
    op: z.string(),
    body: z.unknown(),
    valid: z.boolean(),
    why: z.string().optional(),
  })
  .readonly();

/** The same force availability value in a status line and an event body. */
const rolloutForceVector = z
  .strictObject({
    name: z.string(),
    valid: z.boolean(),
    statusLine: z.unknown(),
    deviceUpdate: z.unknown(),
  })
  .readonly();

/** A backup file and its parts (`app-backup.json`). */
export const backupVector = z
  .strictObject({
    name: z.string(),
    backupKey: key32,
    header: hex.length(128),
    database: hex,
    file: hex,
    /** A change to the file that must be refused, and how. */
    tamper: z
      .array(
        z
          .strictObject({
            file: hex,
            expect: z.enum(["badMagic", "badFormat", "truncated", "decryptFailed", "cut"]),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();

/** A release file's signature (`app-release.json`). */
export const releaseVector = z
  .strictObject({
    publisherKey: key32,
    file: hex,
    signature: hex.length(128),
    valid: z.boolean(),
  })
  .readonly();

/** Each vector file and the schema of its entries. */
export const APP_VECTOR_FILES = {
  "app-noise.json": noiseVector,
  "app-noise-failures.json": noiseFailureVector,
  "app-typed-code.json": typedCodeVector,
  "app-link-secrets.json": linkSecretVector,
  "app-schemas.json": schemaVector,
  "app-rollout-force.json": rolloutForceVector,
  "app-backup.json": backupVector,
  "app-release.json": releaseVector,
} as const;

/** A vector file: its entries, and where the published ones came from when they are not ours. */
export function vectorFile<T extends z.ZodType>(entry: T) {
  return z.strictObject({ description: z.string(), vectors: z.array(entry).readonly() }).readonly();
}

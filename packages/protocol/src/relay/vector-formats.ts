/**
 * The file formats of the relay's vectors (docs/m4-design.md section 11), frozen by the joint
 * step 0. B1 writes the files against these schemas; the hub, the relay, the iOS extension and
 * the Android service test against them. Bytes are lowercase hex, as in the other vectors.
 *
 * - `vectors/relay-push.json`: sealed pushes as exact bytes, and `h` strings that must not open.
 * - `vectors/relay-xn.json`: XN handshakes with the relay prologues, and the failures.
 * - `vectors/relay-frames.json`: text frames that must be accepted or refused, and binary frames
 *   with their bytes.
 */
import { z } from "zod";
import { NOISE_PATTERNS } from "../app/noise-interface.ts";
import { pushContent, pushH, pushKeyIdHex } from "./push.ts";

const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/u, "lowercase hex");
const hexBytes = (bytes: number) => hex.length(bytes * 2);
const key32 = hexBytes(32);
const keyPair = z.strictObject({ private: key32, public: key32 }).readonly();

/** Every file has the vectors' common header. */
const header = { schemaVersion: z.literal(1), description: z.string() };

// ----- relay-push.json -----

/** One push sealed with a fixed key, key id and nonce, as exact bytes. */
export const relayPushVector = z
  .strictObject({
    name: z.string(),
    key: key32,
    keyId: pushKeyIdHex,
    nonce: hexBytes(12),
    /** The content as an object, which `pushContent` accepts. */
    content: pushContent,
    /** The exact UTF-8 JSON that was sealed, as hex (key order as written). */
    contentJson: hex,
    /** The associated data: `hsn-push/1`, a zero byte, the key id. */
    aad: hex,
    /** The 1,280-byte plaintext: content, 0x80, zeros. */
    padded: hexBytes(1280),
    /** Nonce, ciphertext and tag, as hex. */
    sealed: hexBytes(12 + 1280 + 16),
    h: pushH,
  })
  .readonly();

/** An `h` that must not open, and why (`PushOpenError`). */
export const relayPushFailureVector = z
  .strictObject({
    name: z.string(),
    key: key32,
    keyId: pushKeyIdHex,
    /** Any string: the format failures are not of `pushH`'s form. */
    h: z.string(),
    expect: z.enum(["badFormat", "unknownKey", "decryptFailed", "badPadding", "badContent"]),
  })
  .readonly();

export const relayPushFile = z
  .strictObject({
    ...header,
    seal: z.array(relayPushVector).min(1).readonly(),
    open: z.array(relayPushFailureVector).readonly(),
  })
  .readonly();

// ----- relay-xn.json -----

const message = z
  .strictObject({ from: z.enum(["initiator", "responder"]), payload: hex, message: hex })
  .readonly();
const transport = z
  .strictObject({ from: z.enum(["initiator", "responder"]), plaintext: hex, message: hex })
  .readonly();

/**
 * One XN handshake with fixed keys (the app-noise vectors' shape). The initiator is the hub (or
 * a relay, on a relay link) and has a static key; the responder has none in XN.
 */
export const relayXnVector = z
  .strictObject({
    name: z.string(),
    pattern: z.literal(NOISE_PATTERNS.relay),
    /** `hub` (prologue `hsn-relay/1`) or `relay` (`hsn-relay-peer/1`). */
    link: z.enum(["hub", "relay"]),
    prologue: hex,
    initiator: z.strictObject({ static: keyPair, ephemeral: keyPair }).readonly(),
    responder: z.strictObject({ ephemeral: keyPair }).readonly(),
    /** Messages 1 to 3, with their payloads (`RelayHello`, `RelayWelcome`, `RelayJoin`) as UTF-8 JSON hex. */
    messages: z.array(message).length(3).readonly(),
    handshakeHash: key32,
    /** The identity the responder computes from the initiator's static key (26 characters). */
    identity: z.string().regex(/^[a-z2-7]{26}$/u),
    transport: z.array(transport).readonly(),
  })
  .readonly();

/** A handshake that must fail: a low-order key, a wrong prologue, message 3 against a new message 2. */
export const relayXnFailureVector = z
  .strictObject({
    name: z.string(),
    pattern: z.literal(NOISE_PATTERNS.relay),
    side: z.enum(["initiator", "responder"]),
    prologue: hex,
    /** The checking side's static key; absent for the responder, which has none. */
    staticKey: keyPair.optional(),
    ephemeral: keyPair,
    /** The messages it is given, in order; the last is refused. */
    messages: z.array(hex).min(1).readonly(),
    expect: z.enum(["allZeroDh", "badMessage", "decryptFailed", "wrongState", "tooLong"]),
  })
  .readonly();

export const relayXnFile = z
  .strictObject({
    ...header,
    handshakes: z.array(relayXnVector).min(1).readonly(),
    failures: z.array(relayXnFailureVector).readonly(),
  })
  .readonly();

// ----- relay-frames.json -----

/**
 * A long value written compactly (`relay-frames.json` only): either the value itself, or an array
 * of pieces joined in order, each piece the value's text itself or `{repeat, times}`, that text
 * written `times` times. For a hex field the pieces are hex and the joined text is the bytes'
 * hex; for a text field they are text. `expandCompact` in `vectors/compact.ts` joins them.
 */
const MAX_REPEAT = 16_777_216;
const repeatPiece = (unit: z.ZodString) =>
  z.strictObject({ repeat: unit, times: z.int().min(1).max(MAX_REPEAT) }).readonly();
const compactOf = (unit: z.ZodString, nonEmpty: z.ZodString) =>
  z.union([
    unit,
    z
      .array(z.union([unit, repeatPiece(nonEmpty)]))
      .min(1)
      .readonly(),
  ]);
/** Hex, or pieces of hex. */
export const compactHex = compactOf(hex, hex.min(2));
/** Text, or pieces of text. */
export const compactText = compactOf(z.string(), z.string().min(1));
export type CompactValue = z.infer<typeof compactText>;

/** A text frame as exact text, the link and direction it travels, and whether its schema accepts it. */
export const relayTextFrameVector = z
  .strictObject({
    name: z.string(),
    schema: z.enum(["hubToRelay", "relayToHub", "relayToPush", "pushToRelay"]),
    text: compactText,
    accept: z.boolean(),
  })
  .readonly();

/** A binary frame: its bytes and what they decode to, or the error. */
export const relayBinaryFrameVector = z
  .strictObject({
    name: z.string(),
    bytes: compactHex,
    frame: z
      .discriminatedUnion("kind", [
        z
          .strictObject({ kind: z.literal(1), stream: z.int().min(0), message: compactHex })
          .readonly(),
        z.strictObject({ kind: z.literal(2), id: z.int().min(0), bytes: compactHex }).readonly(),
      ])
      .optional(),
    expect: z.enum(["truncated", "unknownKind", "badLength"]).optional(),
  })
  .readonly()
  .refine((v) => (v.frame === undefined) !== (v.expect === undefined), "a frame or an error");

/**
 * A close code of a hub link or a relay link (`RELAY_CLOSE`), and what the side whose link it
 * closes does next: `backoff`, reconnect on its back-off; `wait`, wait `retryAfterMs` or 10
 * minutes first; `never`, stop and report it once, until its configuration changes or it restarts.
 */
export const relayCloseVector = z
  .strictObject({
    name: z.string(),
    code: z.int().min(1000).max(4999),
    reconnect: z.enum(["backoff", "wait", "never"]),
  })
  .readonly();

export const relayFramesFile = z
  .strictObject({
    ...header,
    text: z.array(relayTextFrameVector).min(1).readonly(),
    binary: z.array(relayBinaryFrameVector).min(1).readonly(),
    closes: z.array(relayCloseVector).min(1).readonly(),
  })
  .readonly();

/** The relay's vector files, by name. */
export const RELAY_VECTOR_FILES = {
  push: "relay-push.json",
  xn: "relay-xn.json",
  frames: "relay-frames.json",
} as const;

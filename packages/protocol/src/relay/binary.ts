/**
 * The binary frames of the hub link and the relay link (docs/m4-design.md section 3), behind the
 * frozen `RelayBinaryCodec`: byte 0 the kind, then a u32 little-endian, then the payload.
 *
 *   kind 1, stream data:   stream (u32 LE) ‖ one Noise message of a phone's connection, 1 to 65,535 bytes
 *   kind 2, release piece: request id (u32 LE, `release.get`'s `id`) ‖ the bytes, 1 to 262,144
 *
 * Decoding checks, in this order, so each refusal has one reason: no bytes at all (`truncated`);
 * byte 0 not 1 or 2 (`unknownKind`); fewer than 5 bytes (`truncated`); a payload of none, or past
 * its kind's bound (`badLength`). Every refusal closes the link with 4400 (`RELAY_CLOSE.badFrame`).
 * Encoding refuses what decoding would, and a stream or id that is not a u32 as `badLength` (four
 * bytes cannot hold it). Decoded payloads are copies. Nothing here throws.
 */
import { RELAY_LIMITS } from "./constants.ts";
import {
  RELAY_BINARY_HEADER_BYTES,
  RELAY_BINARY_KIND,
  type RelayBinaryCodec,
  type RelayBinaryError,
  type RelayBinaryFrame,
  type RelayFrameResult,
} from "./frames.ts";

/** The bounds of each kind's payload, and so the largest binary message on a link. */
export const RELAY_BINARY_LIMITS = {
  /** A kind 1 frame's Noise message: a phone's message, at most 65,535 bytes. */
  maxStreamMessageBytes: RELAY_LIMITS.maxPhoneMessageBytes,
  /** A kind 2 frame's bytes: at most a `release.get`'s largest `length`. */
  maxReleasePieceBytes: RELAY_LIMITS.maxReleasePieceBytes,
  /** The largest kind 1 frame: 65,540 bytes. */
  maxStreamFrameBytes: RELAY_BINARY_HEADER_BYTES + RELAY_LIMITS.maxPhoneMessageBytes,
  /** The largest binary frame on any link, a whole release piece: 262,149 bytes. */
  maxFrameBytes: RELAY_BINARY_HEADER_BYTES + RELAY_LIMITS.maxReleasePieceBytes,
} as const;

function refuse<T>(error: RelayBinaryError): RelayFrameResult<T> {
  return { ok: false, error };
}

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function payloadFits(kind: number, length: number): boolean {
  const max =
    kind === RELAY_BINARY_KIND.streamData
      ? RELAY_BINARY_LIMITS.maxStreamMessageBytes
      : RELAY_BINARY_LIMITS.maxReleasePieceBytes;
  return length >= 1 && length <= max;
}

function encode(frame: RelayBinaryFrame): RelayFrameResult<Uint8Array> {
  const kind: number = frame.kind;
  if (kind !== RELAY_BINARY_KIND.streamData && kind !== RELAY_BINARY_KIND.releasePiece)
    return refuse("unknownKind");
  const [number, payload] =
    frame.kind === RELAY_BINARY_KIND.streamData
      ? [frame.stream, frame.message]
      : [frame.id, frame.bytes];
  if (!isU32(number) || !payloadFits(kind, payload.length)) return refuse("badLength");
  const out = new Uint8Array(RELAY_BINARY_HEADER_BYTES + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, number, true);
  out.set(payload, RELAY_BINARY_HEADER_BYTES);
  return { ok: true, value: out };
}

function decode(bytes: Uint8Array): RelayFrameResult<RelayBinaryFrame> {
  const kind = bytes[0];
  if (kind === undefined) return refuse("truncated");
  if (kind !== RELAY_BINARY_KIND.streamData && kind !== RELAY_BINARY_KIND.releasePiece)
    return refuse("unknownKind");
  if (bytes.length < RELAY_BINARY_HEADER_BYTES) return refuse("truncated");
  const payload = bytes.slice(RELAY_BINARY_HEADER_BYTES);
  if (!payloadFits(kind, payload.length)) return refuse("badLength");
  const number = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
  return {
    ok: true,
    value:
      kind === RELAY_BINARY_KIND.streamData
        ? { kind: RELAY_BINARY_KIND.streamData, stream: number, message: payload }
        : { kind: RELAY_BINARY_KIND.releasePiece, id: number, bytes: payload },
  };
}

/** The binary frames' codec, against `vectors/relay-frames.json`. */
export const relayBinaryCodec: RelayBinaryCodec = { encode, decode };

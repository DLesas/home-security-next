/**
 * Transfer frames (m3-updates-design.md section 5, D137): one format on WebSocket, USB and
 * Bluetooth by which a device pulls an image in pieces. Not packets: they carry nothing secret
 * (the image is checked by the signed header's hash), so they are in the clear. Each frame is
 * one WebSocket message, one COBS frame on USB, or one Bluetooth write or notification, never
 * split. Every frame starts with 0xF2, which no packet (0x10, 0x18) and no setup message (0xF1)
 * starts with; then the kind byte; then the body, little-endian.
 *
 *   kind  name   from                     body after 0xF2 and the kind byte
 *   0x01  Get    device                   image id (8), offset u32, length u16
 *   0x02  Data   source (hub or phone)    image id (8), offset u32, CRC-32 of the data u32, data
 *   0x03  Gone   source                   image id (8), reason u8
 *   0x10  Hello  device, Bluetooth only   device address u32, device random (8), image id (8),
 *                                         bytes held u32, largest data u16
 *   0x11  Open   phone                    tag (16)
 *   0x12  Done   device, Bluetooth only   image id (8), result u8, reason u8 (an UpdateReason)
 *
 * Decoding never throws and encoding never throws: both return results. Offsets count from the
 * first byte of the 128-byte image header, which is the file's first piece.
 */
import { ByteReader, ByteWriter, isU32, MAX_U16, MAX_U8 } from "../bytes.ts";
import { fixedBytes, restOfBodyBetween, u16, u32, u8 } from "../codec/field.ts";
import { type Layout, layout, type LayoutValue, layoutMinLength } from "../codec/layout.ts";
import { IMAGE_ID_LENGTH } from "../messages/update.ts";
import { fail, failUnknownType, ok, type Result } from "../result.ts";
import { crc32 } from "./crc32.ts";

/** The first byte of every transfer frame. */
export const TRANSFER_PREFIX = 0xf2;

export const TransferKind = {
  Get: 0x01,
  Data: 0x02,
  Gone: 0x03,
  Hello: 0x10,
  Open: 0x11,
  Done: 0x12,
} as const;
export type TransferKind = (typeof TransferKind)[keyof typeof TransferKind];

/** Why a source answers a Get with Gone. */
export const GoneReason = {
  NotAvailable: 0,
  NotGranted: 1,
  /** A countdown or alarm runs: downloads resume when it ends, from their checkpoints. */
  Paused: 2,
  /** The Get asks for bytes outside the file. */
  OutOfRange: 3,
} as const;
export type GoneReason = (typeof GoneReason)[keyof typeof GoneReason];

/** Done's result. */
export const TransferResult = { Verified: 0, Refused: 1 } as const;
export type TransferResult = (typeof TransferResult)[keyof typeof TransferResult];

/** Hello's device random, which the phone's Open tag binds. */
export const DEVICE_RANDOM_LENGTH = 8;
/** Open's tag: the first 16 bytes of an HMAC-SHA256 (see bluetooth.ts). */
export const OPEN_TAG_LENGTH = 16;

/**
 * Sizes and pacing. The sizes are the format's; the counts and times are provisional values ‡
 * (R5), each to be measured on the boards and in spike S9.
 */
export const TRANSFER_LIMITS = {
  /** A Data frame's bytes before its data: prefix, kind, image id, offset, CRC. */
  dataHeaderBytes: 18,
  /**
   * The most data in one Data frame on any link, and so the most a Get may ask: on Wi-Fi and USB
   * a frame then stays inside the links' 1,024-byte buffers (§3, FD 1).
   */
  maxDataBytes: 1000,
  /** On Bluetooth, at most the ATT payload less the Data header: MTU − 3 − 18 ‡. */
  bluetoothAttOverheadBytes: 3,
  /** Gets outstanding at once ‡: Wi-Fi and USB, then Bluetooth. */
  outstandingGetsLink: 4,
  outstandingGetsBluetooth: 8,
  /** A Get unanswered this long is asked again ‡: Wi-Fi and USB, then Bluetooth. */
  reaskLinkMs: 2000,
  reaskBluetoothMs: 3000,
  /** The device's checkpoint: written every this many bytes ‡. */
  checkpointBytes: 64 * 1024,
  /** A device on a link sends Update status {fetching} every this many bytes ‡. */
  statusEveryBytes: 256 * 1024,
  /** The flash sector the device erases and writes as one, and so its buffer size. */
  sectorBytes: 4096,
} as const;

const imageId = fixedBytes(IMAGE_ID_LENGTH);

const getLayout = layout([
  ["imageId", imageId],
  ["offset", u32],
  ["length", u16],
]);
const dataLayout = layout([
  ["imageId", imageId],
  ["offset", u32],
  ["crc32", u32],
  ["data", restOfBodyBetween(1, TRANSFER_LIMITS.maxDataBytes)],
]);
const goneLayout = layout([
  ["imageId", imageId],
  // A GoneReason value; check with isEnumValue.
  ["reason", u8],
]);
const helloLayout = layout([
  ["address", u32],
  ["deviceRandom", fixedBytes(DEVICE_RANDOM_LENGTH)],
  ["imageId", imageId],
  ["bytesHeld", u32],
  ["largestData", u16],
]);
const openLayout = layout([["tag", fixedBytes(OPEN_TAG_LENGTH)]]);
const doneLayout = layout([
  ["imageId", imageId],
  // A TransferResult value; check with isEnumValue.
  ["result", u8],
  // An UpdateReason value; check with isEnumValue.
  ["reason", u8],
]);

const LAYOUTS = {
  [TransferKind.Get]: getLayout,
  [TransferKind.Data]: dataLayout,
  [TransferKind.Gone]: goneLayout,
  [TransferKind.Hello]: helloLayout,
  [TransferKind.Open]: openLayout,
  [TransferKind.Done]: doneLayout,
} as const;

type Variant<K extends TransferKind> = { readonly kind: K } & LayoutValue<(typeof LAYOUTS)[K]>;

export type GetFrame = Variant<typeof TransferKind.Get>;
/** A Data frame as read: `crc32` is the one it carried; check it with `isIntact`. */
export type DataFrame = Variant<typeof TransferKind.Data>;
export type GoneFrame = Variant<typeof TransferKind.Gone>;
export type HelloFrame = Variant<typeof TransferKind.Hello>;
export type OpenFrame = Variant<typeof TransferKind.Open>;
export type DoneFrame = Variant<typeof TransferKind.Done>;

/** A decoded transfer frame. */
export type TransferFrame = GetFrame | DataFrame | GoneFrame | HelloFrame | OpenFrame | DoneFrame;

/** A frame to send: a Data frame's CRC-32 is computed from its data, never given. */
export type TransferFrameToSend =
  GetFrame | Omit<DataFrame, "crc32"> | GoneFrame | HelloFrame | OpenFrame | DoneFrame;

/** Whether `bytes` is a transfer frame by its first byte (the shell's only look inside, R3). */
export function isTransferFrame(bytes: Uint8Array): boolean {
  return bytes[0] === TRANSFER_PREFIX;
}

/** Whether a Data frame's data matches the CRC-32 it carried. A mismatch is dropped and asked again. */
export function isIntact(frame: DataFrame): boolean {
  return crc32(frame.data) === frame.crc32;
}

function layoutOf(kind: number): Layout | undefined {
  switch (kind) {
    case TransferKind.Get:
      return LAYOUTS[TransferKind.Get];
    case TransferKind.Data:
      return LAYOUTS[TransferKind.Data];
    case TransferKind.Gone:
      return LAYOUTS[TransferKind.Gone];
    case TransferKind.Hello:
      return LAYOUTS[TransferKind.Hello];
    case TransferKind.Open:
      return LAYOUTS[TransferKind.Open];
    case TransferKind.Done:
      return LAYOUTS[TransferKind.Done];
    default:
      return undefined;
  }
}

/**
 * Reads one transfer frame. Empty or cut short: `truncated`; a first byte other than 0xF2:
 * `badValue`; an unknown kind: `unknownType` with the kind byte; a Get asking for 0 bytes or more
 * than `maxDataBytes`: `badValue`; Data with no data: `truncated`, with more than `maxDataBytes`:
 * `tooLong`. Bytes after a fixed frame's fields are ignored (§11's rule for extensions). A Data
 * frame's CRC is returned, not checked: see `isIntact`. Never throws.
 */
export function decodeTransferFrame(bytes: Uint8Array): Result<TransferFrame> {
  const reader = new ByteReader(bytes);
  const prefix = reader.u8();
  if (prefix === undefined) return fail("truncated");
  if (prefix !== TRANSFER_PREFIX) return fail("badValue");
  const kind = reader.u8();
  if (kind === undefined) return fail("truncated");
  const fields = layoutOf(kind);
  if (fields === undefined) return failUnknownType(kind);
  if (reader.remaining < layoutMinLength(fields)) return fail("truncated");
  const value: Record<string, unknown> = { kind };
  for (const [name, codec] of fields) {
    const field = codec.read(reader);
    if (!field.ok) return field;
    value[name] = field.value;
  }
  if (kind === TransferKind.Get) {
    const length = value.length;
    if (typeof length !== "number" || length < 1 || length > TRANSFER_LIMITS.maxDataBytes) {
      return fail("badValue");
    }
  }
  // `kind` chose `fields`, and the body was read with exactly those fields.
  return ok(value as unknown as TransferFrame);
}

const isU16 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= MAX_U16;
const isU8 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= MAX_U8;

/** Whether every field of a frame to send fits its place on the wire. */
function fits(frame: TransferFrameToSend): boolean {
  switch (frame.kind) {
    case TransferKind.Get:
      return (
        frame.imageId.length === IMAGE_ID_LENGTH &&
        isU32(frame.offset) &&
        isU16(frame.length) &&
        frame.length >= 1 &&
        frame.length <= TRANSFER_LIMITS.maxDataBytes
      );
    case TransferKind.Data:
      return (
        frame.imageId.length === IMAGE_ID_LENGTH &&
        isU32(frame.offset) &&
        frame.data.length >= 1 &&
        frame.data.length <= TRANSFER_LIMITS.maxDataBytes
      );
    case TransferKind.Gone:
      return frame.imageId.length === IMAGE_ID_LENGTH && isU8(frame.reason);
    case TransferKind.Hello:
      return (
        isU32(frame.address) &&
        frame.deviceRandom.length === DEVICE_RANDOM_LENGTH &&
        frame.imageId.length === IMAGE_ID_LENGTH &&
        isU32(frame.bytesHeld) &&
        isU16(frame.largestData)
      );
    case TransferKind.Open:
      return frame.tag.length === OPEN_TAG_LENGTH;
    case TransferKind.Done:
      return frame.imageId.length === IMAGE_ID_LENGTH && isU8(frame.result) && isU8(frame.reason);
  }
}

/**
 * Writes one transfer frame, computing a Data frame's CRC-32. A field that does not fit its
 * place (a wrong-length id, random or tag; an integer out of range; a Get or Data outside 1 to
 * `maxDataBytes`) is `badValue`. Never throws.
 */
export function encodeTransferFrame(frame: TransferFrameToSend): Result<Uint8Array> {
  if (!fits(frame)) return fail("badValue");
  const writer = new ByteWriter().u8(TRANSFER_PREFIX).u8(frame.kind);
  const value: Readonly<Record<string, unknown>> =
    frame.kind === TransferKind.Data ? { ...frame, crc32: crc32(frame.data) } : frame;
  const fields = layoutOf(frame.kind);
  if (fields === undefined) return fail("badValue");
  // `fits` checked every field, so no codec below can refuse its value.
  for (const [name, codec] of fields) codec.write(writer, value[name]);
  return ok(writer.finish());
}

/** The most data a Data frame may carry on Bluetooth at an agreed MTU. */
export function bluetoothMaxData(mtu: number): number {
  return Math.max(
    0,
    Math.min(
      TRANSFER_LIMITS.maxDataBytes,
      mtu - TRANSFER_LIMITS.bluetoothAttOverheadBytes - TRANSFER_LIMITS.dataHeaderBytes,
    ),
  );
}

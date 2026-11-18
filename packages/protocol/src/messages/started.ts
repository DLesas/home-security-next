/**
 * Started (0x05), section 6: sent once after every start-up. The hub always replies to a
 * sensor's Started, so the body needs no reply-wanted flag.
 *
 * M3 adds two fields at the end of the body (m3-updates-design.md section 5, section 11's rule for
 * extensions): the image flags at offset 8 and the failed version at offset 9. `decodeMessage`
 * reads Started's version-1 body and ignores bytes after it, as every older receiver does, so an
 * M1a device's 8-byte Started and an M3 device's 12-byte one decode the same there; the two new
 * fields are read by `decodeStartedImage` and written by `encodeStartedWithImage`.
 */
import { ByteReader, ByteWriter, concatBytes } from "../bytes.ts";
import { flagsByte, u16, u8 } from "../codec/field.ts";
import { type CodecValue, layout, layoutMinLength, struct } from "../codec/layout.ts";
import { fail, ok, type Result } from "../result.ts";
import { firmwareVersion } from "./common.ts";

/** Body of started: 8 bytes. */
export const startedLayout = layout([
  // A Role value; check with isEnumValue.
  ["role", u8],
  ["firmwareVersion", firmwareVersion],
  // As ESP-IDF reports it.
  ["resetCause", u8],
  // 0 for none (FW5).
  ["lastFatalError", u16],
  ["settingsVersion", u8],
]);

/** Image flags, bit 0 first (D134). */
export const STARTED_IMAGE_FLAGS = [
  // The running image is on trial (ESP-IDF's PENDING_VERIFY).
  "onTrial",
  // The other slot was rolled back (ABORTED or INVALID) since the last confirmed image.
  "rolledBack",
] as const;

/** Where the M3 fields start: right after the version-1 body. */
export const STARTED_IMAGE_OFFSET = layoutMinLength(startedLayout);

/** The M3 fields at the end of Started's body: 4 bytes, at offset 8. */
export const startedImageLayout = layout([
  ["flags", flagsByte(STARTED_IMAGE_FLAGS)],
  // The version that was rolled back; zeros for none.
  ["failedVersion", firmwareVersion],
]);

const startedImage = struct(startedImageLayout);

/** The image flags and failed version a Started carries from M3 on. */
export type StartedImage = CodecValue<typeof startedImage>;

/** Started's body with the M3 fields: 12 bytes. */
export const STARTED_WITH_IMAGE_LENGTH = STARTED_IMAGE_OFFSET + startedImage.minLength;

const STARTED_TYPE = 0x05;

/**
 * The M3 fields of a Started's plaintext (the type byte, then the body): `null` for a version-1
 * body of exactly 8 bytes (a device older than M3), the fields for a body of 12 bytes or more
 * (bytes after them ignored, as ever). A body of 9 to 11 bytes holds part of the fields and is
 * `truncated`, as is a body under 8 bytes; a plaintext whose type byte is not 0x05 is `badValue`.
 * Never throws.
 */
export function decodeStartedImage(plaintext: Uint8Array): Result<StartedImage | null> {
  if (plaintext.length === 0) return fail("truncated");
  if (plaintext[0] !== STARTED_TYPE) return fail("badValue");
  const body = plaintext.subarray(1);
  if (body.length < STARTED_IMAGE_OFFSET) return fail("truncated");
  if (body.length === STARTED_IMAGE_OFFSET) return ok(null);
  const reader = new ByteReader(body.subarray(STARTED_IMAGE_OFFSET));
  return startedImage.read(reader);
}

/**
 * A Started's plaintext with the M3 fields: the version-1 plaintext `encodeMessage` writes for
 * the same message, then the 4 bytes of `image`. Throws a RangeError for a value a field cannot
 * hold, as `encodeMessage` does.
 */
export function encodeStartedWithImage(
  version1Plaintext: Uint8Array,
  image: StartedImage,
): Uint8Array {
  if (
    version1Plaintext.length !== 1 + STARTED_IMAGE_OFFSET ||
    version1Plaintext[0] !== STARTED_TYPE
  ) {
    throw new RangeError("not a version-1 Started plaintext");
  }
  const writer = new ByteWriter();
  startedImage.write(writer, image);
  return concatBytes(version1Plaintext, writer.finish());
}

/** No image held: zeros, as an M3 device writes a failed version it does not have. */
export const NO_FAILED_VERSION = { major: 0, minor: 0, patch: 0 } as const;

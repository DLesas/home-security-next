/**
 * The device image header (m3-updates-design.md section 3, D136): 128 bytes, little-endian, made
 * and signed by the hub for every image it stores, official or an owner's own build. The file a
 * device pulls is this header followed by the image.
 *
 *   0   4  "HSNI"
 *   4   1  format 1
 *   5   1  flags: bit 0 an owner's own build (not from the publisher); other bits ignored
 *   6   1  roles: bit 1 sensor, bit 2 siren, bit 3 gateway (the bit is 1 << Role); others ignored
 *   7   1  target: 1, an ESP32-S3 board of ours
 *   8   3  version: major, minor, patch
 *   11  1  zero
 *   12  4  image bytes, u32
 *   16 32  SHA-256 of the image bytes; its first 8 bytes are the image id
 *   48  8  the identity of the hub that signed it (§9): SHA-256 of its 64-byte signing key, first 8
 *   56  8  zero
 *   64 64  ECDSA P-256 over SHA-256 of "hsn-image/1", a zero byte and bytes 0 to 63: r then s,
 *          32 bytes each, big-endian
 *
 * Signing is RFC 6979 deterministic (`@noble/curves`' P-256), so lockstep runs and vectors are
 * byte-identical (R8). Explicitly: the message is hashed once with SHA-256 (noble's
 * `prehash: true`) and `s` is NOT normalised to the lower half (`lowS: false`), so a signature is
 * exactly RFC 6979's; verifying accepts either half, as PSA on the device does.
 */
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter, concatBytes, isU32 } from "../bytes.ts";
import { flagsByte, fixedBytes, u32, u8 } from "../codec/field.ts";
import { type CodecValue, layout, struct } from "../codec/layout.ts";
import { HUB_IDENTITY_LENGTH, SIGNING_KEY_LENGTH } from "../crypto/signing-sizes.ts";
import { firmwareVersion, Role } from "../messages/common.ts";
import { IMAGE_ID_LENGTH, UpdateReason } from "../messages/update.ts";
import { fail, ok, type Result } from "../result.ts";

/** The header's fixed values. */
export const IMAGE_HEADER = {
  magic: "HSNI",
  format: 1,
  /** The whole header. */
  bytes: 128,
  /** The part the signature covers, after the label: bytes 0 to 63. */
  signedBytes: 64,
  signatureBytes: 64,
  /** The signed bytes start with this label and a zero byte. */
  label: "hsn-image/1",
  /** Where the image's SHA-256 starts; the image id is its first 8 bytes. */
  sha256Offset: 16,
} as const;

/** The header's target byte. */
export const ImageTarget = { OurEsp32s3Board: 1 } as const;
export type ImageTarget = (typeof ImageTarget)[keyof typeof ImageTarget];

/** Header flags, bit 0 first. */
export const IMAGE_HEADER_FLAGS = ["ownBuild"] as const;

/** The roles byte's bit for a role. */
export function roleBit(role: Role): number {
  return 1 << role;
}

/** Every role, as the roles byte has it today (D103: all three for every image). */
export const ALL_ROLES_MASK = roleBit(Role.Sensor) | roleBit(Role.Siren) | roleBit(Role.Gateway);

const signedFields = struct(
  layout([
    ["flags", flagsByte(IMAGE_HEADER_FLAGS)],
    // A mask of roleBit values.
    ["roles", u8],
    // An ImageTarget value; check with isEnumValue.
    ["target", u8],
    ["version", firmwareVersion],
    ["zero1", u8],
    ["imageBytes", u32],
    ["imageSha256", fixedBytes(32)],
    ["hubIdentity", fixedBytes(HUB_IDENTITY_LENGTH)],
    ["zero2", fixedBytes(8)],
  ]),
);

type RawFields = CodecValue<typeof signedFields>;

/** What the hub puts in a header; the magic, format and zero bytes are fixed. */
export type ImageHeaderFields = Omit<RawFields, "zero1" | "zero2">;

/** A header as read: its fields and its signature. */
export interface ImageHeader extends ImageHeaderFields {
  readonly signature: Uint8Array;
}

const encoder = new TextEncoder();
const MAGIC = encoder.encode(IMAGE_HEADER.magic);
const LABEL = concatBytes(encoder.encode(IMAGE_HEADER.label), Uint8Array.of(0));

function fieldsFit(fields: ImageHeaderFields): boolean {
  const byte = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xff;
  return (
    byte(fields.roles) &&
    byte(fields.target) &&
    byte(fields.version.major) &&
    byte(fields.version.minor) &&
    byte(fields.version.patch) &&
    isU32(fields.imageBytes) &&
    fields.imageSha256.length === 32 &&
    fields.hubIdentity.length === HUB_IDENTITY_LENGTH
  );
}

/**
 * Bytes 0 to 63 of a header: everything the signature covers. A field that does not fit is
 * `badValue`. Never throws.
 */
export function encodeImageHeaderBody(fields: ImageHeaderFields): Result<Uint8Array> {
  if (!fieldsFit(fields)) return fail("badValue");
  const writer = new ByteWriter().bytes(MAGIC).u8(IMAGE_HEADER.format);
  signedFields.write(writer, { ...fields, zero1: 0, zero2: new Uint8Array(8) });
  return ok(writer.finish());
}

/** What the signature is made over: the label, a zero byte, and bytes 0 to 63. */
export function imageHeaderSignedBytes(body: Uint8Array): Uint8Array {
  return concatBytes(LABEL, body.subarray(0, IMAGE_HEADER.signedBytes));
}

/**
 * A whole header, signed with the hub's P-256 private scalar (32 bytes, big-endian, exported
 * from `hub_keys` by the shell). A field that does not fit, or a scalar that is not a valid P-256
 * private key, is `badValue`. Never throws.
 */
export function signImageHeader(
  fields: ImageHeaderFields,
  privateScalar: Uint8Array,
): Result<Uint8Array> {
  const body = encodeImageHeaderBody(fields);
  if (!body.ok) return body;
  if (privateScalar.length !== 32 || !p256.utils.isValidSecretKey(privateScalar)) {
    return fail("badValue");
  }
  const signature = p256.sign(imageHeaderSignedBytes(body.value), privateScalar, {
    prehash: true,
    lowS: false,
    format: "compact",
  });
  return ok(concatBytes(body.value, signature));
}

/**
 * Reads a header: under 128 bytes is `truncated`; a wrong magic or a non-zero byte 11 or 56 to
 * 63 is `badValue`; a format other than 1 is `badVersion`. The target, roles and flags are
 * returned as read (unused flag and role bits are ignored). The signature is not checked here:
 * see `verifyImageHeader`. Bytes after 128 are not looked at. Never throws.
 */
export function decodeImageHeader(bytes: Uint8Array): Result<ImageHeader> {
  if (bytes.length < IMAGE_HEADER.bytes) return fail("truncated");
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return fail("badValue");
  if (bytes[4] !== IMAGE_HEADER.format) return fail("badVersion");
  const reader = new ByteReader(bytes.subarray(5, IMAGE_HEADER.bytes));
  const raw = signedFields.read(reader);
  if (!raw.ok) return raw;
  const { zero1, zero2, ...fields } = raw.value;
  if (zero1 !== 0 || zero2.some((b) => b !== 0)) return fail("badValue");
  const signature = reader.bytes(IMAGE_HEADER.signatureBytes);
  if (signature === undefined) return fail("truncated");
  return ok({ ...fields, signature });
}

/**
 * Whether a header's signature verifies under the hub's signing key: the 64 bytes X then Y, as
 * pairing data carries it (§9). Accepts either half of `s`, as PSA does. Never throws.
 */
export function verifyImageHeader(header: Uint8Array, signingKey: Uint8Array): boolean {
  if (header.length < IMAGE_HEADER.bytes || signingKey.length !== SIGNING_KEY_LENGTH) return false;
  const publicKey = concatBytes(Uint8Array.of(0x04), signingKey);
  if (!p256.utils.isValidPublicKey(publicKey, false)) return false;
  return p256.verify(
    header.subarray(IMAGE_HEADER.signedBytes, IMAGE_HEADER.bytes),
    imageHeaderSignedBytes(header),
    publicKey,
    { prehash: true, lowS: false, format: "compact" },
  );
}

/** The image id: bytes 16 to 23 of a header, the first 8 bytes of the image's SHA-256. */
export function imageIdOf(header: Uint8Array): Uint8Array {
  return header.slice(IMAGE_HEADER.sha256Offset, IMAGE_HEADER.sha256Offset + IMAGE_ID_LENGTH);
}

/** The §9 hub identity of a 64-byte signing key: the first 8 bytes of its SHA-256. */
export function signingKeyIdentity(signingKey: Uint8Array): Uint8Array {
  return sha256(signingKey).slice(0, HUB_IDENTITY_LENGTH);
}

/** The 64-byte public key (X then Y) of a P-256 private scalar, or undefined for an invalid one. */
export function signingKeyOf(privateScalar: Uint8Array): Uint8Array | undefined {
  if (privateScalar.length !== 32 || !p256.utils.isValidSecretKey(privateScalar)) return undefined;
  return p256.getPublicKey(privateScalar, false).slice(1);
}

/** What a device holds that the header is checked against. */
export interface HeaderExpectations {
  /** The paired hub's identity (§9). */
  readonly hubIdentity: Uint8Array;
  /** The paired hub's signing key, X then Y (§9). */
  readonly signingKey: Uint8Array;
  /** This device's role. */
  readonly role: Role;
  /** Bytes of the slot not running (`FirmwareSlots::capacity`). */
  readonly capacity: number;
}

/**
 * The checks a device makes before it writes a single byte, in the design's order (section 3,
 * "What a device checks"): 1. magic, format, target and zero bytes (`BadHeader`); 2. the hub
 * identity (`WrongHub`); 3. its role's bit (`WrongRole`); 4. the image within the slot
 * (`TooLarge`); 5. the signature (`BadSignature`). `None` when all pass. Never throws.
 */
export function checkImageHeader(header: Uint8Array, expect: HeaderExpectations): UpdateReason {
  const decoded = decodeImageHeader(header);
  if (!decoded.ok || decoded.value.target !== ImageTarget.OurEsp32s3Board) {
    return UpdateReason.BadHeader;
  }
  const fields = decoded.value;
  if (
    fields.hubIdentity.length !== expect.hubIdentity.length ||
    fields.hubIdentity.some((b, i) => b !== expect.hubIdentity[i])
  ) {
    return UpdateReason.WrongHub;
  }
  if ((fields.roles & roleBit(expect.role)) === 0) return UpdateReason.WrongRole;
  if (fields.imageBytes > expect.capacity) return UpdateReason.TooLarge;
  if (!verifyImageHeader(header, expect.signingKey)) return UpdateReason.BadSignature;
  return UpdateReason.None;
}

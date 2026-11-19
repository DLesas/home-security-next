/** Pairing data (section 9): what a device receives when it is added. */
import { ByteReader, ByteWriter } from "./bytes.ts";
import { HUB_IDENTITY_LENGTH, SIGNING_KEY_LENGTH } from "./crypto/signing-sizes.ts";
import { nodeSha256, type Sha256 } from "./crypto/sha256.ts";
import { fixedBytes, lengthPrefixedBytes, u32, u8, type FieldCodec } from "./codec/field.ts";
import { type CodecValue, layout, struct } from "./codec/layout.ts";
import { isValidAddress, KEY_LENGTH } from "./packet/header.ts";
import { fail, type Result } from "./result.ts";

export { HUB_IDENTITY_LENGTH, SIGNING_KEY_LENGTH } from "./crypto/signing-sizes.ts";

export const PAIRING_FORMAT_VERSION = 1;
export const MAX_WIFI_NAME_BYTES = 32;
export const MAX_WIFI_PASSWORD_BYTES = 64;

const pairingFields = struct(
  layout([
    ["address", u32],
    ["key", fixedBytes(KEY_LENGTH)],
    // See hubIdentity; not checked against the key when decoding.
    ["hubIdentity", fixedBytes(HUB_IDENTITY_LENGTH)],
    // P-256: X then Y, 32 bytes each, big-endian, without the leading 0x04.
    ["firmwareSigningKey", fixedBytes(SIGNING_KEY_LENGTH)],
    // A SiteChannel value; check with isEnumValue.
    ["siteChannel", u8],
    // One bit per data rate index; see dataRateMask.
    ["allowedDataRateMask", u8],
    // Bytes exactly as the network uses them, not text, so devices never check an encoding
    // (section 9); see wifiBytes. Both may be empty.
    ["wifiName", lengthPrefixedBytes(MAX_WIFI_NAME_BYTES)],
    ["wifiPassword", lengthPrefixedBytes(MAX_WIFI_PASSWORD_BYTES)],
  ]),
);

/** The fields after the format version byte. */
export type PairingData = CodecValue<typeof pairingFields>;

/** Pairing data as a field, so the provision setup message can carry it. */
export const pairingData: FieldCodec<PairingData> = {
  minLength: 1 + pairingFields.minLength,
  read(reader) {
    const version = reader.u8();
    if (version === undefined) return fail("truncated");
    if (version !== PAIRING_FORMAT_VERSION) return fail("badVersion");
    const fields = pairingFields.read(reader);
    if (fields.ok && !isValidAddress(fields.value.address)) return fail("badAddress");
    return fields;
  },
  write(writer, value) {
    if (!isValidAddress(value.address)) throw new RangeError("address must not be 0 or 0xFFFFFFFF");
    writer.u8(PAIRING_FORMAT_VERSION);
    pairingFields.write(writer, value);
  },
};

export function encodePairingData(data: PairingData): Uint8Array {
  const writer = new ByteWriter();
  pairingData.write(writer, data);
  return writer.finish();
}

/** Bytes after the known fields are ignored, as for message bodies. */
export function decodePairingData(bytes: Uint8Array): Result<PairingData> {
  return pairingData.read(new ByteReader(bytes));
}

/** A Wi-Fi name or password the user typed, as the UTF-8 bytes pairing data carries. */
export function wifiBytes(typed: string): Uint8Array {
  return new TextEncoder().encode(typed);
}

/**
 * The hub identity: the first 8 bytes of SHA-256 over the 64 signing-key bytes (section 9).
 * The hash is passed in like the block cipher, so the runtime-specific part stays in one place.
 */
export function hubIdentity(
  firmwareSigningKey: Uint8Array,
  sha256: Sha256 = nodeSha256,
): Uint8Array {
  if (firmwareSigningKey.length !== SIGNING_KEY_LENGTH) {
    throw new RangeError(`signing keys are ${SIGNING_KEY_LENGTH} bytes`);
  }
  return sha256(firmwareSigningKey).slice(0, HUB_IDENTITY_LENGTH);
}

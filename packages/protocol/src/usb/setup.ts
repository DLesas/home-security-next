/**
 * Setup messages (section 10): clear text, USB only, each starting with 0xF1, which no
 * encrypted packet starts with. A device ignores them on any other path.
 */
import { ByteReader, ByteWriter } from "../bytes.ts";
import { booleanByte, fixedBytes, u8 } from "../codec/field.ts";
import { layout, taggedUnion, type VariantOf } from "../codec/layout.ts";
import { firmwareVersion } from "../messages/common.ts";
import { HUB_IDENTITY_LENGTH, pairingData } from "../pairing.ts";
import { fail, type Result } from "../result.ts";

export const SETUP_MARKER = 0xf1;
export const CHIP_ID_LENGTH = 6;

export const SetupType = {
  Identify: 0x01,
  Identity: 0x02,
  Provision: 0x03,
  ProvisionResult: 0x04,
  Erase: 0x05,
} as const;
export type SetupType = (typeof SetupType)[keyof typeof SetupType];

export const ProvisionResultCode = { Accepted: 0, Refused: 1, NotValid: 2 } as const;
export type ProvisionResultCode = (typeof ProvisionResultCode)[keyof typeof ProvisionResultCode];

const setupLayouts = {
  // Hub to device, no body.
  [SetupType.Identify]: layout([]),
  // Device to hub.
  [SetupType.Identity]: layout([
    // A Role value; check with isEnumValue.
    ["role", u8],
    ["chipId", fixedBytes(CHIP_ID_LENGTH)],
    ["firmwareVersion", firmwareVersion],
    ["paired", booleanByte],
    // All zeros when not paired.
    ["hubIdentity", fixedBytes(HUB_IDENTITY_LENGTH)],
    ["developmentBuild", booleanByte],
  ]),
  // Hub to device.
  [SetupType.Provision]: layout([["pairing", pairingData]]),
  // Device to hub.
  [SetupType.ProvisionResult]: layout([
    // A ProvisionResultCode value; check with isEnumValue.
    ["result", u8],
  ]),
  // Hub to device, no body; development builds only.
  [SetupType.Erase]: layout([]),
} as const;

const setupCodec = taggedUnion(setupLayouts);

export type SetupMessage = VariantOf<typeof setupLayouts>;

/** True when bytes from the USB link are a setup message rather than a packet. */
export function isSetupMessage(bytes: Uint8Array): boolean {
  return bytes[0] === SETUP_MARKER;
}

export function encodeSetupMessage(message: SetupMessage): Uint8Array {
  const writer = new ByteWriter().u8(SETUP_MARKER);
  setupCodec.encode(writer, message);
  return writer.finish();
}

/**
 * A missing marker is `badValue`, an unknown second byte `unknownType`. Booleans must be 0 or
 * 1 (section 10). Bytes after the known fields are ignored.
 */
export function decodeSetupMessage(bytes: Uint8Array): Result<SetupMessage> {
  const reader = new ByteReader(bytes);
  const marker = reader.u8();
  if (marker === undefined) return fail("truncated");
  if (marker !== SETUP_MARKER) return fail("badValue");
  return setupCodec.decode(reader);
}

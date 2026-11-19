/**
 * Test images and pairings for the bench's tests and its smoke page, never for a real board: a hub signing key (RFC 6979's published P-256
 * test key, A.2.5, as the firmware's host bench uses), a pairing that holds its public half, and
 * files of a 128-byte signed header and an image of any size.
 */
import { createHash } from "node:crypto";
import { fromHex } from "../../../packages/protocol/src/bytes.ts";
import { Role } from "../../../packages/protocol/src/messages/common.ts";
import type { PairingData } from "../../../packages/protocol/src/pairing.ts";
import {
  ALL_ROLES_MASK,
  type ImageHeaderFields,
  imageIdOf,
  ImageTarget,
  signImageHeader,
  signingKeyIdentity,
  signingKeyOf,
} from "../../../packages/protocol/src/update/image-header.ts";

/** RFC 6979's published P-256 test key (A.2.5): a test key, never a real hub's. */
export const TEST_SIGNING_SCALAR = fromHex(
  "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721",
);

/** Its public half, X then Y (a test checks it is not the zeros put in place of none). */
export const TEST_SIGNING_KEY = signingKeyOf(TEST_SIGNING_SCALAR) ?? new Uint8Array(64);
export const TEST_HUB_IDENTITY = signingKeyIdentity(TEST_SIGNING_KEY);

/** A device key made for the test. */
export const TEST_DEVICE_KEY = fromHex("000102030405060708090a0b0c0d0e0f");

export function testPairing(overrides: Partial<PairingData> = {}): PairingData {
  return {
    address: 0x1a2b3c4d,
    key: TEST_DEVICE_KEY,
    hubIdentity: TEST_HUB_IDENTITY,
    firmwareSigningKey: TEST_SIGNING_KEY,
    siteChannel: 1,
    allowedDataRateMask: 0x20,
    wifiName: new TextEncoder().encode("bench-wifi"),
    wifiPassword: new TextEncoder().encode("made-for-the-test"),
    ...overrides,
  };
}

export interface TestImage {
  /** The header and the image, exactly what the device pulls. */
  readonly file: Uint8Array;
  readonly imageId: Uint8Array;
  readonly image: Uint8Array;
}

/** An image of `size` bytes (a pattern), signed by the test key, for every role. */
export function testImage(
  size: number,
  adjust: (fields: ImageHeaderFields) => ImageHeaderFields = (f) => f,
  scalar: Uint8Array = TEST_SIGNING_SCALAR,
): TestImage {
  const image = new Uint8Array(size);
  for (let i = 0; i < size; i++) image[i] = (i * 7 + 3) & 0xff;
  const fields: ImageHeaderFields = adjust({
    flags: { ownBuild: false },
    roles: ALL_ROLES_MASK,
    target: ImageTarget.OurEsp32s3Board,
    version: { major: 1, minor: 4, patch: 0 },
    imageBytes: size,
    imageSha256: new Uint8Array(createHash("sha256").update(image).digest()),
    hubIdentity: TEST_HUB_IDENTITY,
  });
  const signed = signImageHeader(fields, scalar);
  // A header that does not sign is all zeros, which every check refuses (`badHeader`).
  const header = signed.ok ? signed.value : new Uint8Array(128);
  const file = new Uint8Array(header.length + size);
  file.set(header, 0);
  file.set(image, header.length);
  return { file, imageId: imageIdOf(header), image };
}

export { Role };

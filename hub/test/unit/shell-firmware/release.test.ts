/**
 * A firmware release's head (`shell/firmware/release.ts`; docs/m3-updates-design.md section 3),
 * at the edges of each rule the staging job's tests cross only in the middle: a release signed by
 * either of two trusted publisher keys; every reserved byte; the manifest's 64 KB bound, exactly
 * at it and one byte over; a file cut anywhere inside its signature.
 */
import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { FIRMWARE_RELEASE } from "@hsn/protocol/release";
import { parseFirmwareHead, signedByOneOf } from "../../../src/shell/firmware/release.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { espImage, manifestOf, release, STRANGER_SEED } from "./support.ts";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The raw 32-byte public key of an Ed25519 seed, as the hub holds a publisher's. */
function publicOf(seed: Uint8Array): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

const payload = espImage({ size: 2000, seed: 3 });
const STRANGER_KEY = publicOf(STRANGER_SEED);

/** The head's refusal message, or "ok". */
function verdict(file: Uint8Array): string {
  const head = parseFirmwareHead(file);
  return head.isOk() ? "ok" : `${head.error.reason}: ${head.error.message}`;
}

/** A release whose manifest text is exactly `length` bytes: the manifest, then spaces. */
function withManifestOf(length: number): Uint8Array {
  const json = JSON.stringify(manifestOf(payload));
  expect(json.length).toBeLessThan(length);
  return release({ payload, manifestText: new TextEncoder().encode(json.padEnd(length, " ")) });
}

describe("the publisher's keys", () => {
  test("the tests derive the trusted key as the hub holds it", () => {
    expect(publicOf(new Uint8Array(32).fill(7))).toEqual(TEST_PUBLISHER_KEY);
  });

  test("a release signed by the second of two trusted keys is signed by one of them", () => {
    const head = parseFirmwareHead(release({ payload, seed: STRANGER_SEED }))._unsafeUnwrap();
    expect(signedByOneOf(head, [TEST_PUBLISHER_KEY, STRANGER_KEY])).toBe(true);
    expect(signedByOneOf(head, [STRANGER_KEY, TEST_PUBLISHER_KEY])).toBe(true);
    expect(signedByOneOf(head, [TEST_PUBLISHER_KEY])).toBe(false);
  });

  test("by the first of two: signed; by neither: not; with no keys: not", () => {
    const head = parseFirmwareHead(release({ payload }))._unsafeUnwrap();
    expect(signedByOneOf(head, [TEST_PUBLISHER_KEY, STRANGER_KEY])).toBe(true);
    const other = parseFirmwareHead(
      release({ payload, seed: new Uint8Array(32).fill(5) }),
    )._unsafeUnwrap();
    expect(signedByOneOf(other, [TEST_PUBLISHER_KEY, STRANGER_KEY])).toBe(false);
    expect(signedByOneOf(head, [])).toBe(false);
  });
});

describe("the fixed bytes", () => {
  test("each reserved byte, 5, 6 and 7, set alone is refused", () => {
    expect(verdict(release({ payload, reserved: [1, 0, 0] }))).toBe("badFile: reserved bytes set");
    expect(verdict(release({ payload, reserved: [0, 1, 0] }))).toBe("badFile: reserved bytes set");
    expect(verdict(release({ payload, reserved: [0, 0, 1] }))).toBe("badFile: reserved bytes set");
    expect(verdict(release({ payload, reserved: [0, 0, 0x80] }))).toBe(
      "badFile: reserved bytes set",
    );
    expect(verdict(release({ payload }))).toBe("ok");
  });
});

describe("the manifest's 64 KB bound", () => {
  test("exactly 64 KB is read; one byte more is refused", () => {
    expect(FIRMWARE_RELEASE.maxManifestBytes).toBe(64 * 1024);
    const at = withManifestOf(64 * 1024);
    const head = parseFirmwareHead(at)._unsafeUnwrap();
    expect(head.manifestText).toHaveLength(64 * 1024);
    expect(head.payloadOffset).toBe(12 + 64 * 1024 + 64);
    expect(signedByOneOf(head, [TEST_PUBLISHER_KEY])).toBe(true);
    expect(verdict(withManifestOf(64 * 1024 + 1))).toBe("badFile: no manifest");
  });
});

describe("a file cut inside its signature", () => {
  test("cut at each byte of the signature: the file is cut; whole, with no payload: read", () => {
    const file = release({ payload });
    const end = 12 + new DataView(file.buffer).getUint32(8, true);
    for (const kept of [0, 1, 32, 63]) {
      expect(verdict(file.slice(0, end + kept))).toBe("badFile: the file is cut");
    }
    const whole = parseFirmwareHead(file.slice(0, end + 64))._unsafeUnwrap();
    expect(whole.signature).toHaveLength(64);
    expect(whole.payloadOffset).toBe(end + 64);
    expect(signedByOneOf(whole, [TEST_PUBLISHER_KEY])).toBe(true);
  });
});

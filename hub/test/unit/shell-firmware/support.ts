/**
 * The firmware shell's tests' makings: ESP-IDF application images built to the layout as
 * `shell/firmware/layout.ts` states it (the same layout the firmware bench's `test_image.cpp`
 * writes), publisher releases (`.hsnf`) signed with the tests' published key, the hub's signing key
 * (RFC 6979's test key, as the vectors have it), and a temporary data folder.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRMWARE_RELEASE, type FirmwareManifest } from "@hsn/protocol/release";
import { Result } from "neverthrow";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { seededHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import { type HubSigner, signerOf } from "../../../src/shell/firmware/sign.ts";

export const RULES = DEFAULT_RULES.firmware;

/** RFC 6979 A.2.5's P-256 test key, the vectors' `signingPrivateKey`. */
export const RFC6979_SCALAR = Uint8Array.from(
  Buffer.from("c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721", "hex"),
);

/** The hub's signing key as `hub_keys` holds it, from RFC 6979's test key. */
export async function testHubKeys(): Promise<{
  readonly pkcs8: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly identity: Uint8Array;
  readonly signer: HubSigner;
}> {
  const row = (await seededHubKeys(RFC6979_SCALAR))._unsafeUnwrap();
  const signer = signerOf(row.signingPrivate, row.signingPublic, row.identity)._unsafeUnwrap();
  return {
    pkcs8: row.signingPrivate,
    publicKey: row.signingPublic,
    identity: row.identity,
    signer,
  };
}

/** The tests' publisher seed: 32 bytes of 7, whose public half is `TEST_PUBLISHER_KEY`. */
export const PUBLISHER_SEED = new Uint8Array(32).fill(7);

/** Another key's seed: a release it signs is signed by no trusted key. */
export const STRANGER_SEED = new Uint8Array(32).fill(9);

// ----- ESP-IDF application images -----

export interface EspImageSpec {
  readonly version?: string;
  /** Bytes at least (the image is this long or a little longer, for alignment). */
  readonly size?: number;
  readonly seed?: number;
  readonly chip?: number;
  /** Segments, each a multiple of 4; the first holds the app description. Default: one. */
  readonly segments?: number;
  /** 1 (the default) appends the SHA-256 after the checksum. */
  readonly hashAppended?: number;
  /** The app description's magic word. */
  readonly appDescMagic?: number;
}

function u32(out: Uint8Array, at: number, value: number): void {
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(at, value >>> 0, true);
}

/**
 * An ESP-IDF application image to the layout: the 24-byte header, segments (the first starting
 * with the 256-byte app description, its version at offset 16), zero padding so the checksum
 * byte ends a 16-byte block, the checksum (0xEF XOR every segment data byte), and the SHA-256 of
 * all before it when `hashAppended` is 1.
 */
export function espImage(spec: EspImageSpec = {}): Uint8Array {
  const version = spec.version ?? "1.4.0";
  const size = spec.size ?? 4096;
  const segments = spec.segments ?? 1;
  const hashAppended = spec.hashAppended ?? 1;
  const fixed = 24 + 8 * segments + 1 + (hashAppended === 1 ? 32 : 0);
  const room = Math.max(256 + 4 * (segments - 1), size - fixed);
  const extra = 4 * (segments - 1);
  const first = Math.ceil((room - extra) / 4) * 4;
  const lengths = [first, ...Array.from({ length: segments - 1 }, () => 4)];
  const body = 24 + lengths.reduce((sum, n) => sum + 8 + n, 0);
  const image = new Uint8Array(body);
  image[0] = 0xe9;
  image[1] = segments & 0xff;
  image[2] = 2;
  image[3] = 0x3f;
  u32(image, 4, 0x40375000);
  image[8] = 0xee;
  const chip = spec.chip ?? 9;
  image[12] = chip & 0xff;
  image[13] = chip >> 8;
  image[17] = 99;
  image[23] = hashAppended;
  let at = 24;
  let state = ((spec.seed ?? 1) * 2654435761 + 1) >>> 0;
  let checksum = 0xef;
  for (const [index, length] of lengths.entries()) {
    u32(image, at, 0x3c000020 + index * 0x10000);
    u32(image, at + 4, length);
    at += 8;
    const data = image.subarray(at, at + length);
    if (index === 0) {
      u32(data, 0, spec.appDescMagic ?? 0xabcd5432);
      data.set(new TextEncoder().encode(version).subarray(0, 31), 16);
      data.set(new TextEncoder().encode("hsn-bench"), 48);
      data.set(new TextEncoder().encode("v6.1.1"), 112);
    }
    for (let i = index === 0 ? 256 : 0; i < length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      data[i] = state >>> 24;
    }
    for (const byte of data) checksum ^= byte;
    at += length;
  }
  const padding = (16 - ((body + 1) % 16)) % 16;
  const withChecksum = new Uint8Array(body + padding + 1);
  withChecksum.set(image, 0);
  withChecksum[body + padding] = checksum;
  if (hashAppended !== 1) return withChecksum;
  const hash = createHash("sha256").update(withChecksum).digest();
  const out = new Uint8Array(withChecksum.length + 32);
  out.set(withChecksum, 0);
  out.set(hash, withChecksum.length);
  return out;
}

/** The SHA-256 of `bytes`. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

// ----- Publisher releases -----

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** An Ed25519 signature by the key of `seed`. */
export function ed25519(seed: Uint8Array, message: Uint8Array): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(sign(null, Buffer.from(message), key));
}

export interface ReleaseSpec {
  readonly payload: Uint8Array;
  /** Fields of the manifest to change or add (a field `undefined` is left out). */
  readonly manifest?: Readonly<Record<string, unknown>>;
  readonly seed?: Uint8Array;
  /** The manifest's text as given, not JSON of the fields. */
  readonly manifestText?: Uint8Array;
  readonly magic?: string;
  readonly format?: number;
  readonly reserved?: readonly number[];
}

/** The manifest a release of `payload` carries. */
export function manifestOf(payload: Uint8Array, version = "1.4.0"): FirmwareManifest {
  return {
    kind: "firmware",
    version,
    target: "esp32s3",
    roles: [1, 2, 3],
    payloadBytes: payload.length,
    payloadSha256: hex(sha256(payload)),
    madeMs: 1_700_000_000_000,
  };
}

/** A `.hsnf` file: the fixed bytes, the manifest, the signature over both, the payload. */
export function release(spec: ReleaseSpec): Uint8Array {
  const fields: Record<string, unknown> = { ...manifestOf(spec.payload), ...spec.manifest };
  for (const key of Object.keys(fields))
    if (fields[key] === undefined) Reflect.deleteProperty(fields, key);
  const text = spec.manifestText ?? new TextEncoder().encode(JSON.stringify(fields));
  const fixed = new Uint8Array(FIRMWARE_RELEASE.fixedBytes);
  fixed.set(new TextEncoder().encode(spec.magic ?? FIRMWARE_RELEASE.magic), 0);
  fixed[4] = spec.format ?? FIRMWARE_RELEASE.format;
  const reserved = spec.reserved ?? [0, 0, 0];
  fixed[5] = reserved[0] ?? 0;
  fixed[6] = reserved[1] ?? 0;
  fixed[7] = reserved[2] ?? 0;
  u32(fixed, 8, text.length);
  const head = Buffer.concat([fixed, text]);
  const label = Buffer.concat([Buffer.from(FIRMWARE_RELEASE.label), Buffer.of(0)]);
  const signature = ed25519(spec.seed ?? PUBLISHER_SEED, Buffer.concat([label, head]));
  return new Uint8Array(Buffer.concat([head, signature, spec.payload]));
}

// ----- Folders and jobs -----

export interface TempFolder {
  readonly path: string;
  remove(): void;
}

export function tempFolder(name: string): TempFolder {
  const path = mkdtempSync(join(tmpdir(), `hsn-fw-${name}-`));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** Runs a job's pieces to its end; the outcome and how many pieces it took. */
export function toEnd(pieces: { next(): FileOutcome | undefined }): {
  readonly outcome: FileOutcome;
  readonly pieces: number;
} {
  for (let n = 1; n < 100_000; n++) {
    const outcome = pieces.next();
    if (outcome !== undefined) return { outcome, pieces: n };
  }
  return { outcome: { kind: "failed", reason: "io", message: "never ended" }, pieces: 100_000 };
}

/** `Result.fromThrowable` for a test's own throwing call. */
export const attempt = Result.fromThrowable;

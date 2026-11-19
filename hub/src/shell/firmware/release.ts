/**
 * A publisher's firmware release, `hsn-firmware-<version>.hsnf` (docs/m3-updates-design.md section
 * 3), laid out exactly as a hub release (`shell/update/release.ts`) and read the same way:
 *
 * ```
 * 0   4  "HSNF"
 * 4   1  format 1
 * 5   3  zero
 * 8   4  the manifest's length, u32 little-endian, at most 64 KB ‡
 * 12  n  the manifest, UTF-8 JSON, `@hsn/protocol/release`'s `firmwareManifestSchema`
 * …  64  Ed25519 over "hsn-firmware/1", a zero byte, and every byte before the signature
 * …      the payload: the ESP-IDF application image, uncompressed
 * ```
 *
 * This file reads and checks the head (the fixed bytes, the manifest and its signature by one of
 * the publisher's keys) and says what the head's refusals are, in section 3's order; the payload's
 * own checks (its length, hash and ESP header) are the staging job's (`stage.ts`). The label
 * differs from a hub release's and from the image header's, so a signature made for one kind of
 * file never passes as another (D136).
 */
import {
  FIRMWARE_RELEASE,
  type FirmwareManifest,
  firmwareManifestSchema,
} from "@hsn/protocol/release";
import { err, ok, type Result } from "neverthrow";
import type { FileFailure } from "../../core/model/events.ts";
import { ed25519Verifies } from "../safe/firmware-io.ts";
import { parseJson } from "../safe/json.ts";

/** Why a firmware file was refused, as the core is told it (`fileReady {failed}`). */
export interface Refusal {
  readonly reason: FileFailure;
  readonly message: string;
}

export function refusal<T>(reason: FileFailure, message: string): Result<T, Refusal> {
  return err({ reason, message });
}

/** What a release's head says. */
export interface FirmwareHead {
  readonly manifest: FirmwareManifest;
  /** The manifest exactly as signed. */
  readonly manifestText: string;
  /** The label, a zero byte, and every byte before the signature. */
  readonly signed: Uint8Array;
  readonly signature: Uint8Array;
  readonly payloadOffset: number;
}

/** The bytes to read for the head: the fixed bytes, the largest manifest and the signature. */
export const HEAD_BYTES =
  FIRMWARE_RELEASE.fixedBytes + FIRMWARE_RELEASE.maxManifestBytes + FIRMWARE_RELEASE.signatureBytes;

const encoder = new TextEncoder();
const LABEL = Uint8Array.from([...encoder.encode(FIRMWARE_RELEASE.label), 0]);

function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * The head of a firmware release: `badFile` for a wrong magic, format, reserved byte or manifest
 * (one the schema refuses, or a file cut before its signature).
 */
export function parseFirmwareHead(head: Uint8Array): Result<FirmwareHead, Refusal> {
  if (head.length < FIRMWARE_RELEASE.fixedBytes) return refusal("badFile", "the file is cut");
  if (new TextDecoder().decode(head.subarray(0, 4)) !== FIRMWARE_RELEASE.magic)
    return refusal("badFile", "not a firmware release file");
  if (head[4] !== FIRMWARE_RELEASE.format)
    return refusal(
      "badFile",
      `firmware release format ${String(head[4])}: this hub reads format ${FIRMWARE_RELEASE.format}`,
    );
  if (head[5] !== 0 || head[6] !== 0 || head[7] !== 0)
    return refusal("badFile", "reserved bytes set");
  const length = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(8, true);
  if (length === 0 || length > FIRMWARE_RELEASE.maxManifestBytes)
    return refusal("badFile", "no manifest");
  const end = FIRMWARE_RELEASE.fixedBytes + length;
  if (head.length < end + FIRMWARE_RELEASE.signatureBytes)
    return refusal("badFile", "the file is cut");
  const bytes = head.subarray(FIRMWARE_RELEASE.fixedBytes, end);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // A manifest that is not UTF-8 decodes with replacement characters, which no longer encode to
  // the same bytes: refused, as the hub release's strict decoder refuses it.
  if (!sameBytes(encoder.encode(text), bytes))
    return refusal("badFile", "the manifest is not UTF-8");
  const json = parseJson(text, "config", "shell/firmware/release");
  const manifest = json.isOk() ? firmwareManifestSchema.safeParse(json.value) : undefined;
  if (manifest?.success !== true) return refusal("badFile", "the manifest is not valid");
  return ok({
    manifest: manifest.data,
    manifestText: text,
    signed: joined(LABEL, head.subarray(0, end)),
    signature: head.slice(end, end + FIRMWARE_RELEASE.signatureBytes),
    payloadOffset: end + FIRMWARE_RELEASE.signatureBytes,
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Whether one of `keys` (raw 32-byte Ed25519 keys) signed the head. */
export function signedByOneOf(head: FirmwareHead, keys: readonly Uint8Array[]): boolean {
  return keys.some((key) => ed25519Verifies(head.signed, head.signature, key));
}

/** The manifest and its signature as the `firmware_images` row keeps them (`manifest`). */
export function manifestColumn(head: FirmwareHead): string {
  return JSON.stringify({
    manifest: head.manifestText,
    signature: Buffer.from(head.signature).toString("hex"),
  });
}

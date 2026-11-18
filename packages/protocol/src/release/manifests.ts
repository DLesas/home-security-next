/**
 * The two kinds of signed release file and their manifests, in one place so the hub and the
 * relay's releases role read them with the same schemas (m4-design.md section 6;
 * m3-updates-design.md section 3). Both files have the same layout:
 *
 * ```
 * 0   4  magic: "HSNR" (hub release) or "HSNF" (firmware release)
 * 4   1  format: 2 for a hub release (format 1, a gzip'd tar, is refused), 1 for firmware
 * 5   3  zero
 * 8   4  the manifest's length, u32 little-endian
 * 12  n  the manifest, UTF-8 JSON, checked by the matching schema below
 * …  64  Ed25519 over the label, a zero byte, and every byte before the signature
 * …      the payload
 * ```
 *
 * The labels differ (`hsn-release/1`, `hsn-firmware/1`), and differ from the device image
 * header's `hsn-image/1`, so a signature made for one kind of file can never pass as another, even
 * with one publisher key for both (D136). Only the hub checks the signature, against
 * `PUBLISHER_KEYS`; the relay checks none. Reading and checking a file is the hub's shell's
 * (`hub/src/shell/update/release.ts`, and the firmware shell for `.hsnf`); this module freezes
 * the format, the names and the schemas.
 */
import { z } from "zod";

/** `MAJOR.MINOR.PATCH`: three decimal integers without leading zeros, compared as numbers. */
export const RELEASE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

/** A hub release file (`.hsnr`, m2-design.md section 9). */
export const HUB_RELEASE = {
  magic: "HSNR",
  format: 2,
  fixedBytes: 12,
  signatureBytes: 64,
  /** The signed bytes start with this label and a zero byte. */
  label: "hsn-release/1",
  extension: ".hsnr",
  /** The manifest's largest size ‡. */
  maxManifestBytes: 1024 * 1024,
  /** At most this many files ‡ ... */
  maxFiles: 4096,
  /** ... each at most this large ‡. */
  maxFileBytes: 256 * 1024 * 1024,
  /** A path's largest size, in bytes. */
  maxPathBytes: 255,
  /** The whole file, at most: M2's upload cap (m4-design.md section 6), checked before fetching. */
  maxReleaseBytes: 256 * 1024 * 1024,
} as const;

/** The systems a hub release is built for. */
export const RELEASE_PLATFORMS = [
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

/** One file of a hub release's payload. */
export const releaseFileSchema = z
  .strictObject({
    path: z.string(),
    bytes: z.int().min(0).max(HUB_RELEASE.maxFileBytes),
    sha256: sha256Hex,
    executable: z.boolean(),
  })
  .readonly();
export type ReleaseFile = z.infer<typeof releaseFileSchema>;

/**
 * A hub release's manifest. What the schema cannot say (safe, unique paths; sizes adding up to
 * `payloadBytes`) is the hub's `manifestProblem`.
 */
export const hubManifestSchema = z
  .strictObject({
    version: z.string().regex(RELEASE_VERSION),
    platform: z.enum(RELEASE_PLATFORMS),
    madeMs: z.int().min(0),
    payloadBytes: z.int().min(1),
    payloadSha256: sha256Hex,
    files: z.array(releaseFileSchema).min(1).max(HUB_RELEASE.maxFiles).readonly(),
  })
  .readonly();
export type HubManifest = z.infer<typeof hubManifestSchema>;

/** A firmware release file (`.hsnf`, m3-updates-design.md section 3). */
export const FIRMWARE_RELEASE = {
  magic: "HSNF",
  format: 1,
  fixedBytes: 12,
  signatureBytes: 64,
  /** The signed bytes start with this label and a zero byte. */
  label: "hsn-firmware/1",
  extension: ".hsnf",
  /** The manifest's largest size ‡. */
  maxManifestBytes: 64 * 1024,
  /** The whole file, at most ‡: an upload, a fetch through the relay, refused before fetching. */
  maxReleaseBytes: 8 * 1024 * 1024,
  /** The only target today. */
  target: "esp32s3",
  /**
   * An application slot (D134, the partition table's 3.5 MB): a payload larger than this is
   * refused `tooLarge`, after the signature and the target.
   */
  slotBytes: 3_670_016,
} as const;

/** A role a firmware image serves: 1 sensor, 2 siren, 3 gateway (as `Role`). */
const firmwareRole = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * A firmware release's manifest. Its `target` is any short name here, so a file for another
 * board is refused `wrongTarget` after its signature (section 3's order), not `badFile`; likewise
 * `payloadBytes` is bounded only by the file's own cap here, and the slot's limit is
 * `firmwareManifestRefusal`'s. `roles` is a non-empty set of roles, each once.
 */
export const firmwareManifestSchema = z
  .strictObject({
    kind: z.literal("firmware"),
    version: z.string().regex(RELEASE_VERSION),
    target: z.string().regex(/^[a-z0-9_-]{1,32}$/u),
    roles: z
      .array(firmwareRole)
      .min(1)
      .max(3)
      .refine((roles) => new Set(roles).size === roles.length, "each role once")
      .readonly(),
    payloadBytes: z.int().min(1).max(FIRMWARE_RELEASE.maxReleaseBytes),
    payloadSha256: sha256Hex,
    madeMs: z.int().min(0),
  })
  .readonly();
export type FirmwareManifest = z.infer<typeof firmwareManifestSchema>;

/**
 * The refusals a valid firmware manifest can still draw, after its signature verified, in
 * section 3's order: a target other than `esp32s3` (`wrongTarget`), then a payload over the slot
 * (`tooLarge`). Undefined when neither applies. The checks of the payload itself (its length and
 * hash, the ESP image header) are the hub's shell's.
 */
export function firmwareManifestRefusal(
  manifest: FirmwareManifest,
): "wrongTarget" | "tooLarge" | undefined {
  if (manifest.target !== FIRMWARE_RELEASE.target) return "wrongTarget";
  if (manifest.payloadBytes > FIRMWARE_RELEASE.slotBytes) return "tooLarge";
  return undefined;
}

/** A hub release's file name: `hsn-hub-<version>-<platform>.hsnr`. */
export function hubReleaseFileName(version: string, platform: ReleasePlatform): string {
  return `hsn-hub-${version}-${platform}${HUB_RELEASE.extension}`;
}

/** A firmware release's file name: `hsn-firmware-<version>.hsnf`. */
export function firmwareReleaseFileName(version: string): string {
  return `hsn-firmware-${version}${FIRMWARE_RELEASE.extension}`;
}

const HUB_FILE_NAME = new RegExp(
  `^hsn-hub-(${RELEASE_VERSION.source.slice(1, -1)})-(${RELEASE_PLATFORMS.join("|")})\\.hsnr$`,
  "u",
);
const FIRMWARE_FILE_NAME = new RegExp(
  `^hsn-firmware-(${RELEASE_VERSION.source.slice(1, -1)})\\.hsnf$`,
  "u",
);

/** What a release's file name says, or undefined for a name that is neither kind's. */
export type ReleaseFileName =
  | { readonly kind: "hub"; readonly version: string; readonly platform: ReleasePlatform }
  | { readonly kind: "firmware"; readonly version: string };

/** Reads a file name in the releases folder (the relay's releases role). Never throws. */
export function parseReleaseFileName(name: string): ReleaseFileName | undefined {
  const hub = HUB_FILE_NAME.exec(name);
  if (hub !== null) {
    const platform = RELEASE_PLATFORMS.find((p) => p === hub[5]);
    const version = hub[1];
    return platform === undefined || version === undefined
      ? undefined
      : { kind: "hub", version, platform };
  }
  const firmware = FIRMWARE_FILE_NAME.exec(name);
  const version = firmware?.[1];
  return version === undefined ? undefined : { kind: "firmware", version };
}

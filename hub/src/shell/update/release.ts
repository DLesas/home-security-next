/**
 * The release file (m2-design.md section 9, "Hub updates"; D84), `hsn-hub-<version>-<platform>.hsnr`:
 *
 * ```
 * 0   4  "HSNR"
 * 4   1  format 2 (format 1, a gzip'd tar, is refused)
 * 5   3  zero
 * 8   4  the manifest's length, u32 little-endian, at most 1 MiB ‡
 * 12  n  the manifest, UTF-8 JSON
 *        {version, platform, madeMs, payloadBytes, payloadSha256, files: [{path, bytes, sha256, executable}]}
 * …  64  Ed25519 over "hsn-release/1", a zero byte, and every byte before the signature
 * …      the payload: the files' bytes, uncompressed, concatenated in the manifest's order
 * ```
 *
 * The manifest is signed and the payload bound by its hash; each file has its own. The hub holds
 * no decompressor and no archive reader: the only bytes it interprets are the manifest's, through
 * JSON and the Zod schema below, and the rules `manifestProblem` adds (paths, sizes, counts). `version` is `MAJOR.MINOR.PATCH`, three
 * decimal integers without leading zeros, compared as numbers, major first; no pre-release suffix.
 * Ed25519 is node's (`node:crypto`), wrapped by `Result.fromThrowable` here.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import type { FileFailure } from "../../core/model/events.ts";
import { joined } from "../backup/files.ts";

export const RELEASE = {
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
} as const;

/** One part of a path: 1 to 64 of `A-Z a-z 0-9 . _ -`, never `.` or `..`. */
const PATH_PART = /^[A-Za-z0-9._-]{1,64}$/u;

/** Whether a release's path is one the hub may write under the version's folder. */
export function isSafePath(path: string): boolean {
  if (new TextEncoder().encode(path).length > RELEASE.maxPathBytes) return false;
  return path.split("/").every((part) => PATH_PART.test(part) && part !== "." && part !== "..");
}

export const RELEASE_PLATFORMS = [
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

export const releaseFileSchema = z
  .strictObject({
    path: z.string(),
    bytes: z.int().min(0).max(RELEASE.maxFileBytes),
    sha256: sha256Hex,
    executable: z.boolean(),
  })
  .readonly();
export type ReleaseFile = z.infer<typeof releaseFileSchema>;

export const manifestSchema = z
  .strictObject({
    version: z.string().regex(VERSION),
    platform: z.enum(RELEASE_PLATFORMS),
    madeMs: z.int().min(0),
    payloadBytes: z.int().min(1),
    payloadSha256: sha256Hex,
    files: z.array(releaseFileSchema).min(1).max(RELEASE.maxFiles).readonly(),
  })
  .readonly();
export type Manifest = z.infer<typeof manifestSchema>;

/**
 * What the schema cannot say of a manifest (section 9): every path safe and unique (folders are
 * implied, so a path that is another's folder is refused too), and the files' sizes adding up to
 * `payloadBytes`. Undefined when there is nothing wrong.
 */
export function manifestProblem(manifest: Manifest): string | undefined {
  const seen = new Set<string>();
  let sum = 0;
  for (const file of manifest.files) {
    if (!isSafePath(file.path)) return `a path that may not be written: ${file.path}`;
    if (seen.has(file.path)) return `a path twice: ${file.path}`;
    seen.add(file.path);
    sum += file.bytes;
  }
  for (const path of seen) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join("/"))) return `a file where a folder must be: ${path}`;
  }
  if (sum !== manifest.payloadBytes)
    return `the files' sizes add up to ${sum}, the manifest says ${manifest.payloadBytes}`;
  return undefined;
}

/** A version's three numbers, or undefined when it is not `MAJOR.MINOR.PATCH`. */
export function versionNumbers(version: string): readonly [number, number, number] | undefined {
  const m = VERSION.exec(version);
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether `a` is above `b`, as numbers, major first; false for a version that is not one. */
export function isNewer(a: string, b: string): boolean {
  const x = versionNumbers(a);
  const y = versionNumbers(b);
  if (x === undefined || y === undefined) return false;
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** This computer's platform as a release names it, or undefined for one no release is for. */
export function platformOf(platform: NodeJS.Platform, arch: string): ReleasePlatform | undefined {
  const name = `${platform === "win32" ? "windows" : platform}-${arch}`;
  return (RELEASE_PLATFORMS as readonly string[]).includes(name)
    ? (name as ReleasePlatform)
    : undefined;
}

export interface RefusedRelease {
  readonly reason: FileFailure;
  readonly message: string;
}

function refused<T>(reason: FileFailure, message: string): Result<T, RefusedRelease> {
  return err({ reason, message });
}

/** What the release's head says, with where its payload starts. */
export interface ReleaseHead {
  readonly manifest: Manifest;
  readonly signed: Uint8Array;
  readonly signature: Uint8Array;
  readonly payloadOffset: number;
}

const encoder = new TextEncoder();

function label(): Uint8Array {
  return Uint8Array.from([...encoder.encode(RELEASE.label), 0]);
}

/** The head of a release file: its fixed bytes, manifest and signature (`badFile` otherwise). */
export function parseHead(head: Uint8Array): Result<ReleaseHead, RefusedRelease> {
  if (head.length < RELEASE.fixedBytes) return refused("badFile", "the file is cut");
  if (new TextDecoder().decode(head.subarray(0, 4)) !== RELEASE.magic)
    return refused("badFile", "not a release file");
  if (head[4] !== RELEASE.format)
    return refused(
      "badFile",
      `release format ${String(head[4])}: this hub reads format ${RELEASE.format}`,
    );
  if (head[5] !== 0 || head[6] !== 0 || head[7] !== 0)
    return refused("badFile", "reserved bytes set");
  const length = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(8, true);
  if (length === 0 || length > RELEASE.maxManifestBytes) return refused("badFile", "no manifest");
  const end = RELEASE.fixedBytes + length;
  if (head.length < end + RELEASE.signatureBytes) return refused("badFile", "the file is cut");
  const json = Result.fromThrowable(
    (): unknown =>
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(RELEASE.fixedBytes, end)),
      ),
    () => undefined,
  )();
  const manifest = json.isOk() ? manifestSchema.safeParse(json.value) : undefined;
  if (manifest?.success !== true) return refused("badFile", "the manifest is not valid");
  const problem = manifestProblem(manifest.data);
  if (problem !== undefined) return refused("badFile", problem);
  return ok({
    manifest: manifest.data,
    signed: joined([label(), head.subarray(0, end)]),
    signature: head.slice(end, end + RELEASE.signatureBytes),
    payloadOffset: end + RELEASE.signatureBytes,
  });
}

function publicKey(raw: Uint8Array) {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") },
    format: "jwk",
  });
}

/** Whether one of `keys` signed the head (Ed25519; a key that is not one verifies nothing). */
export function signedByOneOf(head: ReleaseHead, keys: readonly Uint8Array[]): boolean {
  return keys.some((key) =>
    Result.fromThrowable(
      () => verify(null, head.signed, publicKey(key), head.signature),
      () => false,
    )().unwrapOr(false),
  );
}

/** The 32-byte public key of a 32-byte Ed25519 seed (the release tool and the tests). */
export function publicOfSeed(seed: Uint8Array): Result<Uint8Array, string> {
  return Result.fromThrowable(
    () => {
      const jwk = createPublicKey(privateOfSeed(seed)).export({ format: "jwk" });
      return Uint8Array.from(Buffer.from(String(jwk.x), "base64url"));
    },
    (thrown) => String(thrown),
  )();
}

function privateOfSeed(seed: Uint8Array) {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seed),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** A whole release file, signed with the seed's key (the release tool and the tests). */
export function makeRelease(
  manifest: Manifest,
  payload: Uint8Array,
  seed: Uint8Array,
): Result<Uint8Array, string> {
  const json = encoder.encode(JSON.stringify(manifest));
  const fixed = new Uint8Array(RELEASE.fixedBytes);
  fixed.set(encoder.encode(RELEASE.magic), 0);
  fixed[4] = RELEASE.format;
  new DataView(fixed.buffer).setUint32(8, json.length, true);
  const head = joined([fixed, json]);
  return Result.fromThrowable(
    () => new Uint8Array(sign(null, Buffer.concat([label(), head]), privateOfSeed(seed))),
    (thrown) => String(thrown),
  )().map((signature) => joined([head, signature, payload]));
}

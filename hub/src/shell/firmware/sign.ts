/**
 * The hub's signature of an image header (docs/m3-updates-design.md section 3, D35, D136): the
 * 128-byte header made for every image the hub stores, official or an owner's own build, signed
 * with the hub's P-256 key (`hub_keys.signing_private`), deterministically (RFC 6979, through
 * `@hsn/protocol/update`'s `signImageHeader`), so the same image gives the same header on every
 * run and the vectors' headers exactly.
 *
 * The private scalar is read out of `hub_keys` when a header is made and dropped after it: it
 * leaves the shell only into a backup (HD 5), never into the core, a record or an event.
 */
import type { Database } from "bun:sqlite";
import {
  ALL_ROLES_MASK,
  ImageTarget,
  type ImageHeaderFields,
  roleBit,
  signImageHeader,
  signingKeyOf,
  verifyImageHeader,
} from "@hsn/protocol/update";
import type { Role } from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import { readHubKeysRow } from "../app/app-keys.ts";
import { p256ScalarOf } from "../safe/firmware-io.ts";

/** The hub's signing key as the header needs it: the scalar, its public half, its identity. */
export interface HubSigner {
  readonly scalar: Uint8Array;
  /** X then Y, 64 bytes (§9). */
  readonly publicKey: Uint8Array;
  /** The first 8 bytes of the public key's SHA-256 (§9). */
  readonly identity: Uint8Array;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The signer from a `hub_keys` row's three columns; the scalar must be the public key's. */
export function signerOf(
  pkcs8: Uint8Array,
  publicKey: Uint8Array,
  identity: Uint8Array,
): Result<HubSigner, string> {
  const scalar = p256ScalarOf(pkcs8);
  if (scalar.isErr()) return err(scalar.error);
  const derived = signingKeyOf(scalar.value);
  if (derived === undefined || !same(derived, publicKey))
    return err("the hub's stored signing key is not its public key's");
  return ok({ scalar: scalar.value, publicKey, identity });
}

/** The signer from the hub's database, on the writer's connection. */
export function hubSigner(db: Database): Result<HubSigner, string> {
  const row = readHubKeysRow(db);
  if (row.isErr()) return err(row.error.message);
  if (row.value === undefined) return err("the hub has no signing key yet");
  return signerOf(row.value.signingPrivate, row.value.signingPublic, row.value.identity);
}

/** A version's three numbers, each a byte, or undefined for one a header cannot carry. */
export function headerVersion(
  version: string,
): { readonly major: number; readonly minor: number; readonly patch: number } | undefined {
  const parts = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/u.exec(version);
  if (parts === null) return undefined;
  const [major, minor, patch] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (major > 255 || minor > 255 || patch > 255) return undefined;
  return { major, minor, patch };
}

/** The roles byte for a release's roles (1 sensor, 2 siren, 3 gateway); every role for an own build. */
export function rolesMask(roles: readonly Role[] | "all"): number {
  if (roles === "all") return ALL_ROLES_MASK;
  return roles.reduce((mask, role) => mask | roleBit(role), 0);
}

/** What the hub knows of an image when it makes its header. */
export interface ImageFacts {
  readonly ownBuild: boolean;
  readonly roles: number;
  readonly version: { readonly major: number; readonly minor: number; readonly patch: number };
  readonly imageBytes: number;
  readonly imageSha256: Uint8Array;
}

/** The header's fields: the facts, the hub's identity, an ESP32-S3 board of ours. */
export function headerFields(facts: ImageFacts, signer: HubSigner): ImageHeaderFields {
  return {
    flags: { ownBuild: facts.ownBuild },
    roles: facts.roles,
    target: ImageTarget.OurEsp32s3Board,
    version: facts.version,
    imageBytes: facts.imageBytes,
    imageSha256: facts.imageSha256,
    hubIdentity: signer.identity,
  };
}

/**
 * The image's 128-byte header, signed, and checked against the hub's public key before it is
 * given back, as a device will check it.
 */
export function makeHeader(facts: ImageFacts, signer: HubSigner): Result<Uint8Array, string> {
  const header = signImageHeader(headerFields(facts, signer), signer.scalar);
  if (!header.ok) return err(`the image's header could not be made (${header.error.code})`);
  if (!verifyImageHeader(header.value, signer.publicKey))
    return err("the image's header did not verify under the hub's own key");
  return ok(header.value);
}

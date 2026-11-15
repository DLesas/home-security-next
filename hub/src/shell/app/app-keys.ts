/**
 * The hub's keys for apps (m2-design.md sections 4 and 5), the shell's part of `hub_keys`: the
 * static X25519 key of every Noise handshake, whose hash is the hub's app identity, and the TLS
 * key and certificate of the apps' listener. Both are made at the first start of M2 and kept, so
 * a browser that trusted the certificate once is not asked again (D105); the certificate is made
 * again when it lacks a name or address of the computer, or reaches 700 days ‡.
 *
 * Written now, as one full `hub_keys` row (HD 2: every write a full value), before the boot event
 * reads the snapshot, as `advertise/hub-keys.ts` writes the signing keys. The private keys are
 * held in memory by the session layer and the listener only: never returned in an error, logged,
 * recorded or sent.
 */
import type { Database } from "bun:sqlite";
import { appIdentityBytes, x25519StaticKey } from "@hsn/protocol/app";
import { sha256 } from "@noble/hashes/sha2.js";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { HubKeysRow } from "../../core/model/rows.ts";
import type { Writer } from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";
import {
  type CertificateInfo,
  type CertificateNames,
  makeCertificate,
  readCertificate,
  renewalReason,
  storedMaterial,
  type TlsMaterial,
} from "./certificate.ts";

const ORIGIN = "shell/app/app-keys";

/** An X25519 private key's length. */
const STATIC_KEY_BYTES = 32;

/** The app keys as the shell holds them while it runs. */
export interface AppKeyMaterial {
  /** X25519, 32 bytes: the session layer's, never anyone else's. */
  readonly staticPrivate: Uint8Array;
  readonly staticPublic: Uint8Array;
  /** The first 16 bytes of SHA-256 of `staticPublic` (section 5). */
  readonly identity: Uint8Array;
  readonly tls: TlsMaterial;
  readonly certificate: CertificateInfo;
}

/** What making keys needs: random bytes from the system's generator. */
export type RandomBytes = (length: number) => Result<Uint8Array, HubError>;

function configError(message: string): HubError {
  return { kind: "config", origin: ORIGIN, message };
}

/** The whole `hub_keys` row, private columns included, read on the writer's connection. */
export function readHubKeysRow(db: Database): Result<HubKeysRow | undefined, HubError> {
  return sqlite(ORIGIN, "read the hub's keys", () =>
    db
      .query<
        {
          sp: Uint8Array;
          pub: Uint8Array;
          id: Uint8Array;
          asp: Uint8Array | null;
          apub: Uint8Array | null;
          tk: Uint8Array | null;
          tc: Uint8Array | null;
        },
        []
      >(
        `SELECT "signing_private" AS sp, "signing_public" AS pub, "identity" AS id,
                "app_static_private" AS asp, "app_static_public" AS apub,
                "tls_private" AS tk, "tls_certificate" AS tc FROM "hub_keys"`,
      )
      .get(),
  ).map((row) =>
    row === null
      ? undefined
      : {
          signingPrivate: new Uint8Array(row.sp),
          signingPublic: new Uint8Array(row.pub),
          identity: new Uint8Array(row.id),
          appStaticPrivate: row.asp === null ? null : new Uint8Array(row.asp),
          appStaticPublic: row.apub === null ? null : new Uint8Array(row.apub),
          tlsPrivate: row.tk === null ? null : new Uint8Array(row.tk),
          tlsCertificate: row.tc === null ? null : new Uint8Array(row.tc),
        },
  );
}

/** The stored static key, when its public half is its private half's. */
function storedStatic(
  row: HubKeysRow,
): { privateKey: Uint8Array; publicKey: Uint8Array } | undefined {
  const privateKey = row.appStaticPrivate;
  if (privateKey?.length !== STATIC_KEY_BYTES || row.appStaticPublic === null) return undefined;
  const key = x25519StaticKey(privateKey);
  if (!key.ok) return undefined;
  const stored = row.appStaticPublic;
  const same =
    stored.length === key.value.publicKey.length &&
    stored.every((b, i) => b === key.value.publicKey[i]);
  return same ? { privateKey, publicKey: key.value.publicKey } : undefined;
}

function newStatic(
  random: RandomBytes,
): Result<{ privateKey: Uint8Array; publicKey: Uint8Array }, HubError> {
  return random(STATIC_KEY_BYTES).andThen((privateKey) => {
    const key = x25519StaticKey(privateKey);
    return key.ok
      ? ok({ privateKey, publicKey: key.value.publicKey })
      : err(configError("the app key could not be made"));
  });
}

/** The stored TLS pair, when it is usable for `names` now; else a new one. */
function tlsFor(
  row: HubKeysRow,
  names: CertificateNames,
  nowMs: number,
  random: RandomBytes,
): Result<{ tls: TlsMaterial; info: CertificateInfo; made: boolean }, HubError> {
  const stored = storedMaterial(row.tlsPrivate, row.tlsCertificate);
  if (stored.isOk()) {
    const info = readCertificate(stored.value.certificate);
    if (info.isOk() && renewalReason(info.value, names, nowMs) === undefined) {
      return ok({ tls: stored.value, info: info.value, made: false });
    }
  }
  return random(16)
    .andThen((serial) => makeCertificate(names, nowMs, serial))
    .andThen((tls) => readCertificate(tls.certificate).map((info) => ({ tls, info, made: true })));
}

/**
 * The app keys at start, or after the computer's names changed: those stored when they are still
 * good, otherwise new ones, written now as one full `hub_keys` row and committed before this
 * returns. The signing keys must exist already (`ensureHubKeys`), since they share the row.
 */
export function ensureAppKeys(
  db: Database,
  writer: Pick<Writer, "stage" | "flush">,
  names: CertificateNames,
  nowMs: number,
  random: RandomBytes,
): Result<AppKeyMaterial, HubError> {
  const read = readHubKeysRow(db);
  if (read.isErr()) return err(read.error);
  const row = read.value;
  if (row === undefined) return err(configError("the hub's signing keys must be made first"));
  const kept = storedStatic(row);
  const key = kept === undefined ? newStatic(random) : ok(kept);
  if (key.isErr()) return err(key.error);
  const tls = tlsFor(row, names, nowMs, random);
  if (tls.isErr()) return err(tls.error);
  const material: AppKeyMaterial = {
    staticPrivate: key.value.privateKey,
    staticPublic: key.value.publicKey,
    identity: appIdentityBytes(sha256, key.value.publicKey),
    tls: tls.value.tls,
    certificate: tls.value.info,
  };
  if (kept !== undefined && !tls.value.made) return ok(material);
  const next: HubKeysRow = {
    ...row,
    appStaticPrivate: material.staticPrivate,
    appStaticPublic: material.staticPublic,
    tlsPrivate: material.tls.privateKey,
    tlsCertificate: material.tls.certificate,
  };
  writer.stage([
    { kind: "write", durability: "now", op: { table: "hub_keys", op: "upsert", row: next } },
  ]);
  const committed = writer.flush("now");
  return committed.isOk() ? ok(material) : err(committed.error);
}

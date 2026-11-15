/**
 * The backup file (docs/m2-design.md section 9, "Backup, export and restore"), behind the frozen
 * `backup-interface.ts`: a 64-byte header, then the database in chunks of 64 KiB, each sealed
 * with ChaCha20-Poly1305 (stack.md) under a key made for this file:
 *
 * - the file's key: HKDF-SHA256 with the backup key as input key material, the header's 8-byte
 *   salt as salt and the ASCII text `hsn-backup/1` as info, 32 bytes;
 * - chunk i's nonce: four zero bytes, then i as 8 bytes big-endian;
 * - chunk i's associated data: the 64-byte header, then one byte, 1 on the last chunk and 0 on
 *   every other, so a file cut at a chunk's end fails (`cut`) and a header changed fails
 *   (`decryptFailed`).
 *
 * Every chunk but the last holds exactly 64 KiB of the database; the last holds the rest, from 0
 * bytes (an empty database is one empty chunk, so a file is never only its header) to 64 KiB.
 * The file's key is wiped after use. Nothing here throws, and no error carries key or content.
 *
 * One implementation, in pieces (`backupSealer`, `backupOpener`), so a seal or an open never holds
 * the hub's loop past section 3's limit; the one-call `seal` and `open` are made of it.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  BACKUP_FORMAT,
  BACKUP_KNOWN_FLAGS,
  type BackupCodec,
  type BackupError,
  type BackupHeader,
  type BackupOpener,
  type BackupResult,
  type BackupSealer,
} from "./backup-interface.ts";

const TAG_BYTES = 16;
const IDENTITY_BYTES = 16;
const RESERVED_AT = 54;
const SEALED_CHUNK_BYTES = BACKUP_FORMAT.chunkBytes + TAG_BYTES;
const MAX_U32 = 0xffff_ffff;

function ok<T>(value: T): BackupResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: BackupError): BackupResult<T> {
  return { ok: false, error };
}

function isU32(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_U32;
}

function isWallMs(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/** The header's 64 bytes, laid out as `BACKUP_HEADER_LAYOUT` says; `badFormat` for a bad field. */
export function encodeBackupHeader(header: BackupHeader): BackupResult<Uint8Array> {
  const valid =
    header.format === BACKUP_FORMAT.format &&
    Number.isInteger(header.flags) &&
    (header.flags & ~BACKUP_KNOWN_FLAGS) === 0 &&
    header.flags >= 0 &&
    header.identity.length === IDENTITY_BYTES &&
    isU32(header.epoch) &&
    isWallMs(header.madeMs) &&
    isU32(header.schema) &&
    header.salt.length === BACKUP_FORMAT.saltBytes &&
    isWallMs(header.lastChangeMs);
  if (!valid) return fail("badFormat");
  const out = new Uint8Array(BACKUP_FORMAT.headerBytes);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(BACKUP_FORMAT.magic), 0);
  out[4] = header.format;
  out[5] = header.flags;
  out.set(header.identity, 6);
  view.setUint32(22, header.epoch, true);
  view.setBigUint64(26, BigInt(header.madeMs), true);
  view.setUint32(34, header.schema, true);
  out.set(header.salt, 38);
  view.setBigUint64(46, BigInt(header.lastChangeMs), true);
  return ok(out);
}

/** Reads the header's 64 bytes; refuses a nonzero reserved byte or an unknown flag bit. */
export function decodeBackupHeader(file: Uint8Array): BackupResult<BackupHeader> {
  if (file.length < BACKUP_FORMAT.headerBytes) return fail("truncated");
  const bytes = file.slice(0, BACKUP_FORMAT.headerBytes);
  const view = new DataView(bytes.buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== BACKUP_FORMAT.magic) return fail("badMagic");
  const format = bytes[4] ?? 0;
  const flags = bytes[5] ?? 0;
  if (format !== BACKUP_FORMAT.format) return fail("badFormat");
  if ((flags & ~BACKUP_KNOWN_FLAGS) !== 0) return fail("badFormat");
  if (bytes.subarray(RESERVED_AT).some((b) => b !== 0)) return fail("badFormat");
  const madeMs = view.getBigUint64(26, true);
  const lastChangeMs = view.getBigUint64(46, true);
  const maxMs = BigInt(Number.MAX_SAFE_INTEGER);
  if (madeMs > maxMs || lastChangeMs > maxMs) return fail("badFormat");
  return ok({
    format,
    flags,
    identity: bytes.slice(6, 22),
    epoch: view.getUint32(22, true),
    madeMs: Number(madeMs),
    schema: view.getUint32(34, true),
    salt: bytes.slice(38, 46),
    lastChangeMs: Number(lastChangeMs),
  });
}

/** The file's key: HKDF-SHA256(backup key, salt, `hsn-backup/1`), 32 bytes. */
export function backupFileKey(backupKey: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, backupKey, salt, new TextEncoder().encode(BACKUP_FORMAT.info), 32);
}

/** Chunk i's nonce: four zero bytes, then i as 8 bytes big-endian. */
export function backupChunkNonce(chunk: number): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(chunk), false);
  return nonce;
}

/** Chunk i's associated data: the header, then 1 on the last chunk and 0 on the others. */
export function backupChunkAd(header: Uint8Array, last: boolean): Uint8Array {
  const ad = new Uint8Array(header.length + 1);
  ad.set(header);
  ad[header.length] = last ? 1 : 0;
  return ad;
}

function sealChunk(
  key: Uint8Array,
  header: Uint8Array,
  i: number,
  last: boolean,
  data: Uint8Array,
) {
  return chacha20poly1305(key, backupChunkNonce(i), backupChunkAd(header, last)).encrypt(data);
}

function openChunk(
  key: Uint8Array,
  header: Uint8Array,
  i: number,
  last: boolean,
  sealed: Uint8Array,
): Uint8Array | undefined {
  try {
    return chacha20poly1305(key, backupChunkNonce(i), backupChunkAd(header, last)).decrypt(sealed);
  } catch {
    return undefined;
  }
}

// ----- In pieces (section 9, "Sealing and opening in pieces") -----

/**
 * Seals a backup in pieces. It holds at most one chunk's plaintext, 65,536 bytes, and each `add`
 * seals only the chunks its own bytes complete, the latest held back until more bytes or `finish`
 * say whether it is the last. After `finish`, every call is refused as `finished`.
 */
export class PieceSealer implements BackupSealer {
  readonly headerBytes: Uint8Array;
  private readonly key: Uint8Array;
  private readonly held = new Uint8Array(BACKUP_FORMAT.chunkBytes);
  private fill = 0;
  private index = 0;
  private done = false;

  constructor(key: Uint8Array, headerBytes: Uint8Array) {
    this.key = key;
    this.headerBytes = headerBytes;
  }

  add(plain: Uint8Array): BackupResult<readonly Uint8Array[]> {
    if (this.done) return fail("finished");
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < plain.length) {
      // A full chunk with more bytes after it is not the last.
      if (this.fill === this.held.length) out.push(this.sealHeld(false));
      const n = Math.min(this.held.length - this.fill, plain.length - at);
      this.held.set(plain.subarray(at, at + n), this.fill);
      this.fill += n;
      at += n;
    }
    return ok(out);
  }

  /**
   * Seals what is held as the last chunk; an empty database is one empty last chunk, as the
   * vectors have it.
   */
  finish(): BackupResult<Uint8Array> {
    if (this.done) return fail("finished");
    const last = this.sealHeld(true);
    this.end();
    return ok(last);
  }

  /** What it holds, for tests of its bound and of wiping. */
  holding(): { readonly bytes: number; readonly key: Uint8Array; readonly held: Uint8Array } {
    return { bytes: this.fill, key: this.key, held: this.held };
  }

  private sealHeld(last: boolean): Uint8Array {
    const sealed = sealChunk(
      this.key,
      this.headerBytes,
      this.index,
      last,
      this.held.subarray(0, this.fill),
    );
    this.index += 1;
    this.fill = 0;
    return sealed;
  }

  private end(): void {
    this.done = true;
    this.key.fill(0);
    this.held.fill(0);
  }
}

/**
 * Opens a backup in pieces. It holds at most one sealed chunk, 65,552 bytes, and releases a chunk's
 * plaintext only once its tag has verified: a chunk followed by more bytes is opened as not the
 * last, the one held at `finish` as the last. The first failure ends it: the key and what it holds
 * are wiped, and every later call is refused as `finished`.
 */
export class PieceOpener implements BackupOpener {
  readonly header: BackupHeader;
  private readonly headerBytes: Uint8Array;
  private readonly key: Uint8Array;
  private readonly held = new Uint8Array(SEALED_CHUNK_BYTES);
  private fill = 0;
  private index = 0;
  private ended: BackupError | "finished" | undefined = undefined;

  constructor(key: Uint8Array, header: BackupHeader, headerBytes: Uint8Array) {
    this.key = key;
    this.header = header;
    this.headerBytes = headerBytes;
  }

  add(sealed: Uint8Array): BackupResult<readonly Uint8Array[]> {
    if (this.ended !== undefined) return this.refused();
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < sealed.length) {
      // A whole chunk with more bytes after it: it must open as one that is not the last.
      if (this.fill === this.held.length) {
        const opened = this.openHeld(false);
        if (opened === undefined) return this.fail("decryptFailed");
        out.push(opened);
      }
      const n = Math.min(this.held.length - this.fill, sealed.length - at);
      this.held.set(sealed.subarray(at, at + n), this.fill);
      this.fill += n;
      at += n;
    }
    return ok(out);
  }

  /**
   * The file has ended: the held chunk must open as the last. Nothing held, or less than a tag, is
   * `truncated`; a whole chunk that opens only as not the last is `cut`; any other is
   * `decryptFailed`, as the vectors have them.
   */
  finish(): BackupResult<Uint8Array> {
    if (this.ended !== undefined) return this.refused();
    if (this.fill < TAG_BYTES) return this.fail("truncated");
    const opened = this.openHeld(true);
    if (opened !== undefined) {
      this.end("finished");
      return ok(opened);
    }
    const wasNotLast =
      openChunk(this.key, this.headerBytes, this.index, false, this.held.subarray(0, this.fill)) !==
      undefined;
    return this.fail(wasNotLast ? "cut" : "decryptFailed");
  }

  /** What it holds, for tests of its bound and of wiping. */
  holding(): { readonly bytes: number; readonly key: Uint8Array; readonly held: Uint8Array } {
    return { bytes: this.fill, key: this.key, held: this.held };
  }

  private openHeld(last: boolean): Uint8Array | undefined {
    const opened = openChunk(
      this.key,
      this.headerBytes,
      this.index,
      last,
      this.held.subarray(0, this.fill),
    );
    if (opened !== undefined) {
      this.index += 1;
      this.fill = 0;
    }
    return opened;
  }

  /** After `finish` or a failure, every call is refused as `finished` (section 9). */
  private refused<T>(): BackupResult<T> {
    return fail("finished");
  }

  private fail<T>(error: BackupError): BackupResult<T> {
    this.end(error);
    return fail(error);
  }

  private end(how: BackupError | "finished"): void {
    this.ended = how;
    this.key.fill(0);
    this.held.fill(0);
  }
}

/**
 * Starts sealing: `badFormat` for a key that is not 32 bytes or a header that cannot be written.
 * It takes no deps: its primitives are `@noble`'s (section 9).
 */
export function backupSealer(
  backupKey: Uint8Array,
  header: BackupHeader,
): BackupResult<PieceSealer> {
  if (backupKey.length !== BACKUP_FORMAT.keyBytes) return fail("badFormat");
  const encoded = encodeBackupHeader(header);
  if (!encoded.ok) return encoded;
  return ok(new PieceSealer(backupFileKey(backupKey, header.salt), encoded.value));
}

/**
 * Starts opening from the file's 64 header bytes: the header's own refusals (`readHeader`'s), and
 * `decryptFailed` for a key that is not 32 bytes.
 */
export function backupOpener(
  backupKey: Uint8Array,
  headerBytes: Uint8Array,
): BackupResult<PieceOpener> {
  if (headerBytes.length > BACKUP_FORMAT.headerBytes) return fail("badFormat");
  const header = decodeBackupHeader(headerBytes);
  if (!header.ok) return header;
  if (backupKey.length !== BACKUP_FORMAT.keyBytes) return fail("decryptFailed");
  return ok(
    new PieceOpener(backupFileKey(backupKey, header.value.salt), header.value, headerBytes.slice()),
  );
}

function concatChunks(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ----- In one call, over the pieces -----

function seal(
  backupKey: Uint8Array,
  header: BackupHeader,
  database: Uint8Array,
): BackupResult<Uint8Array> {
  const sealer = backupSealer(backupKey, header);
  if (!sealer.ok) return sealer;
  const chunks = sealer.value.add(database);
  if (!chunks.ok) return chunks;
  const last = sealer.value.finish();
  if (!last.ok) return last;
  return ok(concatChunks([sealer.value.headerBytes, ...chunks.value, last.value]));
}

function open(
  backupKey: Uint8Array,
  file: Uint8Array,
): BackupResult<{ readonly header: BackupHeader; readonly database: Uint8Array }> {
  if (file.length < BACKUP_FORMAT.headerBytes) return fail("truncated");
  const opener = backupOpener(backupKey, file.subarray(0, BACKUP_FORMAT.headerBytes));
  if (!opener.ok) return opener;
  const chunks = opener.value.add(file.subarray(BACKUP_FORMAT.headerBytes));
  if (!chunks.ok) return chunks;
  const last = opener.value.finish();
  if (!last.ok) {
    for (const chunk of chunks.value) chunk.fill(0);
    return last;
  }
  const database = concatChunks([...chunks.value, last.value]);
  for (const chunk of chunks.value) chunk.fill(0);
  return ok({ header: opener.value.header, database });
}

export const backupCodec: BackupCodec = {
  seal,
  readHeader: decodeBackupHeader,
  open,
};

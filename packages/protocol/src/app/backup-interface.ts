/**
 * The backup file's format and interface (docs/m2-design.md section 9, "Backup, export and
 * restore"), not its implementation: owner A1 writes `backup.ts` and its vectors.
 *
 * `hsn-<identity>-<UTC date and time>.hsnb`: a 64-byte header, then a SQLite database of the
 * backup's tables, encrypted in chunks of 64 KiB with ChaCha20-Poly1305. The key is HKDF-SHA256
 * of the backup key with the salt and the text `hsn-backup/1`; each chunk's nonce is four zero
 * bytes then the chunk's number as 8 bytes, big-endian; its associated data is the header and a
 * byte that is 1 on the last chunk, 0 on the others, so a cut file fails.
 */

export const BACKUP_FORMAT = {
  magic: "HSNB",
  format: 1,
  headerBytes: 64,
  chunkBytes: 64 * 1024,
  saltBytes: 8,
  keyBytes: 32,
  info: "hsn-backup/1",
  extension: ".hsnb",
} as const;

/**
 * The header's fields, in order, as section 9 sets them: `[name, offset, bytes]`, integers
 * little-endian as in the device protocol (only the chunk nonce's counter is big-endian). A
 * reader refuses a nonzero reserved byte or an unknown flag bit as `badFormat`.
 */
export const BACKUP_HEADER_LAYOUT = [
  ["magic", 0, 4],
  ["format", 4, 1],
  ["flags", 5, 1],
  ["identity", 6, 16],
  ["epoch", 22, 4],
  ["madeMs", 26, 8],
  ["schema", 34, 4],
  ["salt", 38, 8],
  ["lastChangeMs", 46, 8],
  ["reserved", 54, 10],
] as const;

/**
 * The header's flag bits (byte 5): none in format 1, every bit zero (section 9). Bit 0, once
 * "the file holds history", is retired: history is exported as its own file, never in a backup.
 */
export const BACKUP_FLAGS = {} as const;

/** Every flag bit a reader of format 1 knows: none, so any bit set is `badFormat`. */
export const BACKUP_KNOWN_FLAGS = 0;

export interface BackupHeader {
  readonly format: number;
  /** `BACKUP_FLAGS` bits. */
  readonly flags: number;
  /** The hub's app identity's 16 bytes. */
  readonly identity: Uint8Array;
  readonly epoch: number;
  readonly madeMs: number;
  /** The database's schema version: the number of migrations applied. */
  readonly schema: number;
  readonly salt: Uint8Array;
  /**
   * The last change to people, clients, permissions or devices the file holds (D122):
   * `backup_state.last_change_ms`.
   */
  readonly lastChangeMs: number;
}

export type BackupError =
  "badMagic" | "badFormat" | "truncated" | "decryptFailed" | "cut" | "finished";

export type BackupResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BackupError };

/** What `backup.ts` exports. */
export interface BackupCodec {
  /** The whole file: header then encrypted chunks of `database`. */
  seal(backupKey: Uint8Array, header: BackupHeader, database: Uint8Array): BackupResult<Uint8Array>;
  /** The header alone, for the console's question before a restore (D122). */
  readHeader(file: Uint8Array): BackupResult<BackupHeader>;
  open(
    backupKey: Uint8Array,
    file: Uint8Array,
  ): BackupResult<{ readonly header: BackupHeader; readonly database: Uint8Array }>;
}

export interface BackupSealer {
  readonly headerBytes: Uint8Array; // the 64 bytes to write first
  /** Any number of plaintext bytes; returns the chunks they completed, each 65,536 + 16 bytes.
   *  The latest full chunk is held back until more data or `finish` says whether it is the last.
   *  After `finish`, or after an error, it is refused as `finished`. */
  add(plain: Uint8Array): BackupResult<readonly Uint8Array[]>;
  /** Seals what is held as the last chunk (0 to 65,536 bytes: empty data is one empty last chunk,
   *  as the vectors have it) and ends. */
  finish(): BackupResult<Uint8Array>;
}

export interface BackupOpener {
  readonly header: BackupHeader;
  /** The next sealed bytes; returns the plaintext of the chunks completed, holding the latest
   *  back until more bytes or `finish` tell it whether it is the last; a chunk that fails is an error. */
  add(sealed: Uint8Array): BackupResult<readonly Uint8Array[]>;
  /** The file has ended: opens the held chunk as the last. */
  finish(): BackupResult<Uint8Array>;
}

/** A release file's signature (D84): Ed25519 over the file by the publisher's key. */
export interface ReleaseVerifier {
  verify(file: Uint8Array, signature: Uint8Array, publisherKey: Uint8Array): boolean;
}

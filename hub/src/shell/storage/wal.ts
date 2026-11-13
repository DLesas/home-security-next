/**
 * The write-ahead log's size and checkpoints (hub-design.md section 5, "SQLite settings" and
 * "Budget"). The writer checkpoints itself once the WAL holds 1,000 pages ‡ or an hour ‡ has
 * passed, so it needs the number of frames in the WAL after each commit without checkpointing
 * to learn it. SQLite keeps that number, `mxFrame`, in the header of the WAL index (the `-shm`
 * file, sqlite.org/walformat.html, "The WAL-Index Header"); reading those 24 bytes costs one
 * read from the page cache and writes nothing. The header names its format version, which is
 * checked, so a different layout reads as unknown instead of as a wrong count.
 */
import type { Database } from "bun:sqlite";
import { endianness } from "node:os";
import { err, ok, type Result } from "neverthrow";
import type { StorageError } from "../../ports/writer.ts";
import { readStart } from "../safe/fs.ts";
import { sqlite } from "../safe/sqlite.ts";

const ORIGIN = "shell/storage/wal";

/** Every WAL frame is a 24-byte header and one page (sqlite.org/fileformat2.html, 4.1). */
export const WAL_FRAME_HEADER_BYTES = 24;

/** The WAL-index header's `iVersion` for every SQLite since 3.7.0. */
const WAL_INDEX_VERSION = 3_007_000;
/** Offsets in the WAL-index header: `iVersion`, `szPage` and `mxFrame`. */
const VERSION_OFFSET = 0;
const PAGE_SIZE_OFFSET = 14;
const MAX_FRAME_OFFSET = 16;
const HEADER_BYTES = 24;

/** The frames now in the WAL, read from its index; undefined when the index is absent or unknown. */
export function walFrames(
  dbPath: string,
  pageSize: number,
): Result<number | undefined, StorageError> {
  const header = new Uint8Array(HEADER_BYTES);
  const read = readStart({ kind: "storage", origin: ORIGIN }, `${dbPath}-shm`, header);
  if (read.isErr()) return err(read.error);
  if (read.value < HEADER_BYTES) return ok(undefined);
  // The WAL index is in the machine's own byte order.
  const little = endianness() === "LE";
  const view = new DataView(header.buffer);
  const version = view.getUint32(VERSION_OFFSET, little);
  // szPage holds the page size, except 65,536, which it holds as 1.
  const size = view.getUint16(PAGE_SIZE_OFFSET, little);
  if (version !== WAL_INDEX_VERSION || (size === 1 ? 65_536 : size) !== pageSize) {
    return ok(undefined);
  }
  return ok(view.getUint32(MAX_FRAME_OFFSET, little));
}

/** What `PRAGMA wal_checkpoint(PASSIVE)` reports. */
export interface CheckpointResult {
  /** Another connection held the database: always 0 with one writer. */
  readonly busy: number;
  /** Frames in the WAL. */
  readonly log: number;
  /** Frames copied into the database file. */
  readonly checkpointed: number;
}

/** A passive checkpoint: copies what it can into the main file without waiting for anything. */
export function checkpoint(db: Database): Result<CheckpointResult, StorageError> {
  return sqlite(ORIGIN, "checkpoint", () => {
    const row = db.query<CheckpointResult, []>("PRAGMA wal_checkpoint(PASSIVE)").get();
    return row ?? { busy: 0, log: 0, checkpointed: 0 };
  });
}

/**
 * The firmware store's folder (docs/m3-updates-design.md section 4, "Where images are kept",
 * D140): `firmware/` in the data folder, one file per image, `<sha256>.bin`, holding the payload
 * (an official release's payload range copied out, or an owner's own build) and nothing else; the
 * header, manifest and signature are the database's (`firmware_images`, the core's index). It is
 * data, not program, and in no backup: a backup copies database tables, never this folder.
 *
 * - **Written durably** by the staging job (`stage.ts`): a temporary file beside, `.staging-<job>`,
 *   synced, renamed to its name, the folder synced. A file's name is its content's hash, so the
 *   same image staged again replaces its file with the same bytes.
 * - **Removed when the core says** (`removeFirmware`): the file, then the folder synced. Image 0
 *   names a staged file the core refused as `storeFull`, which has no row. Whether the file may go
 *   is decided when it is deleted, from the index as committed then: a file an image in the index
 *   names (the same image staged again while the removal was held back) is never deleted.
 * - **Checked at start**, before the hub listens: every indexed image's file is there and hashes to
 *   its row's SHA-256, one `firmwareStoreDamaged` for each that does not; a temporary file and a
 *   file no live row names (a crash between a file's placing and its row's commit, or between a
 *   row's removal and its file's) are deleted, so the folder holds only the index's images and
 *   stays within D112's 8 MB ‡.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { FirmwareStoreProblem } from "../../core/model/events.ts";
import { type ImageId, imageId } from "../../core/model/ids.ts";
import {
  ensureFolder,
  type IoError,
  namesIn,
  removeFile,
  sha256OfFile,
  sizeOf,
  syncFolder,
} from "../safe/firmware-io.ts";
import { sqlite } from "../safe/sqlite.ts";

/** The store's folder in the data folder. */
export const STORE_FOLDER = "firmware";

/** A stored image's file name: its SHA-256 as lower-case hex, then `.bin`. */
export const IMAGE_FILE = /^[0-9a-f]{64}\.bin$/u;

/** A staging job's temporary file in the store's folder. */
export const STAGING_PREFIX = ".staging-";

export function storeFolder(dataDir: string): string {
  return join(dataDir, STORE_FOLDER);
}

/** The file name of an image whose SHA-256 is `sha256`. */
export function imageFileName(sha256: Uint8Array): string {
  return `${Buffer.from(sha256).toString("hex")}.bin`;
}

/** The path of a stored file, or undefined for a name that is not one of the store's. */
export function imagePath(dataDir: string, file: string): string | undefined {
  return IMAGE_FILE.test(file) ? join(storeFolder(dataDir), file) : undefined;
}

/** An indexed image, as the store's check needs it. */
export interface IndexedImage {
  readonly id: ImageId;
  readonly file: string;
  readonly sha256: Uint8Array;
}

/** The images the index holds now (`firmware_images` not removed), read at start. */
export function indexedImages(db: Database): Result<readonly IndexedImage[], string> {
  return sqlite("shell/firmware/store", "read the firmware store's index", () =>
    db
      .query<{ id: number; file: string; sha256: Uint8Array }, []>(
        `SELECT "id" AS id, "file" AS file, "sha256" AS sha256 FROM "firmware_images"
         WHERE "removed_ms" IS NULL ORDER BY "id"`,
      )
      .all(),
  )
    .map((rows) =>
      rows.map((row) => ({
        id: imageId(row.id),
        file: row.file,
        sha256: new Uint8Array(row.sha256),
      })),
    )
    .mapErr((error) => error.message);
}

/** One indexed image whose file is not as its row says. */
export interface Damaged {
  readonly image: ImageId;
  readonly problem: FirmwareStoreProblem;
}

/** What the check at start found and did. */
export interface StoreCheck {
  readonly damaged: readonly Damaged[];
  /** The files it deleted: temporary files, and files no live row names. */
  readonly removed: readonly string[];
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * The store's check at start: the folder made if missing; what no live row names deleted; each
 * indexed image's file looked at and hashed. A file that cannot be read is `missing` (it serves
 * nothing either).
 */
export function checkStore(
  dataDir: string,
  indexed: readonly IndexedImage[],
): Result<StoreCheck, IoError> {
  const folder = storeFolder(dataDir);
  const made = ensureFolder(folder);
  if (made.isErr()) return err(made.error);
  const names = namesIn(folder);
  if (names.isErr()) return err(names.error);
  const live = new Set(indexed.map((image) => image.file));
  const removed: string[] = [];
  for (const name of names.value) {
    const ours = name.startsWith(STAGING_PREFIX) || IMAGE_FILE.test(name);
    if (!ours || live.has(name)) continue;
    const gone = removeFile(join(folder, name));
    if (gone.isErr()) return err(gone.error);
    removed.push(name);
  }
  if (removed.length > 0) {
    const synced = syncFolder(folder);
    if (synced.isErr()) return err(synced.error);
  }
  const damaged: Damaged[] = [];
  for (const image of indexed) {
    const path = imagePath(dataDir, image.file);
    const hashed = path === undefined ? undefined : sha256OfFile(path);
    if (hashed === undefined || hashed.isErr()) {
      damaged.push({ image: image.id, problem: "missing" });
    } else if (!same(hashed.value, image.sha256)) {
      damaged.push({ image: image.id, problem: "wrongHash" });
    }
  }
  return ok({ damaged, removed });
}

/** The store's files now: how many, and their bytes. */
export function storeUsage(
  dataDir: string,
): Result<{ readonly files: ReadonlyMap<string, number> }, IoError> {
  const folder = storeFolder(dataDir);
  const names = namesIn(folder);
  if (names.isErr()) return err(names.error);
  const files = new Map<string, number>();
  for (const name of names.value) {
    if (!IMAGE_FILE.test(name)) continue;
    const size = sizeOf(join(folder, name));
    if (size.isErr()) return err(size.error);
    if (size.value !== undefined) files.set(name, size.value);
  }
  return ok({ files });
}

/** A removal's steps, in order, each run by itself (a crash test stops between any two). */
export type RemovalStep = () => Result<void, IoError>;

/**
 * Whether an image in the index now names `file`: asked at the moment of deletion, never earlier.
 * A removal can run long after it was asked for (held behind a commit that failed), by which time
 * the same image may have been staged again: files are named by their hash, so it is the same file.
 */
export type StillIndexed = (file: string) => Result<boolean, string>;

/** Whether a live row of `firmware_images` names `file`, on the writer's connection (committed). */
export function indexedFile(db: Database): StillIndexed {
  return (file) =>
    sqlite("shell/firmware/store", "read the firmware store's index", () =>
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM "firmware_images" WHERE "file" = ? AND "removed_ms" IS NULL`,
        )
        .get(file),
    )
      .map((row) => (row?.n ?? 0) > 0)
      .mapErr((error) => error.message);
}

/**
 * The steps of removing a stored file: the file, unless an image in the index names it at that
 * moment (then it stays, and the removal is done: the file is that image's); then the folder synced.
 */
export function removalSteps(
  dataDir: string,
  file: string,
  stillIndexed: StillIndexed,
): Result<readonly RemovalStep[], string> {
  const path = imagePath(dataDir, file);
  if (path === undefined) return err(`"${file}" is not a file of the firmware store`);
  const folder = storeFolder(dataDir);
  const removeUnlessIndexed = (): Result<void, IoError> => {
    const indexed = stillIndexed(file);
    if (indexed.isErr()) return err({ reason: "io", message: indexed.error });
    return indexed.value ? ok(undefined) : removeFile(path);
  };
  return ok([removeUnlessIndexed, () => syncFolder(folder)]);
}

/** Removes a stored file no indexed image names: every step, stopping at the first that fails. */
export function removeImageFile(
  dataDir: string,
  file: string,
  stillIndexed: StillIndexed,
): Result<void, IoError> {
  const steps = removalSteps(dataDir, file, stillIndexed);
  if (steps.isErr()) return err({ reason: "badFile", message: steps.error });
  for (const step of steps.value) {
    const done = step();
    if (done.isErr()) return done;
  }
  return ok(undefined);
}

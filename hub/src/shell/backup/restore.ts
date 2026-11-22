/**
 * Restore's file work (m2-design.md section 9, "Restore"; D53, D78, D122):
 *
 * - `readRestore`: the header alone, for the console's question before going on (D122).
 * - `applyRestore` (`RestorePieces`, in pieces between the loop's turns): the file opened with the
 *   phone's key into a scratch file beside `hub.db`, and the restored database made beside it as
 *   `hub.db.restore`, a scratch file until it is renamed: a database at the backup's own schema (the first migrations, as many as it had), its configuration and keys
 *   (its app key too, so the hub has the old identity), then
 *   - every hub sending counter's resume point moved forward by 2²⁴ (§4, O16);
 *   - every device's key marked for change (`device_keys.rekey`, D141): `Required`, or `BothHeld`
 *     where the backup held a pending key, so no packet under a key held at the backup is acted on;
 *   - every client's last `seq` raised by 2³² ‡, so no request recorded before the restore passes;
 *   - every client kept exactly as the file has it (D122), and no link token at all;
 *   - the phone's key as the backup key, at the file's epoch;
 *   - the restore mark, `backup_state.restored_from_ms`, the file's time;
 *   and then migrated forward to this code's schema. A file from a newer hub is refused.
 * - `switchRestore`: once the hub has stopped cleanly and closed `hub.db`, the old file kept as
 *   `hub.db.before-restore` and the restored one put in its place; the caller then exits 70.
 *
 * A restore that fails leaves the running hub exactly as it was: nothing but `hub.db.restore` and
 * its scratch files is ever written before the switch, and they are removed on any failure.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import {
  BACKUP_FORMAT,
  type BackupHeader,
  type BackupOpener,
  backupCodec,
  backupOpener,
} from "@hsn/protocol/app";
import { err, ok, Result } from "neverthrow";
import type { FileOutcome } from "../../core/model/events.ts";
import { BACKUP_STATE_DEFAULTS, Rekey } from "../../core/model/rows.ts";
import type { HubRules } from "../../core/model/rules.ts";
import { applyMigrations, readMigrations } from "../safe/migrate.ts";
import { readHeadOffLoop } from "../safe/off-loop.ts";
import { closeDatabase, openDatabase, sqlite } from "../safe/sqlite.ts";
import {
  BACKUP_TABLES,
  columnsOf,
  copyBatch,
  copyRows,
  createSql,
  MIGRATIONS_TABLE,
  type RowCursor,
  rowCursor,
  schemaVersion,
} from "./contents.ts";
import {
  exists,
  type FileError,
  fileError,
  copyDurably,
  readHead,
  remove,
  removeQuietly,
  rename,
  syncFolder,
} from "./files.ts";
import { HISTORY_MAGIC } from "./history-export.ts";
import { SEAL_PIECE_BYTES } from "./sealing.ts";

const ORIGIN = "shell/backup/restore";
export const RESTORE_FILE = "hub.db.restore";
export const BEFORE_RESTORE_FILE = "hub.db.before-restore";
const DATABASE_FILE = "hub.db";

/** A history export's answer (section 9): its first bytes are not `HSNB`. */
const HISTORY_REFUSED: FileOutcome = {
  kind: "failed",
  reason: "badFile",
  message: "this is a history export, not a backup",
};

function isHistoryFile(head: Uint8Array): boolean {
  const magic = new TextEncoder().encode(HISTORY_MAGIC);
  return magic.every((byte, i) => head[i] === byte);
}

/** `readRestore`: the header of the uploaded file. */
export function readRestoreHeader(path: string): FileOutcome {
  const head = readHead(path, BACKUP_FORMAT.headerBytes);
  return head.isErr() ? { kind: "failed", ...head.error } : restoreHeaderOutcome(head.value);
}

/**
 * `readRestore` off the hub's thread (D145, design P): the upload's head read through
 * `node:fs/promises` (`safe/off-loop.ts`), the same outcome as `readRestoreHeader`'s.
 */
export async function readRestoreHeaderOffLoop(path: string): Promise<FileOutcome> {
  const head = await readHeadOffLoop(path, BACKUP_FORMAT.headerBytes);
  return head.isErr()
    ? { kind: "failed", ...fileError(`read ${path}`)(head.error) }
    : restoreHeaderOutcome(head.value);
}

/** What the upload's first bytes say: a backup's header, a history export, or not a backup. */
function restoreHeaderOutcome(head: Uint8Array): FileOutcome {
  if (isHistoryFile(head)) return HISTORY_REFUSED;
  const header = backupCodec.readHeader(head);
  if (!header.ok)
    return { kind: "failed", reason: "badFile", message: `not a backup: ${header.error}` };
  return {
    kind: "restoreRead",
    identity: header.value.identity,
    epoch: header.value.epoch,
    madeMs: header.value.madeMs,
    lastChangeMs: header.value.lastChangeMs,
  };
}

export interface RestoreInputs {
  readonly dataDir: string;
  readonly uploadPath: string;
  readonly key: Uint8Array;
  readonly migrationsFolder: string;
  readonly rules: HubRules;
}

function failed(
  reason: "badFile" | "wrongKey" | "io" | "full" | "unreachable",
  message: string,
): FileOutcome {
  return { kind: "failed", reason, message };
}

/** The tables a backup holds, Drizzle's own apart: only these are ever restored (`contents.ts`). */
const RESTORED_TABLES: ReadonlySet<string> = new Set<string>(
  BACKUP_TABLES.filter((name) => name !== MIGRATIONS_TABLE),
);

/**
 * The tables of the backup's database that a backup holds. A file holding any other (a push key,
 * a firmware image's row, history) is restored without it: those tables start as the migrations
 * make them, as on a new hub.
 */
function tablesOf(db: Database): readonly string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name)
    .filter((name) => RESTORED_TABLES.has(name));
}

/** Restore's rows copied a piece ‡ (provisional, section 3). */
export const RESTORE_ROWS_PER_PIECE = 250;

/** One sealed chunk: 65,536 bytes of plaintext and its 16-byte tag (section 9). */
const SEALED_CHUNK_BYTES = BACKUP_FORMAT.chunkBytes + 16;

/**
 * How a failed opening is told (the ruling of step 1, wave 2): the first chunk failing means the
 * key does not open the file (`wrongKey`); a later one, a file damaged or incomplete (`badFile`).
 */
export function openingFailure(chunksOpened: number, error: string): FileOutcome {
  return chunksOpened === 0 && error === "decryptFailed"
    ? failed("wrongKey", "the key does not open this file")
    : failed("badFile", `the file is damaged or incomplete: ${error}`);
}

type RestorePhase = "open" | "decrypt" | "build" | "rows" | "mark" | "migrate" | "place";

/** The restored database being built, `hub.db.restore.new`, a scratch file until it is renamed. */
export function restoreBuilding(dataDir: string): string {
  return `${join(dataDir, RESTORE_FILE)}.new`;
}

/**
 * Every file an `applyRestore` makes in `dataDir`: its scratch files, and `hub.db.restore` once
 * renamed, which the next start puts in place (`retryWaitingRestore`).
 */
export function restoreFiles(dataDir: string): readonly string[] {
  const building = restoreBuilding(dataDir);
  return [
    building,
    `${building}-wal`,
    `${building}-shm`,
    `${building}.plain`,
    join(dataDir, RESTORE_FILE),
  ];
}

/**
 * `applyRestore` in pieces between the loop's turns (section 3, "The loop's time"):
 *
 * 1. The header, and an opener for the phone's key (`backupOpener`).
 * 2. The file read and opened `SEAL_PIECE_BYTES` ‡ of it a piece; each chunk's plaintext is
 *    released only once its tag is checked, and appended to `hub.db.restore.new.plain`, a scratch
 *    file in the data folder (whose database is plaintext anyway), so no piece holds the whole
 *    database in memory nor copies it at once (a 240 MB `deserialize` was 40 ms, over a piece's
 *    20 ms ‡). A chunk that fails, or a cut file, removes it; it is opened only after the last.
 * 3. The scratch file opened read-only as a database, its schema checked; `hub.db.restore.new` made
 *    beside, the schema the backup was at, its migrations' rows. The file is scratch until it is
 *    renamed (a failure deletes it), so it has no journal, and each piece is a synced commit of
 *    its own: no commit writes more than a piece's pages.
 * 4. Its tables copied `RESTORE_ROWS_PER_PIECE` ‡ rows a piece.
 * 5. The jumps (counters by 2²⁴, every client's `seq` by 2³²), every device key marked for
 *    change, no token, the phone's key at the file's epoch, the restore mark; committed. A backup
 *    from before migration 3 is marked right after it is migrated (6).
 * 6. Migrated forward to this code's schema.
 * 7. Closed and renamed `hub.db.restore`.
 *
 * A failure at any piece, or `abort`, removes what it made; the running hub is never touched.
 */
export class RestorePieces {
  readonly #inputs: RestoreInputs;
  #phase: RestorePhase = "open";
  #ended: FileOutcome | undefined;
  #fd: number | undefined;
  #size = 0;
  #readAt = 0;
  #opener: BackupOpener | undefined;
  #chunks = 0;
  #plainFd: number | undefined;
  #header: BackupHeader | undefined;
  #backup: Database | undefined;
  #target: Database | undefined;
  #tables: string[] = [];
  #cursor: RowCursor | undefined;

  constructor(inputs: RestoreInputs) {
    this.#inputs = inputs;
  }

  get phase(): RestorePhase {
    return this.#phase;
  }

  #building(): string {
    return restoreBuilding(this.#inputs.dataDir);
  }

  /** The opened file's plaintext, scratch until the rows are copied out of it. */
  #plainPath(): string {
    return `${this.#building()}.plain`;
  }

  next(): FileOutcome | undefined {
    if (this.#ended !== undefined) return this.#ended;
    const step = Result.fromThrowable(
      (): FileOutcome | undefined => this.#step(),
      (thrown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    )();
    if (step.isErr()) return this.#fail(failed("io", step.error));
    const value = step.value;
    if (value === undefined) return undefined;
    if (value.kind === "failed") return this.#fail(value);
    this.#ended = value;
    return value;
  }

  abort(message: string): FileOutcome {
    return this.#fail(failed("io", message));
  }

  #close(): void {
    for (const fd of [this.#fd, this.#plainFd])
      if (fd !== undefined)
        Result.fromThrowable(() => {
          closeSync(fd);
        })().match(
          () => undefined,
          () => undefined,
        );
    this.#fd = undefined;
    this.#plainFd = undefined;
    for (const db of [this.#backup, this.#target]) if (db !== undefined) closeQuietly(db);
    this.#backup = undefined;
    this.#target = undefined;
  }

  #fail(outcome: FileOutcome): FileOutcome {
    if (this.#ended !== undefined) return this.#ended;
    this.#close();
    const building = this.#building();
    for (const path of [building, `${building}-wal`, `${building}-shm`, this.#plainPath()])
      removeQuietly(path);
    this.#ended = outcome;
    return outcome;
  }

  #step(): FileOutcome | undefined {
    switch (this.#phase) {
      case "open":
        return this.#open();
      case "decrypt":
        return this.#decrypt();
      case "build":
        return this.#build();
      case "rows":
        return this.#rows();
      case "mark":
        return this.#mark();
      case "migrate":
        return this.#migrate();
      case "place":
        return this.#place();
    }
  }

  #open(): FileOutcome | undefined {
    const head = readHead(this.#inputs.uploadPath, BACKUP_FORMAT.headerBytes);
    if (head.isErr()) return { kind: "failed", ...head.error };
    if (isHistoryFile(head.value)) return HISTORY_REFUSED;
    const opener = backupOpener(this.#inputs.key, head.value);
    if (!opener.ok)
      return opener.error === "decryptFailed"
        ? failed("wrongKey", "the key does not open this file")
        : failed("badFile", `not a backup: ${opener.error}`);
    this.#opener = opener.value;
    this.#header = opener.value.header;
    this.#fd = openSync(this.#inputs.uploadPath, "r");
    removeQuietly(this.#plainPath());
    this.#plainFd = openSync(this.#plainPath(), "wx", 0o600);
    this.#size = fstatSync(this.#fd).size;
    this.#readAt = BACKUP_FORMAT.headerBytes;
    this.#phase = "decrypt";
    return undefined;
  }

  /** A piece of the file opened; its chunks' plaintext written to the scratch file once their tags pass. */
  #decrypt(): FileOutcome | undefined {
    const opener = this.#opener;
    const fd = this.#fd;
    const plainFd = this.#plainFd;
    if (opener === undefined || fd === undefined || plainFd === undefined)
      return failed("io", "the restore lost its file");
    if (this.#readAt < this.#size) {
      // One sealed chunk an `add`, so the chunks opened are counted exactly: a failure is the
      // first chunk's (`wrongKey`) or a later one's (`badFile`).
      const end = Math.min(this.#size, this.#readAt + SEAL_PIECE_BYTES);
      while (this.#readAt < end) {
        const length = Math.min(SEALED_CHUNK_BYTES, this.#size - this.#readAt);
        const piece = new Uint8Array(length);
        let got = 0;
        while (got < length) {
          const n = readSync(fd, piece, got, length - got, this.#readAt + got);
          if (n === 0) return failed("badFile", "the file ended early");
          got += n;
        }
        this.#readAt += length;
        const opened = opener.add(piece);
        if (!opened.ok) return openingFailure(this.#chunks, opened.error);
        this.#chunks += opened.value.length;
        for (const chunk of opened.value) writeAll(plainFd, chunk);
      }
      return undefined;
    }
    const last = opener.finish();
    if (!last.ok) return openingFailure(this.#chunks, last.error);
    this.#chunks += 1;
    writeAll(plainFd, last.value);
    closeSync(fd);
    this.#fd = undefined;
    closeSync(plainFd);
    this.#plainFd = undefined;
    this.#phase = "build";
    return undefined;
  }

  /** The plaintext as a database in memory; the restored one begun at the backup's schema. */
  #build(): FileOutcome | undefined {
    const header = this.#header;
    if (header === undefined) return failed("io", "the restore lost its header");
    const code = readMigrations(this.#inputs.migrationsFolder);
    if (code.isErr()) return failed("io", code.error.message);
    const plainPath = this.#plainPath();
    const backup = sqlite(
      ORIGIN,
      "open the backup",
      () => new Database(plainPath, { readonly: true, strict: true }),
    );
    if (backup.isErr()) return failed("badFile", backup.error.message);
    this.#backup = backup.value;
    const schema = schemaVersion(backup.value);
    if (schema.isErr() || schema.value !== header.schema)
      return failed("badFile", "the file's schema does not match its header");
    if (schema.value > code.value.length)
      return failed(
        "badFile",
        `the file is from a newer hub (schema ${schema.value}, this hub ${code.value.length})`,
      );
    const building = this.#building();
    for (const path of [building, `${building}-wal`, `${building}-shm`]) removeQuietly(path);
    const made = openDatabase(building, ORIGIN, { create: true });
    if (made.isErr()) return failed("io", made.error.message);
    const target = made.value;
    this.#target = target;
    // A scratch file until it is renamed: no journal; each piece its own synced commit, so no
    // commit writes more than a piece's pages.
    target.run("PRAGMA journal_mode = OFF");
    target.run("PRAGMA synchronous = FULL");
    target.run("BEGIN IMMEDIATE");
    // Drizzle's table as the backup has it, and its rows: the schema it was at.
    const sql = createSql(backup.value, MIGRATIONS_TABLE)._unsafeUnwrap();
    if (sql === undefined) return failed("badFile", "the backup has no migrations table");
    target.run(sql);
    for (const file of code.value.slice(0, schema.value))
      for (const statement of file.sql) if (statement.trim() !== "") target.run(statement);
    copyRows(
      backup.value,
      target,
      MIGRATIONS_TABLE,
      columnsOf(backup.value, MIGRATIONS_TABLE)._unsafeUnwrap(),
    )._unsafeUnwrap();
    this.#tables = [...tablesOf(backup.value)];
    target.run("COMMIT");
    this.#phase = "rows";
    return undefined;
  }

  /** At most a piece's rows of the backup's tables copied, each table cleared before its first. */
  #rows(): FileOutcome | undefined {
    const backup = this.#backup;
    const target = this.#target;
    if (backup === undefined || target === undefined)
      return failed("io", "the restore lost its databases");
    target.run("BEGIN IMMEDIATE");
    if (this.#cursor === undefined) {
      const table = this.#tables.shift();
      if (table === undefined) {
        target.run("COMMIT");
        this.#phase = "mark";
        return undefined;
      }
      target.run(`DELETE FROM "${table.replaceAll('"', '""')}"`);
      this.#cursor = rowCursor(backup, table)._unsafeUnwrap();
    }
    if (copyBatch(backup, target, this.#cursor, RESTORE_ROWS_PER_PIECE)._unsafeUnwrap())
      this.#cursor = undefined;
    target.run("COMMIT");
    return undefined;
  }

  /** The jumps, the phone's key, the mark; committed. */
  #mark(): FileOutcome | undefined {
    const target = this.#target;
    const header = this.#header;
    if (target === undefined || header === undefined)
      return failed("io", "the restore lost its database");
    const rules = this.#inputs.rules;
    target.run("BEGIN IMMEDIATE");
    target.run(`UPDATE "send_counters" SET "resume_point" = "resume_point" + ?`, [
      rules.restore.counterJump,
    ]);
    target.run(`UPDATE "clients" SET "last_seq" = "last_seq" + ?`, [rules.restore.seqJump]);
    // Every device's key marked for change (D141); a backup older than migration 3 has no column
    // for it yet, and is marked once it is migrated (`#migrate`).
    if (columnsOf(target, "device_keys")._unsafeUnwrap().includes("rekey")) markKeyChanges(target);
    target.run(`DELETE FROM "link_tokens"`);
    target.run(`DELETE FROM "link_secrets"`);
    target.run(`DELETE FROM "client_replies"`);
    target.run(`DELETE FROM "backup_key"`);
    target.run(`INSERT INTO "backup_key" ("key", "epoch") VALUES (?, ?)`, [
      this.#inputs.key,
      header.epoch,
    ]);
    const state =
      target.query<{ n: number }, []>(`SELECT count(*) AS n FROM "backup_state"`).get()?.n ?? 0;
    if (state === 0)
      target.run(`INSERT INTO "backup_state" ("overdue_raised", "last_result") VALUES (?, ?)`, [
        BACKUP_STATE_DEFAULTS.overdueRaised ? 1 : 0,
        BACKUP_STATE_DEFAULTS.lastResult,
      ]);
    // The mark, and nothing of the old hub's last attempts: the restored hub writes its own.
    target.run(
      `UPDATE "backup_state" SET "restored_from_ms" = ?, "due_since_ms" = NULL, "overdue_raised" = 0, "newest_name" = NULL, "newest_ms" = NULL, "last_result" = 0, "last_attempt_ms" = NULL`,
      [header.madeMs],
    );
    target.run("COMMIT");
    if (this.#backup !== undefined) closeQuietly(this.#backup);
    this.#backup = undefined;
    const scratch = remove(this.#plainPath());
    if (scratch.isErr()) return { kind: "failed", ...scratch.error };
    this.#phase = "migrate";
    return undefined;
  }

  #migrate(): FileOutcome | undefined {
    const target = this.#target;
    if (target === undefined) return failed("io", "the restore lost its database");
    const marked = columnsOf(target, "device_keys")._unsafeUnwrap().includes("rekey");
    const migrated = applyMigrations(target, this.#inputs.migrationsFolder);
    if (migrated.isErr()) return failed("io", migrated.error.message);
    if (!marked) {
      // A backup from before migration 3: its rows have just gained the column, at 0.
      target.run("BEGIN IMMEDIATE");
      markKeyChanges(target);
      target.run("COMMIT");
    }
    this.#phase = "place";
    return undefined;
  }

  #place(): FileOutcome | undefined {
    const target = this.#target;
    if (target === undefined) return failed("io", "the restore lost its database");
    this.#target = undefined;
    const closed = closeDatabase(target, ORIGIN);
    if (closed.isErr()) return failed("io", closed.error.message);
    const placed = rename(this.#building(), join(this.#inputs.dataDir, RESTORE_FILE)).andThen(() =>
      syncFolder(this.#inputs.dataDir),
    );
    if (placed.isErr()) return { kind: "failed", ...placed.error };
    return { kind: "restoreReady" };
  }
}

/**
 * Marks every device's key for change after the restore (D141, m3-updates-design section 7): the
 * hub acts on no packet sealed under a key it held at the backup. A row with no pending key is
 * `Required`: its key was held at the backup, and the device's first packet under it draws a Key
 * change with a key made then. A row whose backup held a pending `next_key` is `BothHeld`: both its
 * keys were held at the backup, so a packet under either is not acted on, but says which one the
 * device holds (the coordinator's ruling of 2026-11-18). Inside the restore's transaction.
 */
function markKeyChanges(db: Database): void {
  db.run(`UPDATE "device_keys" SET "rekey" = CASE WHEN "next_key" IS NULL THEN ? ELSE ? END`, [
    Rekey.Required,
    Rekey.BothHeld,
  ]);
}

/** All of `bytes` at the file's end. */
function writeAll(fd: number, bytes: Uint8Array): void {
  let done = 0;
  while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
}

function closeQuietly(db: Database): void {
  closeDatabase(db, ORIGIN).match(
    () => undefined,
    () => undefined,
  );
}

/** One step of the restore's swap, by name, for its tests' cut points. */
export interface SwapStep {
  readonly name: string;
  readonly run: () => Result<void, FileError>;
}

/**
 * `switchRestore`'s swap, after the hub's clean stop (section 9): the old file kept as
 * `hub.db.before-restore`, the restored one in its place. Section 10's rule, "the old version or
 * the new one runs, never neither", holds at every cut point, with nothing to recover at the next
 * start:
 *
 * 1. `hub.db`'s log checkpointed into it in full (`wal_checkpoint(TRUNCATE)` on a connection of
 *    its own, refused unless every frame went in), so the file is whole on its own and its log
 *    empty. This holds whether or not the hub's own connection is still open, as long as it is
 *    idle (the clean stop's commit is its last).
 * 2. Any older `hub.db.before-restore` removed, and `hub.db`, now whole, copied to it (written
 *    beside, synced, renamed). `hub.db` itself is not moved. The copy is small: a restore needs a
 *    hub with no devices yet. Not a hard link, which SQLite refuses (`SQLITE_IOERR_VNODE`).
 * 3. The old database's `-shm` removed, then its `-wal`: the index first, since an index left
 *    beside a database whose log is gone makes the next open fail (`SQLITE_IOERR_SHORT_READ`),
 *    while a log without its index is rebuilt; the log is empty since step 1.
 * 4. `hub.db.restore` renamed over `hub.db`: one atomic rename, the swap's only commit point.
 * 5. The folder synced, so the rename survives a power cut.
 *
 * **Recovery rule.** Cut off before step 4 ends, `hub.db` is the old database, whole (with its
 * own log until step 3, an empty one after step 1, none after step 3), so the next start opens the
 * old one and the restore did not happen (`hub.db.restore` is left, never opened, and replaced by
 * the next restore). Cut off after it, `hub.db` is the restored one, built with no log, and no log
 * or index of the old one is beside it, so the next start opens the restored one. A `-wal` or
 * `-shm` is never read against the wrong database: the old one's are gone before the rename that
 * could pair them with the restored file, and the restored file never had any.
 *
 * **How long `hub.db.before-restore` lives.** Until the next restore replaces it (step 2), and no
 * longer than the data folder is kept: it is the person's way back from a restore made by mistake,
 * small (the hub had no devices), and nothing else removes it. A migration's "older copies" are
 * the pre-migration copies alone, `hub.db.before-<digits>` (as the launcher's `COPY_NAME`), so a
 * restored backup's first start, which migrates it, keeps it (FROZEN-CHANGE asked of
 * `shell/storage/migrations.ts`, which matches the prefix `hub.db.before-` today).
 */
export function swapSteps(dataDir: string): readonly SwapStep[] {
  const db = join(dataDir, DATABASE_FILE);
  const restored = join(dataDir, RESTORE_FILE);
  const before = join(dataDir, BEFORE_RESTORE_FILE);
  return [
    { name: "the old database's log checkpointed into it", run: () => checkpointed(db) },
    {
      name: "the old database kept as hub.db.before-restore",
      run: () => remove(before).andThen(() => copyDurably(db, before)),
    },
    {
      name: "the old database's index and log removed",
      run: () => remove(`${db}-shm`).andThen(() => remove(`${db}-wal`)),
    },
    {
      name: "the restored database renamed over hub.db",
      run: () =>
        exists(restored)
          ? rename(restored, db)
          : err({ reason: "io", message: "no restored database is ready" }),
    },
    { name: "the folder synced", run: () => syncFolder(dataDir) },
  ];
}

export function swapRestored(dataDir: string): Result<void, string> {
  if (!exists(join(dataDir, RESTORE_FILE))) return err("no restored database is ready");
  for (const step of swapSteps(dataDir)) {
    const done = step.run();
    if (done.isErr()) return err(`${step.name}: ${done.error.message}`);
  }
  return ok(undefined);
}

/** What a start found of a restore's swap (`retryWaitingRestore`). */
export type RestoreRetry =
  | { readonly kind: "nothing" }
  | { readonly kind: "swapped" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * "A swap that did not happen" (m2-design.md section 9, under the restore's switch): called by the
 * hub's start before it opens the database (`main.ts`, the integrator's). With no `hub.db.restore`
 * waiting, `nothing`. With one, the swap is run again, from its first step (`swapSteps`, whose
 * every step may run again whatever an earlier cut left): `swapped`, and the start goes on with
 * the restored database, whose restore mark makes `upkeep` record `restored` once and clear it,
 * as after a first swap; or `refused` with the reason, the old database untouched and the file
 * still waiting for the next start, which the caller warns of (`restore_waiting`). The file is
 * never removed here. At a start nothing of the hub's holds the database: the hub's connection is
 * not open yet, and the launcher's one database work, a rollback's copy, ends before it starts the
 * hub; only an outside reader can make the checkpoint busy.
 */
export function retryWaitingRestore(dataDir: string): RestoreRetry {
  if (!exists(join(dataDir, RESTORE_FILE))) return { kind: "nothing" };
  const swapped = swapRestored(dataDir);
  return swapped.isOk() ? { kind: "swapped" } : { kind: "refused", reason: swapped.error };
}

/** Every frame of the log at `path` checkpointed into the database, the log left empty. */
function checkpointed(path: string): Result<void, FileError> {
  const opened = openDatabase(path, ORIGIN, { create: false });
  if (opened.isErr()) return err({ reason: "io", message: opened.error.message });
  const db = opened.value;
  const done = sqlite(ORIGIN, `checkpoint ${path}`, () => {
    const row = db
      .query<{ busy: number; log: number; checkpointed: number }, []>(
        "PRAGMA wal_checkpoint(TRUNCATE)",
      )
      .get();
    if (row?.busy !== 0) return "the log is in use; nothing was checkpointed";
    if (row.log > 0 && row.checkpointed !== row.log)
      return `only ${row.checkpointed} of ${row.log} log frames went in`;
    return undefined;
  });
  const closed = closeDatabase(db, ORIGIN);
  if (done.isErr()) return err({ reason: "io", message: done.error.message });
  if (done.value !== undefined) return err({ reason: "io", message: done.value });
  if (closed.isErr()) return err({ reason: "io", message: closed.error.message });
  return ok(undefined);
}

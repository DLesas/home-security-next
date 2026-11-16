/**
 * Migrations at start (hub-design.md section 6, "Migrations"), before the boot event. The
 * outstanding ones are applied in one transaction by Drizzle's migrator. Before every migration of
 * an existing database the database is copied with `VACUUM INTO hub.db.before-<n>` ‡, `n` the
 * first outstanding one: a rollback after a version switch needs the copy whatever the migration
 * changed, additions included (m2-design.md section 11, "Step 1, wave 2"). Older copies are
 * removed first, then the copy is made at a temporary name (`hub.db.copying`), synced, renamed to
 * its final name and the folder synced, and only then does the migration run. So the folder never
 * holds more than the database and one copy (at the size guard's hard stop, two times 283 MB, not
 * three), and a copy present is always whole. Nothing is lost by removing the older first: a
 * migration runs only after its own copy is in place, so with no copy the database is still the
 * version before's; the older copy belongs to a switch that was healthy before this one could
 * begin (`upkeep` refuses an upload or approval while a switch is on trial, and the launcher holds
 * one trial at a time); and the launcher, finding no new whole copy, puts nothing back and leaves
 * `hub.db` as it is, which is the old version's. A temporary file a kill left is removed at the
 * next start and is never taken for a copy (its name does not begin `hub.db.before-`).
 * A database newer than the code is refused, which is what lets D54 switch back to the previous
 * version: the caller records it in `fatal.log` and on standard error and exits.
 */
import type { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import { err, ok, Result } from "neverthrow";
import type { StorageError } from "../../ports/writer.ts";
import { folderNames, placeDurably, removeFile } from "../safe/fs.ts";
import { applyMigrations, type MigrationFile, readMigrations } from "../safe/migrate.ts";
import { sqlite } from "../safe/sqlite.ts";

const ORIGIN = "shell/storage/migrations";
const CALLER = { kind: "storage", origin: ORIGIN } as const;

/** Drizzle's record of the migrations applied, one row each with its journal time. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** The copy kept before migration `n` (its index in the journal) changes a table. */
export function backupPath(dbPath: string, n: number): string {
  return `${dbPath}.before-${n}`;
}

/** Where a copy is made before it is put in place; never a name the launcher takes for a copy. */
export function copyingPath(dbPath: string): string {
  return `${dbPath}.copying`;
}

/**
 * Where a test stops the copy, as a kill there would: once the older copies are gone, after the
 * temporary copy, or once it is placed.
 */
export type CopyStop = "pruned" | "copied" | "placed";

export interface MigrationReport {
  /** Migrations already applied before this start. */
  readonly applied: number;
  /** The indexes of the migrations this start applied. */
  readonly ran: readonly number[];
  /** The copy made first, if one was. */
  readonly backup: string | undefined;
}

/** The journal time of the newest migration applied, or undefined for a new database. */
function newestApplied(db: Database): Result<number | undefined, StorageError> {
  return sqlite(ORIGIN, "read the applied migrations", () => {
    const table = db
      .query<{ name: string }, [string]>(
        `SELECT "name" FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(MIGRATIONS_TABLE);
    if (table === null) return undefined;
    const row = db
      .query<{ newest: number | null }, []>(
        `SELECT max(CAST("created_at" AS INTEGER)) AS "newest" FROM "${MIGRATIONS_TABLE}"`,
      )
      .get();
    return row?.newest ?? undefined;
  });
}

/**
 * Copies the database to `path` before a migration: every older copy deleted first, so only the
 * newest is kept (section 6, "The size guard"), then the copy made at the temporary name, synced
 * and put in place. The folder never holds the database and two copies, and never a partial copy
 * under a copy's name. `stop` is for the tests of a kill at each step: it goes no further.
 */
function copyBefore(
  db: Database,
  dbPath: string,
  path: string,
  stop: CopyStop | undefined,
): Result<void, StorageError> {
  const folder = dirname(dbPath);
  // Only the migrations' copies, `hub.db.before-<n>` (the launcher's `COPY_NAME`): never
  // `hub.db.before-restore`, the person's way back from a restore, which a restored older backup
  // migrating at its first start must not delete.
  const copy = new RegExp(`^${basename(dbPath).replaceAll(".", "\\.")}\\.before-\\d+$`, "u");
  const older = folderNames(CALLER, folder).andThen((names) =>
    Result.combine(
      names.filter((name) => copy.test(name)).map((name) => removeFile(CALLER, join(folder, name))),
    ),
  );
  if (older.isErr()) return err(older.error);
  if (stop === "pruned") return ok(undefined);
  const temporary = copyingPath(dbPath);
  const copied = sqlite(ORIGIN, `copy the database to ${temporary}`, () => {
    db.query("VACUUM INTO ?").run(temporary);
  });
  if (copied.isErr()) return err(copied.error);
  if (stop === "copied") return ok(undefined);
  const placed = placeDurably(CALLER, temporary, path);
  if (placed.isErr()) return err(placed.error);
  return ok(undefined);
}

/**
 * Applies `folder`'s outstanding migrations to the database at `dbPath`, open as `db`. Refuses a
 * database whose newest applied migration is newer than the code's newest.
 */
export function migrateAtStart(
  db: Database,
  dbPath: string,
  folder: string,
  stop?: CopyStop,
): Result<MigrationReport, StorageError> {
  // A copy an earlier start was killed in the middle of: never a copy, so gone first.
  const leftover = removeFile(CALLER, copyingPath(dbPath));
  if (leftover.isErr()) return err(leftover.error);
  const files = readMigrations(folder);
  if (files.isErr()) return err(files.error);
  const applied = newestApplied(db);
  if (applied.isErr()) return err(applied.error);
  const newestCode = Math.max(0, ...files.value.map((file) => file.folderMillis));
  const last = applied.value;
  if (last !== undefined && last > newestCode) {
    return err({
      kind: "storage",
      origin: ORIGIN,
      message: `the database was migrated by a newer hub (migration of ${last}, this code's newest is ${newestCode})`,
      detail: { code: "newerThanCode", database: last, code_newest: newestCode },
    });
  }
  const outstanding = files.value
    .map((file, n): readonly [MigrationFile, number] => [file, n])
    .filter(([file]) => last === undefined || file.folderMillis > last);
  const alreadyApplied = files.value.length - outstanding.length;
  const first = outstanding[0];
  const backup =
    last !== undefined && first !== undefined ? backupPath(dbPath, first[1]) : undefined;
  if (backup !== undefined) {
    const copied = copyBefore(db, dbPath, backup, stop);
    if (copied.isErr()) return err(copied.error);
    if (stop !== undefined) return ok({ applied: alreadyApplied, ran: [], backup });
  }
  if (outstanding.length > 0) {
    const migrated = applyMigrations(db, folder);
    if (migrated.isErr()) return err(migrated.error);
  }
  return ok({ applied: alreadyApplied, ran: outstanding.map(([, n]) => n), backup });
}

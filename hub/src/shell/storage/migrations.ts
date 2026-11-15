/**
 * Migrations at start (hub-design.md section 6, "Migrations"), before the boot event. The
 * outstanding ones are applied in one transaction by Drizzle's migrator. Before every migration of
 * an existing database the database is copied with `VACUUM INTO hub.db.before-<n>` ‡, `n` the
 * first outstanding one: a rollback after a version switch needs the copy whatever the migration
 * changed, additions included (m2-design.md section 11, "Step 1, wave 2").
 * A database newer than the code is refused, which is what lets D54 switch back to the previous
 * version: the caller records it in `fatal.log` and on standard error and exits.
 */
import type { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import { err, ok, Result } from "neverthrow";
import type { StorageError } from "../../ports/writer.ts";
import { folderNames, removeFile } from "../safe/fs.ts";
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
 * Copies the database to `path` before a migration. Every older copy is deleted first: only the
 * newest is kept, and the folder never holds the database and two copies at once (section 6,
 * "The size guard").
 */
function copyBefore(db: Database, dbPath: string, path: string): Result<void, StorageError> {
  const folder = dirname(dbPath);
  const prefix = `${basename(dbPath)}.before-`;
  const older = folderNames(CALLER, folder).andThen((names) =>
    Result.combine(
      names
        .filter((name) => name.startsWith(prefix))
        .map((name) => removeFile(CALLER, join(folder, name))),
    ),
  );
  if (older.isErr()) return err(older.error);
  return sqlite(ORIGIN, `copy the database to ${path}`, () => {
    db.query("VACUUM INTO ?").run(path);
  });
}

/**
 * Applies `folder`'s outstanding migrations to the database at `dbPath`, open as `db`. Refuses a
 * database whose newest applied migration is newer than the code's newest.
 */
export function migrateAtStart(
  db: Database,
  dbPath: string,
  folder: string,
): Result<MigrationReport, StorageError> {
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
    const copied = copyBefore(db, dbPath, backup);
    if (copied.isErr()) return err(copied.error);
  }
  if (outstanding.length > 0) {
    const migrated = applyMigrations(db, folder);
    if (migrated.isErr()) return err(migrated.error);
  }
  return ok({ applied: alreadyApplied, ran: outstanding.map(([, n]) => n), backup });
}

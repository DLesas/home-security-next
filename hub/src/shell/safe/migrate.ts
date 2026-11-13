/**
 * Drizzle's bun:sqlite migrator behind a result (hub-design.md sections 6 and 10). It reads the
 * migration files, which throws on a missing journal or file, and applies the outstanding ones
 * in one transaction, rolled back and thrown on a failed statement.
 */
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { err, ok, type Result } from "neverthrow";
import type { StorageError } from "../../ports/writer.ts";
import { errorFrom } from "./thrown.ts";

const ORIGIN = "shell/safe/migrate";

/** One migration as Drizzle reads it: its statements, its journal time and its hash. */
export interface MigrationFile {
  readonly sql: readonly string[];
  readonly folderMillis: number;
  readonly hash: string;
}

/** Reads every migration of the folder's journal, in journal order. */
export function readMigrations(folder: string): Result<readonly MigrationFile[], StorageError> {
  try {
    return ok(readMigrationFiles({ migrationsFolder: folder }));
  } catch (thrown) {
    return err(errorFrom("storage", ORIGIN, `read migrations in ${folder}`, thrown));
  }
}

/** Applies the outstanding migrations of `folder` to `db`, all in one transaction. */
export function applyMigrations(db: Database, folder: string): Result<void, StorageError> {
  try {
    migrate(drizzle(db), { migrationsFolder: folder });
    return ok(undefined);
  } catch (thrown) {
    return err(errorFrom("storage", ORIGIN, `apply migrations in ${folder}`, thrown));
  }
}

/**
 * `bun:sqlite` behind results (hub-design.md section 10: it throws on prepare, run,
 * transaction and pragmas). The writer and the reader run every database call through
 * `sqlite`, which also covers Drizzle's queries over the same connection.
 */
import { Database } from "bun:sqlite";
import { err, ok, type Result } from "neverthrow";
import type { StorageError } from "../../ports/writer.ts";
import { errorFrom } from "./thrown.ts";

/** Runs `run`, which calls the database, and returns what it returns or the error it threw. */
export function sqlite<T>(origin: string, what: string, run: () => T): Result<T, StorageError> {
  try {
    return ok(run());
  } catch (thrown) {
    return err(errorFrom("storage", origin, what, thrown));
  }
}

/** Opens (creating if asked) the database at `path`, with strict binding of `?` parameters. */
export function openDatabase(
  path: string,
  origin: string,
  options: { readonly create: boolean },
): Result<Database, StorageError> {
  return sqlite(
    origin,
    `open ${path}`,
    () => new Database(path, { create: options.create, readwrite: true, strict: true }),
  );
}

/** Closes the connection; SQLite then checkpoints and removes the write-ahead log if it can. */
export function closeDatabase(db: Database, origin: string): Result<void, StorageError> {
  return sqlite(origin, "close", () => {
    db.close(true);
  });
}

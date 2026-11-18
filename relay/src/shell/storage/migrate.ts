/**
 * Applies drizzle-kit's migrations (`migrations/`, made by `bun run db:generate`) to the relay's
 * database, each once, in the journal's order, all outstanding ones in one transaction. The SQL is
 * imported as text, so `bun build --compile` carries it inside the program; drizzle's own migrator
 * reads a folder at run time, which a compiled program does not have.
 *
 * Every migration made must be added to `MIGRATIONS` below; a test checks the journal and the
 * list agree, and that the migrated tables have exactly the schema's columns.
 */
import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "neverthrow";
import { relayError, type RelayError } from "../errors.ts";
import { attempt } from "../safe/attempt.ts";
import journal from "./migrations/meta/_journal.json";
import relay0000 from "./migrations/0000_relay.sql" with { type: "text" };

const ORIGIN = "shell/storage/migrate";

/** Each migration's SQL by its journal tag. */
export const MIGRATIONS: Readonly<Record<string, string>> = { "0000_relay": relay0000 };

/** The journal's tags, in order. */
export const JOURNAL_TAGS: readonly string[] = journal.entries.map((entry) => entry.tag);

export function migrate(db: Database): Result<number, RelayError> {
  const statements: string[] = [];
  const applied = attempt("storage", ORIGIN, "read applied migrations", () => {
    db.run(
      "CREATE TABLE IF NOT EXISTS relay_migrations (tag TEXT PRIMARY KEY NOT NULL, applied_ms INTEGER NOT NULL)",
    );
    return new Set(
      db
        .query<{ tag: string }, []>("SELECT tag FROM relay_migrations")
        .all()
        .map((row) => row.tag),
    );
  });
  if (applied.isErr()) return err(applied.error);
  const due = JOURNAL_TAGS.filter((tag) => !applied.value.has(tag));
  for (const tag of due) {
    const text = MIGRATIONS[tag];
    if (text === undefined) {
      return err(relayError("storage", ORIGIN, "a migration in the journal is not in MIGRATIONS"));
    }
    statements.push(
      ...text
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }
  if (due.length === 0) return ok(0);
  return attempt("storage", ORIGIN, "apply migrations", () => {
    db.transaction(() => {
      for (const statement of statements) db.run(statement);
      for (const tag of due) {
        db.run("INSERT INTO relay_migrations (tag, applied_ms) VALUES (?, ?)", [tag, Date.now()]);
      }
    })();
    return due.length;
  });
}

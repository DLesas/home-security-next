/**
 * What a backup holds (m2-design.md section 9; D53, Q9) and how its database is made: the
 * configuration tables and keys, each device's replay window and each gateway's highest hello
 * counter (`device_state`), and the migrations applied, copied from the hub's database through the
 * writer's one connection (HD 5) into a SQLite database **in memory**, serialised, and sealed by the
 * caller before a byte reaches a disk.
 *
 * Not held: link tokens and their secrets (a token restored could be used again), the clients'
 * stored replies (they belong to sessions that are gone), the backup key (the phone brings it to a
 * restore), the update state (it belongs to the installed program), countdowns, the alarm and the
 * boots (a restore is for a hub with no devices). History only in an export that asks for it.
 *
 * Migration 3's tables (the joint step 0, docs/m3-m4-plan.md), each decided from its design:
 * - `relay_settings`: held (m4-design section 4, "New tables"): the relay a restored hub connects
 *   to is a setting like the site's.
 * - `device_keys`' `next_key` and `rekey`: held with the row, as every column is (m3-updates-design
 *   section 7, "Backups hold `next_key` and `rekey`"); the restore then marks every key for change
 *   (`restore.ts`).
 * - `firmware_images`, `rollouts`, `device_updates`: not held. Firmware is in no backup
 *   (m3-updates-design sections 1 and 4, D140): it can be added again, and a restored hub learns
 *   what each device runs from its Started; a rollout names an image and a device's update state
 *   names its rollout, so neither means anything without the images.
 * - `push_keys`: never, in any file. `push_targets` and `push_outbox`: not held. A push key is a
 *   secret kept apart as `link_secrets` is (m4-design section 4), and a restored one is wrong for
 *   the reason a restored link token is: the phone may have replaced it since the backup (every 30
 *   days ‡, section 5), and a restored target would tell the phone, through the snapshot's `push`,
 *   that the hub holds a valid one, so the phone would not register again and its alerts would be
 *   sealed with a key it no longer has. Without them the snapshot says none is held and each phone
 *   registers at its next session. An outbox row names a notification of the old hub's history,
 *   which a backup does not hold, and a push that went before the backup would go again. (This
 *   departs from m4-design section 4's "backups gain `push_targets` and `push_keys`", by the
 *   reviewer's brief to A8.)
 */
import { Database } from "bun:sqlite";
import { err, ok, Result } from "neverthrow";
import { HUB_DEVICE } from "../../core/model/ids.ts";
import type { StorageError } from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";

const ORIGIN = "shell/backup/contents";

/** Drizzle's record of the migrations applied: the schema version a restore migrates from. */
export const MIGRATIONS_TABLE = "__drizzle_migrations";

/** The tables of every backup. */
export const BACKUP_TABLES = [
  MIGRATIONS_TABLE,
  "devices",
  "device_keys",
  "send_counters",
  "hub_keys",
  "site",
  "sensor_config",
  "siren_config",
  "gateway_config",
  "device_state",
  "people",
  "clients",
  "permissions",
  "person_roles",
  "groups",
  "group_members",
  "group_sirens",
  "modes",
  "mode_groups",
  "mode_state",
  "people_settings",
  "schedule_state",
  "schedules",
  "health_state",
  "notification_prefs",
  "backup_state",
  "relay_settings",
] as const;

/** Never in any file, history or not: secrets that would work again, and replies of dead sessions. */
export const NEVER_TABLES = [
  "link_tokens",
  "link_secrets",
  "client_replies",
  "backup_key",
  "push_keys",
] as const;

/**
 * Every other table, left out of a backup, with why (above): so that each table of the schema is
 * in exactly one of the three lists, and a table a later migration adds must be decided (a test
 * checks it).
 */
export const LEFT_OUT_TABLES = [
  // History (D57): only in an export that asks for it.
  "rx_routine",
  "rx_event",
  "tx_routine",
  "tx_event",
  "decisions",
  "device_log",
  "hub_events",
  "commands",
  "rejects",
  "loss_daily",
  "notifications",
  "notification_reads",
  // This run's: a restore is for a hub with no devices.
  "countdowns",
  "alarm",
  "alarm_triggers",
  "alarm_sirens",
  "boots",
  // The installed program's.
  "update_state",
  // Migration 3: firmware is in no backup; push targets and their outbox go with the keys.
  "firmware_images",
  "rollouts",
  "device_updates",
  "push_targets",
  "push_outbox",
] as const;

type Value = string | number | bigint | boolean | Uint8Array | null;

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A table's `CREATE` statement in `db`, or undefined when it has none. */
export function createSql(db: Database, table: string): Result<string | undefined, StorageError> {
  return sqlite(ORIGIN, `read the schema of ${table}`, () => {
    const row = db
      .query<{ sql: string | null }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    return row?.sql ?? undefined;
  });
}

/** A table's column names, in order. */
export function columnsOf(db: Database, table: string): Result<readonly string[], StorageError> {
  return sqlite(ORIGIN, `read the columns of ${table}`, () =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${quoted(table)})`)
      .all()
      .map((c) => c.name),
  );
}

/** Copies every row of `table` from `from` to `to`, by column name; `to` has the table. */
export function copyRows(
  from: Database,
  to: Database,
  table: string,
  columns: readonly string[],
): Result<number, StorageError> {
  const list = columns.map(quoted).join(", ");
  return sqlite(ORIGIN, `copy ${table}`, () => {
    const rows = from
      .query<Value[], []>(`SELECT ${list} FROM ${quoted(table)}`)
      .values() as Value[][];
    const insert = to.query(
      `INSERT INTO ${quoted(table)} (${list}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) insert.run(...(row as never[]));
    return rows.length;
  });
}

/** How many migrations a database has applied: its schema version (the header's `schema`). */
export function schemaVersion(db: Database): Result<number, StorageError> {
  return sqlite(ORIGIN, "count the migrations applied", () => {
    const table = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(MIGRATIONS_TABLE);
    if (table === null) return 0;
    return (
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${quoted(MIGRATIONS_TABLE)}`).get()
        ?.n ?? 0
    );
  });
}

/**
 * The backup's database, serialised: an in-memory SQLite database with the tables' own schema and
 * rows. The hub's commit mark (device 0's `device_state` row) stays out: it is this boot's, not
 * the home's.
 */
export function backupDatabase(source: Database): Result<Uint8Array, StorageError> {
  const tables: readonly string[] = BACKUP_TABLES;
  const opened = sqlite(
    ORIGIN,
    "open a database in memory",
    () => new Database(":memory:", { strict: true }),
  );
  if (opened.isErr()) return err(opened.error);
  const memory = opened.value;
  const built = sqlite(ORIGIN, "begin", () => memory.run("BEGIN"))
    .andThen(() =>
      Result.combine(
        tables.map((table) =>
          createSql(source, table).andThen((sql) => {
            if (sql === undefined) return ok(0);
            return sqlite(ORIGIN, `create ${table}`, () => memory.run(sql))
              .andThen(() => columnsOf(source, table))
              .andThen((columns) => copyRows(source, memory, table, columns));
          }),
        ),
      ),
    )
    .andThen(() =>
      sqlite(ORIGIN, "leave out the commit mark", () =>
        memory.run(`DELETE FROM "device_state" WHERE "device_id" = ?`, [HUB_DEVICE]),
      ),
    )
    .andThen(() => sqlite(ORIGIN, "commit", () => memory.run("COMMIT")))
    .andThen(() => sqlite(ORIGIN, "serialise", () => memory.serialize()));
  sqlite(ORIGIN, "close", () => {
    memory.close();
  }).match(
    () => undefined,
    () => undefined,
  );
  return built;
}

/** Where a table's copy in pieces has got to: its columns, its key, the last key copied. */
export interface RowCursor {
  readonly table: string;
  readonly columns: readonly string[];
  /** The primary key's columns, in order; `rowid` for a table without one. */
  readonly key: readonly string[];
  last: readonly Value[] | undefined;
}

/** A cursor at the start of `table` in `db`. */
export function rowCursor(db: Database, table: string): Result<RowCursor, StorageError> {
  return columnsOf(db, table).andThen((columns) =>
    sqlite(ORIGIN, `read the key of ${table}`, () =>
      db
        .query<{ name: string; pk: number }, []>(`PRAGMA table_info(${quoted(table)})`)
        .all()
        .filter((c) => c.pk > 0)
        .toSorted((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    ).map((pk) => ({ table, columns, key: pk.length > 0 ? pk : ["rowid"], last: undefined })),
  );
}

/**
 * At most `limit` rows of the cursor's table copied from `from` to `to`, in key order after the
 * last copied, so rows added meanwhile come in or not and none twice; true when the table is done.
 */
export function copyBatch(
  from: Database,
  to: Database,
  cursor: RowCursor,
  limit: number,
): Result<boolean, StorageError> {
  return sqlite(ORIGIN, `copy ${cursor.table}`, () => {
    const list = cursor.columns.map(quoted).join(", ");
    const keys = cursor.key.map(quoted).join(", ");
    const keyAt = cursor.key.map((k) => cursor.columns.indexOf(k));
    const extra = keyAt.includes(-1) ? `, ${keys}` : "";
    const where =
      cursor.last === undefined
        ? ""
        : `WHERE (${keys}) > (${cursor.key.map(() => "?").join(", ")})`;
    const rows = from
      .query(
        `SELECT ${list}${extra} FROM ${quoted(cursor.table)} ${where} ORDER BY ${keys} LIMIT ${limit}`,
      )
      .values(...((cursor.last ?? []) as never[])) as Value[][];
    const insert = to.query(
      `INSERT INTO ${quoted(cursor.table)} (${list}) VALUES (${cursor.columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) insert.run(...(row.slice(0, cursor.columns.length) as never[]));
    const last = rows.at(-1);
    if (last !== undefined)
      cursor.last = keyAt.map((at, i) =>
        at >= 0 ? (last[at] ?? null) : (last[cursor.columns.length + i] ?? null),
      );
    return rows.length < limit;
  });
}

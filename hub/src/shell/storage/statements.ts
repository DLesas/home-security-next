/**
 * The writer's SQL (hub-design.md section 5, "SQLite settings": the hot inserts and upserts use
 * prepared `bun:sqlite` statements made once at start). Every statement is built from the
 * table descriptions of `tables.ts` and binds a row by its property names, so a row of the core
 * goes to SQLite as it is.
 */
import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import type { Result } from "neverthrow";
import type { AuditRecord } from "../../core/model/audit.ts";
import type { AuditTable, PruneOp, StateTable } from "../../core/model/store.ts";
import type { StorageError } from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";
import { AUDIT_SPECS, type ColumnSpec, STATE_SPECS, type TableSpec } from "./tables.ts";

const ORIGIN = "shell/storage/statements";

/** A row's values by property name, as `bun:sqlite` binds `:name` parameters. */
export type BoundRow = Readonly<Record<string, Exclude<SQLQueryBindings, Record<string, unknown>>>>;

/**
 * A row of the core as SQLite parameters. Every column type of `core/model/rows.ts` (numbers
 * and their brands, strings, booleans, bytes, null) is one `bun:sqlite` binds, which the
 * schema test holds the row types to; the cast only drops the row's interface name.
 */
export function bindRow(row: object): BoundRow {
  return row as BoundRow;
}

const quote = (name: string): string => `"${name}"`;
const param = (column: ColumnSpec): string => `:${column.prop}`;
const names = (columns: readonly ColumnSpec[]): string =>
  columns.map((c) => quote(c.name)).join(", ");

function insertSql(spec: TableSpec): string {
  return `INSERT INTO ${quote(spec.name)} (${names(spec.columns)}) VALUES (${spec.columns.map(param).join(", ")})`;
}

function upsertSql(spec: TableSpec): string {
  const others = spec.columns.filter((c) => !spec.key.includes(c));
  // A table that is all key (M2's pairs: a group's members, a mode's groups) has nothing to update.
  if (others.length === 0) return `${insertSql(spec)} ON CONFLICT (${names(spec.key)}) DO NOTHING`;
  const set = others.map((c) => `${quote(c.name)} = excluded.${quote(c.name)}`).join(", ");
  return `${insertSql(spec)} ON CONFLICT (${names(spec.key)}) DO UPDATE SET ${set}`;
}

function deleteSql(spec: TableSpec): string {
  const where = spec.key.map((c) => `${quote(c.name)} = ${param(c)}`).join(" AND ");
  return spec.key.length === 0
    ? `DELETE FROM ${quote(spec.name)}`
    : `DELETE FROM ${quote(spec.name)} WHERE ${where}`;
}

/** How one state table is written: keyed tables by upsert, single-row tables by replacing the row. */
interface StateStatements {
  /** Single-row tables only: empties the table before the insert. */
  readonly clear: Statement<unknown, []> | undefined;
  readonly write: Statement<unknown, [BoundRow]>;
  readonly remove: Statement<unknown, [BoundRow]>;
}

export interface Statements {
  readonly state: Readonly<Record<StateTable, StateStatements>>;
  /** Inserts for the audit tables; `rejects`' minute counts are upserted by their key. */
  readonly audit: Readonly<Record<AuditTable, Statement<unknown, [BoundRow]>>>;
  /** Sets the clean-stop mark in this boot's row of `boots` (section 5). */
  readonly cleanStop: Statement<unknown, [BoundRow]>;
  /**
   * A device's pending key change (`PendingKeyOp`, D141): `next_key` and `rekey` of its row and
   * nothing else, so the core never names the current key. No row, nothing written.
   */
  readonly pendingKey: Statement<unknown, [BoundRow]>;
}

function prepareState(db: Database, spec: TableSpec): StateStatements {
  const single = spec.key.length === 0;
  return {
    clear: single ? db.prepare<unknown, []>(deleteSql(spec)) : undefined,
    write: db.prepare<unknown, [BoundRow]>(single ? insertSql(spec) : upsertSql(spec)),
    remove: db.prepare<unknown, [BoundRow]>(deleteSql(spec)),
  };
}

function mapRecord<K extends string, V, W>(
  record: Readonly<Record<K, V>>,
  f: (value: V) => W,
): Readonly<Record<K, W>> {
  const entries = Object.entries<V>(record).map(([key, value]) => [key, f(value)]);
  // The keys are exactly `K`'s, since they come from `record`.
  return Object.fromEntries(entries) as Readonly<Record<K, W>>;
}

/** Prepares every statement of the hot path, once, at start. */
export function prepareStatements(db: Database): Result<Statements, StorageError> {
  return sqlite(ORIGIN, "prepare the writer's statements", () => ({
    state: mapRecord(STATE_SPECS, (spec) => prepareState(db, spec)),
    audit: mapRecord(AUDIT_SPECS, (spec) =>
      db.prepare<unknown, [BoundRow]>(spec.name === "rejects" ? upsertSql(spec) : insertSql(spec)),
    ),
    cleanStop: db.prepare<unknown, [BoundRow]>(
      `UPDATE "boots" SET "clean_stop_ms" = :cleanStopMs WHERE "id" = :id`,
    ),
    pendingKey: db.prepare<unknown, [BoundRow]>(
      `UPDATE "device_keys" SET "next_key" = :nextKey, "rekey" = :rekey WHERE "device_id" = :deviceId`,
    ),
  }));
}

/** The audit table a record is a row of (section 6). */
export function auditTableOf(record: AuditRecord): AuditTable {
  switch (record.kind) {
    case "rx":
      return record.table === "routine" ? "rx_routine" : "rx_event";
    case "tx":
      return record.table === "routine" ? "tx_routine" : "tx_event";
    case "decision":
      return "decisions";
    case "deviceLog":
      return "device_log";
    case "hubEvent":
      return "hub_events";
    case "command":
      return "commands";
    case "reject":
      return "rejects";
    case "notification":
      return "notifications";
    case "notificationRead":
      return "notification_reads";
  }
}

/** Wall milliseconds in a minute, for `rejects.minute`. */
const MINUTE_MS = 60_000;

/**
 * The first `seq` of `table` stamped at or after `beforeMs`, or undefined when every row is older
 * (section 6): `at_ms` never decreases with `seq`, so a binary search over row ids finds it with a
 * few dozen seeks and no time index. Row ids are sparse (boot × 2³² + n), so it searches by value.
 */
function firstSeqAtOrAfter(db: Database, table: string, beforeMs: number): number | undefined {
  const bounds = db
    .query<{ low: number | null; high: number | null }, []>(
      `SELECT MIN("seq") AS low, MAX("seq") AS high FROM ${table}`,
    )
    .get();
  if (bounds?.low == null || bounds.high == null) return undefined;
  const atOrAfter = db.query<{ seq: number; at: number }, [number]>(
    `SELECT "seq" AS seq, "at_ms" AS at FROM ${table} WHERE "seq" >= ? ORDER BY "seq" LIMIT 1`,
  );
  // The smallest value whose next row is not before the cutoff; values past the last row count.
  let low = bounds.low;
  let high = bounds.high + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = atOrAfter.get(middle);
    if (row !== null && row.at < beforeMs) low = row.seq + 1;
    else high = middle;
  }
  const first = atOrAfter.get(low);
  return first === null || first.at < beforeMs ? undefined : first.seq;
}

/**
 * Retention's delete (section 6): up to `limit` of the oldest rows stamped before the op's cutoff,
 * found inside the commit, in one statement, so a round frees at most a few dozen pages. Made when
 * retention runs, not on the hot path; `db.query` keeps each shape once made.
 */
export function prune(db: Database, op: PruneOp): number {
  if (op.table === "loss_daily") {
    return db
      .query(
        `DELETE FROM "loss_daily" WHERE ("device_id", "day") IN ` +
          `(SELECT "device_id", "day" FROM "loss_daily" WHERE "day" < ? ORDER BY "day" LIMIT ?)`,
      )
      .run(op.beforeDay, op.limit).changes;
  }
  if (op.table === "rejects") {
    return db
      .query(
        `DELETE FROM "rejects" WHERE ("minute", "via", "reason") IN ` +
          `(SELECT "minute", "via", "reason" FROM "rejects" WHERE "minute" < ? ORDER BY "minute" LIMIT ?)`,
      )
      .run(Math.floor(op.beforeMs / MINUTE_MS), op.limit).changes;
  }
  const table = quote(op.table);
  const first = firstSeqAtOrAfter(db, table, op.beforeMs);
  // Every row is older than the cutoff when none is at or after it.
  const bound = first ?? Number.MAX_SAFE_INTEGER;
  const levels = "levels" in op ? op.levels : [];
  const levelFilter =
    levels.length === 0 ? "" : ` AND "level" IN (${levels.map(() => "?").join(", ")})`;
  return db
    .query(
      `DELETE FROM ${table} WHERE "seq" IN ` +
        `(SELECT "seq" FROM ${table} WHERE "seq" < ?${levelFilter} ORDER BY "seq" LIMIT ?)`,
    )
    .run(bound, ...levels, op.limit).changes;
}

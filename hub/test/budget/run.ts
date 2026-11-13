/**
 * What section 5's budget limits, measured on a real SQLite file after a day of the whole hub:
 * commits, the bytes of every WAL frame (24-byte header and one page), and the file's size at
 * D57's retention. The rows retention deletes during the day are laid out before it starts.
 */
import { recordSeq } from "../../src/core/model/ids.ts";
import type { BootId } from "../../src/core/model/ids.ts";
import { PAGE_SIZE } from "../../src/shell/storage/settings.ts";
import type { OpenedStore } from "../../src/shell/storage/store.ts";
import { WAL_FRAME_HEADER_BYTES } from "../../src/shell/storage/wal.ts";
import type { WriterStats } from "../../src/shell/storage/writer.ts";
import { WALL_AT_START_MS } from "../world/home.ts";

const MB = 1024 * 1024;
const DAY_MS = 86_400_000;
/** D57: routine readings 30 days, events a year (section 6, "Kept"). */
const ROUTINE_DAYS = 30;
const EVENT_DAYS = 365;
const ROUTINE_TABLES = ["rx_routine", "tx_routine", "rejects"] as const;
const EVENT_TABLES = [
  "rx_event",
  "tx_event",
  "decisions",
  "device_log",
  "hub_events",
  "commands",
] as const;
/** The WAL never passes 8 MB ‡ (section 5, `journal_size_limit`). */
export const WAL_LIMIT_MB = 8;

export interface DayMeasured {
  readonly commits: number;
  readonly byReason: WriterStats["commitsByReason"];
  readonly walFrames: number;
  readonly checkpointedFrames: number;
  readonly megabytes: number;
  readonly routineRows: number;
  readonly eventRows: number;
  /** The day's rows, by table. */
  readonly rowsByTable: Readonly<Record<string, number>>;
  /** The file at D57's retention: the day's rows kept 30 days and a year, the rest as it is, and the WAL. */
  readonly projectedFileMegabytes: number;
}

/** Routine and event rows a day, from section 5's "Database size" table. */
export interface OlderRows {
  readonly routinePerDay: number;
  readonly eventPerDay: number;
}

/**
 * The rows the day's retention deletes, as an earlier boot wrote them: a day's routine rows 30
 * days back, a day's events a year back.
 */
export function writeOlderRows(store: OpenedStore, older: OlderRows, boot: BootId): void {
  const insert = (table: string, n: number, atMs: number) =>
    store.db
      .query(`INSERT INTO "${table}" VALUES (?, ?, 1, 10, 1, ?, 0, 2, 0, -95, 32, 5, ?)`)
      .run(recordSeq(boot, n) ?? 0, atMs, n, new Uint8Array(10));
  store.db.transaction(() => {
    for (let n = 0; n < older.routinePerDay; n++) {
      insert(
        "rx_routine",
        n,
        WALL_AT_START_MS - ROUTINE_DAYS * DAY_MS + Math.floor((n / older.routinePerDay) * DAY_MS),
      );
    }
    for (let k = 0; k < older.eventPerDay; k++) {
      insert(
        "rx_event",
        older.routinePerDay + k,
        WALL_AT_START_MS - EVENT_DAYS * DAY_MS + Math.floor((k / older.eventPerDay) * DAY_MS),
      );
    }
  })();
}

function count(store: OpenedStore, table: string, where = ""): number {
  return (
    store.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}" ${where}`).get()?.n ?? 0
  );
}

/** The day's rows kept 30 days and a year, the rest as it is, and the WAL at its limit. */
export function project(
  store: OpenedStore,
  dayBoot: BootId,
): {
  routineRows: number;
  eventRows: number;
  megabytes: number;
  rowsByTable: Record<string, number>;
} {
  const bytesByTable = new Map(
    store.db
      .query<{ name: string; bytes: number }, []>(
        "SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name",
      )
      .all()
      .map((row) => [row.name, row.bytes]),
  );
  const daySeq = recordSeq(dayBoot, 0) ?? 0;
  let projected = 0;
  let routineRows = 0;
  const rowsByTable: Record<string, number> = {};
  let eventRows = 0;
  for (const [tables, days] of [
    [ROUTINE_TABLES, ROUTINE_DAYS],
    [EVENT_TABLES, EVENT_DAYS],
  ] as const) {
    for (const table of tables) {
      const all = count(store, table);
      const today = table === "rejects" ? all : count(store, table, `WHERE seq >= ${daySeq}`);
      const perRow = all === 0 ? 0 : (bytesByTable.get(table) ?? 0) / all;
      projected += today * days * perRow;
      rowsByTable[table] = today;
      if (days === ROUTINE_DAYS) routineRows += today;
      else eventRows += today;
      bytesByTable.delete(table);
    }
  }
  for (const bytes of bytesByTable.values()) projected += bytes;
  return { routineRows, eventRows, megabytes: projected / MB + WAL_LIMIT_MB, rowsByTable };
}

/** The day measured: the writer's counts and the projection, after a last flush and checkpoint. */
export function measureDay(store: OpenedStore, dayBoot: BootId): DayMeasured {
  const { writer } = store;
  writer.flush("due")._unsafeUnwrap();
  writer.checkpointNow()._unsafeUnwrap();
  const projection = project(store, dayBoot);
  const { stats } = writer;
  return {
    commits: stats.commits,
    byReason: { ...stats.commitsByReason },
    walFrames: stats.walFrames,
    checkpointedFrames: stats.checkpointedFrames,
    megabytes: (stats.walFrames * (PAGE_SIZE + WAL_FRAME_HEADER_BYTES)) / MB,
    routineRows: projection.routineRows,
    eventRows: projection.eventRows,
    projectedFileMegabytes: projection.megabytes,
    rowsByTable: projection.rowsByTable,
  };
}

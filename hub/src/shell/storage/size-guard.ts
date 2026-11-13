/**
 * The size guard's work inside a commit (hub-design.md section 6, "The size guard (D112's
 * ceiling)"): the measure, and trimming. The writer runs both inside its routine commits' own
 * transactions, so trimming never commits on its own.
 *
 * - **The measure** is the pages in use: `page_count` less `freelist_count`, times the page size.
 *   Deleted rows free pages for reuse without shrinking the file (`auto_vacuum` is off).
 * - **Trimming** deletes, oldest first by `seq` and whatever their retention: up to N rows from
 *   each of `rx_routine`, `tx_routine` and `rejects`, never one inside the routine protected age;
 *   then, only when those three have nothing older left, up to N rows from each of `rx_event`,
 *   `tx_event`, `decisions` and the lower levels (below warning) of `device_log` and
 *   `hub_events`, never one inside the event protected age. It never touches configuration,
 *   device state, keys, counters, `commands`, or a warning or worse.
 * - **The protected ages** count back from the commit's record time: the later of the wall clock
 *   and the last commit's, as the rows' own `at_ms` are stamped (section 6), so a row stamped in
 *   this run is never older than the reference by more than it seems.
 */
import type { Database } from "bun:sqlite";
import type { TrimReport } from "../../core/model/events.ts";
import type { SizeGuardRules } from "../../core/model/rules.ts";
import { prune } from "./statements.ts";

const MINUTE_MS = 60_000;

/** The routine tables trimming takes from first, then the event ones (section 6). */
const ROUTINE_SEQ_TABLES = ["rx_routine", "tx_routine"] as const;
const EVENT_SEQ_TABLES = ["rx_event", "tx_event", "decisions"] as const;
/** Device log levels below warning (§6: 0 debug, 1 info). */
const DEVICE_LOG_LOWER: readonly number[] = [0, 1];
const HUB_EVENTS_LOWER: readonly ("debug" | "info")[] = ["debug", "info"];

/** The bytes of pages in use, read from the file's header. */
export function pagesInUseBytes(db: Database, pageSize: number): number {
  const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
  const free =
    db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
  return (pages - free) * pageSize;
}

/** The oldest row's time of a table, by `seq` (its time order, section 6). */
function oldestMs(db: Database, table: string): number | undefined {
  return (
    db.query<{ at_ms: number }, []>(`SELECT "at_ms" FROM "${table}" ORDER BY "seq" LIMIT 1`).get()
      ?.at_ms ?? undefined
  );
}

function oldestRejectMs(db: Database): number | undefined {
  const minute = db
    .query<{ minute: number | null }, []>(`SELECT min("minute") AS "minute" FROM "rejects"`)
    .get()?.minute;
  return minute === null || minute === undefined ? undefined : minute * MINUTE_MS;
}

function earliest(times: readonly (number | undefined)[]): number | null {
  const known = times.filter((t): t is number => t !== undefined);
  return known.length === 0 ? null : Math.min(...known);
}

/** One trimming round inside the commit's transaction: what it deleted and what is left. */
export function trimRound(
  db: Database,
  guard: SizeGuardRules,
  referenceMs: number,
  pageSize: number,
): TrimReport {
  const routineCut = referenceMs - guard.routineProtectedMs;
  const eventCut = referenceMs - guard.eventProtectedMs;
  const limit = guard.rowsPerCommit;
  let routineRows = 0;
  for (const table of ROUTINE_SEQ_TABLES)
    routineRows += prune(db, { table, op: "prune", beforeMs: routineCut, limit });
  routineRows += prune(db, { table: "rejects", op: "prune", beforeMs: routineCut, limit });
  const routineLeft = () => [
    ...ROUTINE_SEQ_TABLES.map((table) => oldestMs(db, table)),
    oldestRejectMs(db),
  ];
  const olderRoutineLeft = routineLeft().some((at) => at !== undefined && at < routineCut);
  let eventRows = 0;
  if (!olderRoutineLeft) {
    for (const table of EVENT_SEQ_TABLES)
      eventRows += prune(db, { table, op: "prune", beforeMs: eventCut, limit });
    eventRows += prune(db, {
      table: "device_log",
      op: "prune",
      beforeMs: eventCut,
      limit,
      levels: DEVICE_LOG_LOWER,
    });
    eventRows += prune(db, {
      table: "hub_events",
      op: "prune",
      beforeMs: eventCut,
      limit,
      levels: HUB_EVENTS_LOWER,
    });
  }
  return {
    routineRows,
    eventRows,
    oldestRoutineMs: earliest(routineLeft()),
    oldestEventMs: earliest(EVENT_SEQ_TABLES.map((table) => oldestMs(db, table))),
    inUseBytes: pagesInUseBytes(db, pageSize),
  };
}

/** Whether an error is SQLite refusing to grow the file: the hard stop (`SQLITE_FULL`). */
export function isDatabaseFull(message: string): boolean {
  return /database or disk is full|SQLITE_FULL/iu.test(message);
}

/**
 * SQLite's settings (hub-design.md section 5, "SQLite settings"), each set and then read back,
 * so a setting SQLite ignored (a page size asked for after the first table, a journal mode a
 * file system refuses) stops the hub at start instead of quietly costing the memory card.
 */
import { DEFAULT_RULES } from "../../core/model/rules.ts";
import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "neverthrow";
import type { StorageError } from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";

const ORIGIN = "shell/storage/settings";

/** 4,096 bytes: the file system's block and the memory card's write unit (section 5). */
export const PAGE_SIZE = 4096;

/** The WAL is reused, not truncated and regrown, up to 8 MB ‡ (section 5). */
export const JOURNAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;

/** −4,096: a 4 MB page cache, for a hot set of a few hundred pages (section 5). */
const CACHE_SIZE_KIB = -4096;

/** One setting: the statement that sets it, the pragma that reads it back and what it must read. */
export interface Setting {
  readonly pragma: string;
  readonly value: string | number;
  /** The value `PRAGMA <pragma>` must give back. */
  readonly expect: string | number;
  /** The column `PRAGMA <pragma>` answers in, when it is not the pragma's own name. */
  readonly column?: string;
  /**
   * Whether a larger number read back is accepted: SQLite never sets `max_page_count` below the
   * file's own size, so a file already past the hard stop opens with its size as the stop.
   */
  readonly atLeast?: boolean;
  readonly reason: string;
}

/**
 * The settings of section 5's table, in the order they must be set: the page size and auto-vacuum
 * before the first table and before the journal mode, which cannot change them afterwards.
 */
export function settingsFor(
  platform: NodeJS.Platform,
  hardStopBytes: number = DEFAULT_RULES.persistence.sizeGuard.hardStopBytes,
): readonly Setting[] {
  const maxPages = Math.floor(hardStopBytes / PAGE_SIZE);
  // macOS's ordinary fsync does not reach the disk; Linux's does (section 5).
  const fullfsync = platform === "darwin" ? 1 : 0;
  return [
    { pragma: "page_size", value: PAGE_SIZE, expect: PAGE_SIZE, reason: "the card's write unit" },
    { pragma: "auto_vacuum", value: "NONE", expect: 0, reason: "retention's pages are reused" },
    { pragma: "journal_mode", value: "WAL", expect: "wal", reason: "one file synced per commit" },
    { pragma: "synchronous", value: "FULL", expect: 2, reason: "a commit survives a power cut" },
    { pragma: "fullfsync", value: fullfsync, expect: fullfsync, reason: "macOS's fsync" },
    {
      pragma: "checkpoint_fullfsync",
      value: fullfsync,
      expect: fullfsync,
      reason: "macOS's fsync",
    },
    { pragma: "wal_autocheckpoint", value: 0, expect: 0, reason: "the writer checkpoints" },
    {
      pragma: "journal_size_limit",
      value: JOURNAL_SIZE_LIMIT_BYTES,
      expect: JOURNAL_SIZE_LIMIT_BYTES,
      reason: "the WAL file is reused",
    },
    { pragma: "cache_size", value: CACHE_SIZE_KIB, expect: CACHE_SIZE_KIB, reason: "hot set" },
    { pragma: "temp_store", value: "MEMORY", expect: 2, reason: "no temporary files" },
    { pragma: "mmap_size", value: 0, expect: 0, reason: "reads are rare" },
    {
      pragma: "max_page_count",
      value: maxPages,
      expect: maxPages,
      atLeast: true,
      reason: "the size guard's hard stop (section 6)",
    },
    { pragma: "foreign_keys", value: "ON", expect: 1, reason: "configuration integrity" },
    {
      pragma: "busy_timeout",
      value: 0,
      expect: 0,
      column: "timeout",
      reason: "one connection: busy is a fault",
    },
  ];
}

/** A setting as read back. */
export interface SettingReading {
  readonly pragma: string;
  readonly value: unknown;
}

/** Reads one setting back. */
export function readSetting(
  db: Database,
  setting: Pick<Setting, "pragma" | "column">,
): Result<unknown, StorageError> {
  return sqlite(ORIGIN, `read ${setting.pragma}`, () => {
    const row = db.query<Record<string, unknown>, []>(`PRAGMA ${setting.pragma}`).get();
    return row?.[setting.column ?? setting.pragma];
  });
}

/** Sets every setting, then reads each back; any that reads otherwise is an error. */
export function applySettings(
  db: Database,
  settings: readonly Setting[],
): Result<readonly SettingReading[], StorageError> {
  const readings: SettingReading[] = [];
  for (const setting of settings) {
    const set = sqlite(ORIGIN, `set ${setting.pragma}`, () => {
      db.run(`PRAGMA ${setting.pragma} = ${String(setting.value)}`);
    });
    if (set.isErr()) return err(set.error);
    const read = readSetting(db, setting);
    if (read.isErr()) return err(read.error);
    const accepted =
      read.value === setting.expect ||
      (setting.atLeast === true &&
        typeof read.value === "number" &&
        typeof setting.expect === "number" &&
        read.value >= setting.expect);
    if (!accepted) {
      return err({
        kind: "storage",
        origin: ORIGIN,
        message: `${setting.pragma} reads ${String(read.value)} after setting it, not ${String(setting.expect)}`,
        detail: { pragma: setting.pragma, expected: setting.expect },
      });
    }
    readings.push({ pragma: setting.pragma, value: read.value });
  }
  return ok(readings);
}

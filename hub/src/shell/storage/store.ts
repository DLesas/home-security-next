/**
 * The storage at start (hub-design.md section 7, "Hub restart", step 1, and section 5): the data
 * folder, `hub.db` with section 5's settings, the migrations, the snapshot the boot event
 * carries, how the last run ended, and the writer and reader on the one connection.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { BootInfo, DurableSnapshot } from "../../core/model/events.ts";
import type { DeviceId } from "../../core/model/ids.ts";
import type { HubRules } from "../../core/model/rules.ts";
import type { StoreOp } from "../../core/model/store.ts";
import type { Clock } from "../../ports/clock.ts";
import type { StorageError } from "../../ports/writer.ts";
import { ensureDir } from "../safe/fs.ts";
import { closeDatabase, openDatabase } from "../safe/sqlite.ts";
import { appendFatal, bootInfo, lastUncaught } from "./fatal.ts";
import { type MigrationReport, migrateAtStart } from "./migrations.ts";
import { SqliteReader } from "./reader.ts";
import { applySettings, PAGE_SIZE, type SettingReading, settingsFor } from "./settings.ts";
import { prepareStatements, type Statements } from "./statements.ts";
import { SqliteWriter } from "./writer.ts";

const ORIGIN = "shell/storage/store";

/** The database's file in the data folder (section 6). */
export const DATABASE_FILE = "hub.db";

export interface StoreOptions {
  readonly dataDir: string;
  /** `hub/drizzle/`. */
  readonly migrationsFolder: string;
  readonly clock: Clock;
  readonly rules: HubRules;
  readonly platform: NodeJS.Platform;
  /** The key store's `applyCommitted` (section 3). */
  readonly onCommitted?: (ops: readonly StoreOp[]) => void;
  /** The writer's stopwatch, for commit durations (lockstep: one that reads no host clock). */
  readonly stopwatch?: () => number;
}

export interface OpenedStore {
  readonly db: Database;
  readonly path: string;
  readonly statements: Statements;
  readonly settings: readonly SettingReading[];
  readonly migrations: MigrationReport;
  readonly writer: SqliteWriter;
  readonly reader: SqliteReader;
  readonly snapshot: DurableSnapshot;
  /** This run's id and how the last ended, for the boot event. */
  readonly boot: BootInfo;
}

function committedResumePoints(snapshot: DurableSnapshot): ReadonlyMap<DeviceId, number> {
  return new Map(snapshot.sendCounters.map((row) => [row.deviceId, row.resumePoint]));
}

/** Everything the storage does at start, in order; a database newer than the code is refused. */
export function openStore(options: StoreOptions): Result<OpenedStore, StorageError> {
  const folder = ensureDir({ kind: "storage", origin: ORIGIN }, options.dataDir);
  if (folder.isErr()) return err(folder.error);
  const path = join(options.dataDir, DATABASE_FILE);
  const opened = openDatabase(path, ORIGIN, { create: true });
  if (opened.isErr()) return err(opened.error);
  const db = opened.value;
  const started = start(db, path, options);
  if (started.isErr()) {
    closeDatabase(db, ORIGIN).match(
      () => undefined,
      () => undefined,
    );
    if (started.error.detail?.code === "newerThanCode") {
      const now = options.clock.now();
      appendFatal(options.dataDir, {
        kind: "refused",
        boot: null,
        atMs: now.wall,
        mono: now.mono,
        origin: started.error.origin,
        message: started.error.message,
      }).match(
        () => undefined,
        () => undefined,
      );
    }
  }
  return started;
}

function start(
  db: Database,
  path: string,
  options: StoreOptions,
): Result<OpenedStore, StorageError> {
  // The page size before the first table; then the migrations (section 5).
  const settings = applySettings(
    db,
    settingsFor(options.platform, options.rules.persistence.sizeGuard.hardStopBytes),
  );
  if (settings.isErr()) return err(settings.error);
  const migrations = migrateAtStart(db, path, options.migrationsFolder);
  if (migrations.isErr()) return err(migrations.error);
  const statements = prepareStatements(db);
  if (statements.isErr()) return err(statements.error);
  const reader = new SqliteReader(
    db,
    options.rules.silence.lossDays,
    options.rules.notify.unreadWindowMs,
  );
  const snapshot = reader.snapshot();
  if (snapshot.isErr()) return err(snapshot.error);
  const last = lastUncaught(options.dataDir);
  if (last.isErr()) return err(last.error);
  const boot = bootInfo(snapshot.value.previousBoot, last.value);
  const writer = new SqliteWriter({
    db,
    path,
    pageSize: PAGE_SIZE,
    statements: statements.value,
    clock: options.clock,
    boot: boot.id,
    rules: options.rules.persistence,
    durable: committedResumePoints(snapshot.value),
    ...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
    ...(options.stopwatch === undefined ? {} : { stopwatch: options.stopwatch }),
    onFailed: (error) => {
      const now = options.clock.now();
      // Best effort: a disk that cannot commit may not append either; the core records it too.
      appendFatal(options.dataDir, {
        kind: "commitFailed",
        boot: boot.id,
        atMs: now.wall,
        mono: now.mono,
        origin: error.origin,
        message: error.message,
      }).match(
        () => undefined,
        () => undefined,
      );
    },
  });
  return ok({
    db,
    path,
    statements: statements.value,
    settings: settings.value,
    migrations: migrations.value,
    writer,
    reader,
    snapshot: snapshot.value,
    boot,
  });
}

/**
 * The store at start and the send gate, on real SQLite files (hub-design.md sections 4, 5, 6
 * and 10): every SQLite setting read back, the snapshot, `hsn log`'s query, the migrations with
 * their copy and their refusal of a newer database, and how a start tells a clean stop from a
 * crash from a power cut.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { bootId, deviceId, seq } from "../../../src/core/model/ids.ts";
import type { BootRow, DeviceStateRow } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import type { StateTable, StoreOp } from "../../../src/core/model/store.ts";
import {
  appendFatal,
  bootInfo,
  fatalLogPath,
  lastUncaught,
  recordUncaught,
} from "../../../src/shell/storage/fatal.ts";
import { backupPath } from "../../../src/shell/storage/migrations.ts";
import { LOG_LIMIT } from "../../../src/shell/storage/reader.ts";
import { admitSend } from "../../../src/shell/storage/send-gate.ts";
import { readSetting, settingsFor } from "../../../src/shell/storage/settings.ts";
import { DATABASE_FILE, openStore, type OpenedStore } from "../../../src/shell/storage/store.ts";
import {
  BOOT,
  countdownRow,
  DAY_MS,
  deviceRow,
  deviceStateRow,
  hubEventRecord,
  MIGRATIONS,
  MINUTE_MS,
  openTestStore,
  record,
  rxRecord,
  sendCounterOp,
  sensorConfigRow,
  seqOf,
  tempDir,
  TestClock,
  WALL_AT_START_MS,
  write,
} from "./fixtures.ts";

let dir: ReturnType<typeof tempDir>;
let clock: TestClock;
let store: OpenedStore;

beforeEach(() => {
  dir = tempDir("store");
  clock = new TestClock();
  store = openTestStore(dir.path, clock);
});
afterEach(() => {
  store.db.close();
  dir.remove();
});

function reopen(): OpenedStore {
  store.db.close();
  store = openTestStore(dir.path, clock);
  return store;
}

describe("SQLite's settings (section 5)", () => {
  /** Section 5's table, as SQLite reads each back, written from the design, not from the code. */
  const DESIGN: Readonly<Record<string, number | string>> = {
    journal_mode: "wal",
    synchronous: 2,
    fullfsync: process.platform === "darwin" ? 1 : 0,
    checkpoint_fullfsync: process.platform === "darwin" ? 1 : 0,
    wal_autocheckpoint: 0,
    journal_size_limit: 8 * 1024 * 1024,
    // The size guard's hard stop: 240 MB of 4 KB pages (section 6).
    max_page_count: 61_440,
    page_size: 4096,
    cache_size: -4096,
    temp_store: 2,
    mmap_size: 0,
    auto_vacuum: 0,
    foreign_keys: 1,
    busy_timeout: 0,
  };

  test("every one is set and reads back as section 5's table says, on this platform", () => {
    const settings = settingsFor(process.platform);
    expect(store.settings.map((s) => s.pragma).toSorted()).toEqual(Object.keys(DESIGN).toSorted());
    for (const setting of settings) {
      expect([setting.pragma, readSetting(store.db, setting)._unsafeUnwrap()]).toEqual([
        setting.pragma,
        DESIGN[setting.pragma],
      ]);
    }
    expect(settingsFor("darwin").find((s) => s.pragma === "fullfsync")?.expect).toBe(1);
    expect(settingsFor("linux").find((s) => s.pragma === "fullfsync")?.expect).toBe(0);
  });

  test("they hold for a database opened again", () => {
    reopen();
    for (const setting of settingsFor(process.platform)) {
      expect([setting.pragma, readSetting(store.db, setting)._unsafeUnwrap()]).toEqual([
        setting.pragma,
        DESIGN[setting.pragma],
      ]);
    }
  });

  test("a page size SQLite cannot give is refused, not ignored", () => {
    store.db.close();
    const other = tempDir("pages");
    const db = new Database(join(other.path, DATABASE_FILE), { create: true });
    db.run("PRAGMA page_size = 1024");
    db.run("CREATE TABLE early (x)");
    db.close();
    const result = openStore({
      dataDir: other.path,
      migrationsFolder: MIGRATIONS,
      clock,
      rules: DEFAULT_RULES,
      platform: process.platform,
    });
    expect(result._unsafeUnwrapErr().message).toContain("page_size reads 1024");
    other.remove();
    store = openTestStore(dir.path, clock);
  });
});

describe("the send gate (section 4)", () => {
  const sensor = deviceId(3);

  test("holds a counter until a resume point above it is committed, then lets it through", () => {
    const { writer } = store;
    expect(
      admitSend(writer, [{ device: sensor, counter: 1 }], true)._unsafeUnwrapErr(),
    ).toMatchObject({ code: "notDurable" });
    writer.stage([write("now", sendCounterOp(sensor, 1024))]);
    expect(admitSend(writer, [{ device: sensor, counter: 1 }], true).isErr()).toBe(true);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(admitSend(writer, [{ device: sensor, counter: 1023 }], true).isOk()).toBe(true);
    expect(admitSend(writer, [{ device: sensor, counter: 1024 }], true).isErr()).toBe(true);
    writer.stage([write("now", sendCounterOp(sensor, 2048))]);
    expect(admitSend(writer, [{ device: sensor, counter: 1024 }], true).isErr()).toBe(true);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(admitSend(writer, [{ device: sensor, counter: 1024 }], true).isOk()).toBe(true);
  });

  test("checks every counter a send uses: a transmit request carries two", () => {
    const { writer } = store;
    const gateway = deviceId(2);
    writer.stage([
      write("now", sendCounterOp(sensor, 1024)),
      write("now", sendCounterOp(gateway, 62_464)),
    ]);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(
      admitSend(
        writer,
        [
          { device: sensor, counter: 9 },
          { device: gateway, counter: 61_440 },
        ],
        true,
      ).isOk(),
    ).toBe(true);
    expect(
      admitSend(
        writer,
        [
          { device: sensor, counter: 9 },
          { device: gateway, counter: 62_464 },
        ],
        true,
      ).isErr(),
    ).toBe(true);
  });

  test("holds every send of a turn whose now commit failed", () => {
    const { writer } = store;
    writer.stage([write("now", sendCounterOp(sensor, 1024))]);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(admitSend(writer, [], false).isErr()).toBe(true);
    expect(admitSend(writer, [{ device: sensor, counter: 5 }], false).isErr()).toBe(true);
  });

  test("a deleted key's counters are held; a restart knows every committed resume point", () => {
    const { writer } = store;
    writer.stage([
      write("now", sendCounterOp(sensor, 1024)),
      write("now", sendCounterOp(deviceId(4), 4096)),
    ]);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    writer.stage([
      write("now", { table: "send_counters", op: "delete", key: { deviceId: deviceId(4) } }),
    ]);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(writer.durable(deviceId(4))).toBeUndefined();
    const again = reopen();
    expect(again.writer.durable(sensor)).toBe(1024);
    expect(again.writer.durable(deviceId(4))).toBeUndefined();
  });
});

describe("the snapshot the boot event carries (section 7, 'Hub restart')", () => {
  test("holds every row of every state table, as the core wrote it", () => {
    const boot: BootRow = {
      id: BOOT,
      startedMs: WALL_AT_START_MS,
      startedTrusted: true,
      previousExit: "unknown",
      cause: "kill",
      cleanStopMs: null,
      trustedAtMono: mono(5),
      clockStepMs: -3,
    };
    const state: DeviceStateRow = {
      ...deviceStateRow(3, mono(9), 1),
      uptimeS: 77,
      estimates: new Uint8Array([1, 2]),
    };
    const ops: StoreOp[] = [
      { table: "devices", op: "upsert", row: deviceRow(3) },
      {
        table: "device_keys",
        op: "upsert",
        row: { deviceId: deviceId(3), key: new Uint8Array(16).fill(7) },
      },
      sendCounterOp(deviceId(3), 1024),
      {
        table: "hub_keys",
        op: "upsert",
        row: {
          signingPrivate: new Uint8Array([9]),
          signingPublic: new Uint8Array(64).fill(1),
          identity: new Uint8Array(8).fill(2),
          appStaticPrivate: null,
          appStaticPublic: null,
          tlsPrivate: null,
          tlsCertificate: null,
        },
      },
      { table: "sensor_config", op: "upsert", row: sensorConfigRow(3, 7) },
      { table: "countdowns", op: "upsert", row: countdownRow(3, seqOf(1, 4)) },
      {
        table: "alarm",
        op: "upsert",
        row: { boot: BOOT, startedMono: mono(30_000_000), causeSeq: seqOf(1, 5) },
      },
      {
        table: "alarm",
        op: "upsert",
        row: { boot: BOOT, startedMono: mono(31_000_000), causeSeq: seqOf(1, 6) },
      },
      {
        table: "alarm_triggers",
        op: "upsert",
        row: { sensorId: deviceId(3), kind: 0, boot: BOOT, atMono: mono(30_000_000) },
      },
      {
        table: "alarm_sirens",
        op: "upsert",
        row: { sirenId: deviceId(5), boot: BOOT, untilMono: mono(330_000_000), commanded: true },
      },
      { table: "boots", op: "upsert", row: boot },
      { table: "device_state", op: "upsert", row: state },
      ...Array.from({ length: 10 }, (_, day): StoreOp => ({
        table: "loss_daily",
        op: "upsert",
        row: { deviceId: deviceId(3), day: 20_000 + day, received: 470, expected: 480 },
      })),
    ];
    store.writer.stage(ops.map((op) => write("now", op)));
    store.writer.flushIfDue(clock.mono)._unsafeUnwrap();
    const snapshot = reopen().snapshot;
    expect(snapshot.devices).toEqual([deviceRow(3)]);
    expect(snapshot.sendCounters).toEqual([{ deviceId: deviceId(3), resumePoint: 1024 }]);
    expect(snapshot.hubKeys).toEqual({
      signingPublic: new Uint8Array(64).fill(1),
      identity: new Uint8Array(8).fill(2),
    });
    expect(snapshot.sensorConfig).toEqual([sensorConfigRow(3, 7)]);
    expect(snapshot.countdowns).toEqual([countdownRow(3, seqOf(1, 4))]);
    expect(snapshot.alarm).toEqual({
      boot: BOOT,
      startedMono: mono(31_000_000),
      causeSeq: seqOf(1, 6),
    });
    expect(snapshot.alarmSirens).toEqual([
      { sirenId: deviceId(5), boot: BOOT, untilMono: mono(330_000_000), commanded: true },
    ]);
    expect(snapshot.previousBoot).toEqual(boot);
    expect(snapshot.deviceState.find((row) => row.deviceId === deviceId(3))).toEqual(state);
    expect(snapshot.lossDaily.map((row) => row.day)).toEqual([
      20_003, 20_004, 20_005, 20_006, 20_007, 20_008, 20_009,
    ]);
    expect(snapshot.devices[0]?.chipId.constructor).toBe(Uint8Array);
  });

  test("names the newest boot as the previous one", () => {
    const row = (id: number): BootRow => ({
      id: bootId(id),
      startedMs: id,
      startedTrusted: false,
      previousExit: "clean",
      cause: null,
      cleanStopMs: null,
      trustedAtMono: null,
      clockStepMs: null,
    });
    store.writer.stage([
      write("now", { table: "boots", op: "upsert", row: row(2) }),
      write("now", { table: "boots", op: "upsert", row: row(1) }),
    ]);
    store.writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(reopen().snapshot.previousBoot?.id).toBe(bootId(2));
    expect(store.boot.id).toBe(bootId(3));
  });
});

describe("hsn log's query (sections 6 and 9)", () => {
  function fill(): void {
    const items = [];
    for (let n = 0; n < 300; n++) {
      items.push(
        record("routine", rxRecord(seqOf(1, n), 3 + (n % 2), WALL_AT_START_MS + n * MINUTE_MS)),
      );
    }
    items.push(
      record("now", hubEventRecord(seqOf(1, 400), WALL_AT_START_MS + 400 * MINUTE_MS, "warning")),
    );
    items.push(write("now", { table: "devices", op: "upsert", row: deviceRow(3, "front") }));
    store.writer.stage(items);
    store.writer.flushIfDue(clock.mono)._unsafeUnwrap();
  }

  test("finds a time by the sequence numbers, filters by kind and device, oldest first", () => {
    fill();
    const since = WALL_AT_START_MS + 250 * MINUTE_MS;
    const rx = store.reader.query({ logKind: "rx", since })._unsafeUnwrap();
    expect(rx.map((r) => (r.kind === "rx" ? r.row.seq : 0))).toEqual(
      Array.from({ length: 50 }, (_, n) => seqOf(1, 250 + n)),
    );
    expect(rx.map((r) => (r.kind === "rx" ? typeof r.row.clockOk : "none"))).toEqual(
      rx.map(() => "boolean"),
    );
    expect(rx[0]?.kind === "rx" && rx[0].row.body.constructor).toBe(Uint8Array);
    const front = store.reader.query({ device: "front", since })._unsafeUnwrap();
    expect(front.every((r) => r.kind === "rx" && r.row.deviceId === deviceId(3))).toBe(true);
    expect(front).toHaveLength(25);
    expect(store.reader.query({ logKind: "event" })._unsafeUnwrap()).toHaveLength(1);
    expect(store.reader.query({ device: "nobody" })._unsafeUnwrap()).toEqual([]);
    expect(store.reader.query({ since: WALL_AT_START_MS + DAY_MS })._unsafeUnwrap()).toEqual([]);
  });

  test("keeps to its limit across tables, newest kept", () => {
    // Alternating tables, so each table's own newest LOG_LIMIT are more than LOG_LIMIT together.
    const items = Array.from({ length: LOG_LIMIT + 200 }, (_, n) =>
      record(
        "routine",
        rxRecord(seqOf(1, n), 3, WALL_AT_START_MS + n, n % 2 === 0 ? "routine" : "event"),
      ),
    );
    store.writer.stage(items);
    store.writer.flush("log")._unsafeUnwrap();
    const all = store.reader.query({})._unsafeUnwrap();
    expect(all).toHaveLength(LOG_LIMIT);
    expect(all[0]?.kind === "rx" && all[0].row.seq).toBe(seqOf(1, 200));
    const newest = all.at(-1);
    expect(newest?.kind === "rx" && newest.row.seq).toBe(seqOf(1, LOG_LIMIT + 199));
  });
});

describe("retention's deletes (section 6)", () => {
  test("at most the limit, only rows stamped before the cutoff, only the levels named", () => {
    const items = [];
    for (let n = 0; n < 30; n++)
      items.push(record("routine", rxRecord(seqOf(1, n), 3, WALL_AT_START_MS + n)));
    for (const [n, level] of [
      [40, "debug"],
      [41, "info"],
      [42, "warning"],
      [43, "debug"],
    ] as const) {
      items.push(record("routine", hubEventRecord(seqOf(1, n), WALL_AT_START_MS + n, level)));
    }
    for (const minute of [10, 11, 12]) {
      items.push(
        record("routine", {
          kind: "reject",
          row: {
            minute,
            via: "link:x",
            reason: "badTag",
            count: 1,
            address: null,
            sample: new Uint8Array(16),
          },
        } as const),
      );
    }
    store.writer.stage(items);
    store.writer.flush("due")._unsafeUnwrap();
    store.writer.stage([
      write("routine", {
        table: "rx_routine",
        op: "prune",
        beforeMs: WALL_AT_START_MS + 20,
        limit: 8,
      }),
      write("routine", {
        table: "hub_events",
        op: "prune",
        beforeMs: WALL_AT_START_MS + 43,
        limit: 10,
        levels: ["debug"],
      }),
      write("routine", { table: "rejects", op: "prune", beforeMs: 12 * MINUTE_MS, limit: 10 }),
      record("routine", rxRecord(seqOf(1, 99), 3, WALL_AT_START_MS + 99)),
    ]);
    store.writer.flush("due")._unsafeUnwrap();
    const seqs = store.db
      .query<{ seq: number }, []>("SELECT seq FROM rx_routine ORDER BY seq")
      .all()
      .map((r) => r.seq - seqOf(1, 0));
    expect(seqs).toEqual([...Array.from({ length: 22 }, (_, n) => 8 + n), 99]);
    expect(store.db.query("SELECT level FROM hub_events ORDER BY seq").all()).toEqual([
      { level: "info" },
      { level: "warning" },
      { level: "debug" },
    ]);
    expect(store.db.query("SELECT minute FROM rejects").all()).toEqual([{ minute: 12 }]);
  });

  test("finds the cutoff by seq across boots, whose numbers are far apart, and deletes all when all are older", () => {
    const items = [];
    for (const boot of [1, 2, 3])
      for (let n = 0; n < 5; n++)
        items.push(
          record("routine", rxRecord(seqOf(boot, n), 3, WALL_AT_START_MS + boot * 100 + n)),
        );
    store.writer.stage(items);
    store.writer.flush("due")._unsafeUnwrap();
    const prune = (beforeMs: number) => {
      store.writer.stage([
        write("routine", { table: "rx_routine", op: "prune", beforeMs, limit: 100 }),
        record("routine", hubEventRecord(seqOf(9, beforeMs), WALL_AT_START_MS + 1000, "info")),
      ]);
      store.writer.flush("due")._unsafeUnwrap();
      return store.db
        .query<{ seq: number }, []>("SELECT seq FROM rx_routine ORDER BY seq")
        .all()
        .map((r) => [Math.floor(r.seq / 2 ** 32), r.seq % 2 ** 32]);
    };
    expect(prune(WALL_AT_START_MS + 203)).toEqual([
      [2, 3],
      [2, 4],
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 4],
    ]);
    expect(prune(WALL_AT_START_MS + 999)).toEqual([]);
  });
});

describe("migrations (section 6)", () => {
  /** A copy of the migrations with one more, that changes `devices`. */
  /** The code's own migrations: a test's added one is the next after them. */
  const CODE_MIGRATIONS = (
    JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
      entries: unknown[];
    }
  ).entries.length;

  function withMigration(sql: string): string {
    const folder = join(dir.path, "migrations");
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const last = journal.entries.at(-1);
    const idx = (last?.idx ?? -1) + 1;
    journal.entries.push({
      version: last?.version ?? "6",
      breakpoints: true,
      idx,
      when: (last?.when ?? 0) + 1000,
      tag: `${String(idx).padStart(4, "0")}_test`,
    });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(folder, `${String(idx).padStart(4, "0")}_test.sql`), sql);
    return folder;
  }

  function fillEveryTable(): void {
    const tables: readonly StateTable[] = [
      "devices",
      "sensor_config",
      "countdowns",
      "send_counters",
    ];
    store.writer.stage([
      write("now", { table: tables[0] as "devices", op: "upsert", row: deviceRow(3) }),
      write("now", { table: "sensor_config", op: "upsert", row: sensorConfigRow(3) }),
      write("now", { table: "countdowns", op: "upsert", row: countdownRow(3, seq(1)) }),
      write("now", sendCounterOp(deviceId(3), 1024)),
      record("now", rxRecord(seqOf(1, 0), 3, WALL_AT_START_MS, "event")),
    ]);
    store.writer.flushIfDue(clock.mono)._unsafeUnwrap();
  }

  test("every migration of the journal applies to a database of the previous schema holding rows", () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
      entries: unknown[];
    };
    for (let n = 0; n < journal.entries.length; n++) {
      // The schema before migration n, with a row in every table it has.
      const before = tempDir(`migration-${n}`);
      const folder = join(before.path, "migrations");
      cpSync(MIGRATIONS, folder, { recursive: true });
      writeFileSync(
        join(folder, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, n) }),
      );
      const db = new Database(join(before.path, DATABASE_FILE), { create: true });
      db.run("PRAGMA page_size = 4096");
      if (n > 0) migrate(drizzle(db), { migrationsFolder: folder });
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'",
        )
        .all()
        .map((t) => t.name);
      for (const table of tables) {
        const columns = db
          .query<{ name: string; type: string }, []>(`PRAGMA table_info("${table}")`)
          .all();
        // SQLite reports the declared types in capitals.
        const values = columns.map((c) =>
          c.type.toLowerCase() === "blob"
            ? "x'00'"
            : c.type.toLowerCase() === "text"
              ? "'clean'"
              : "1",
        );
        db.run(`INSERT INTO "${table}" VALUES (${values.join(", ")})`);
      }
      db.close();
      const opened = openTestStore(before.path, clock);
      expect(opened.migrations.ran).toEqual(
        Array.from({ length: journal.entries.length - n }, (_, k) => n + k),
      );
      for (const table of tables) {
        expect([table, opened.db.query(`SELECT count(*) AS n FROM "${table}"`).get()]).toEqual([
          table,
          { n: 1 },
        ]);
      }
      opened.db.close();
      before.remove();
    }
  });

  test("one that changes a table is applied to a database holding rows, after a copy", () => {
    fillEveryTable();
    store.db.close();
    const folder = withMigration("ALTER TABLE `devices` ADD `note` text;");
    store = openTestStore(dir.path, clock, { migrations: folder });
    expect(store.migrations.ran).toEqual([CODE_MIGRATIONS]);
    expect(store.migrations.backup).toBe(
      backupPath(join(dir.path, DATABASE_FILE), CODE_MIGRATIONS),
    );
    expect(store.snapshot.devices).toEqual([deviceRow(3)]);
    expect(store.db.query("SELECT note FROM devices").all()).toEqual([{ note: null }]);
    const copy = new Database(store.migrations.backup ?? "", { readonly: true });
    expect(copy.query("SELECT count(*) AS n FROM devices").get()).toEqual({ n: 1 });
    expect(copy.query("SELECT count(*) AS n FROM rx_event").get()).toEqual({ n: 1 });
    copy.close();
  });

  test("only the newest copy is kept: making one deletes the older ones (section 6)", () => {
    const db = join(dir.path, DATABASE_FILE);
    writeFileSync(`${db}.before-0`, "an older copy");
    writeFileSync(`${db}.before-7`, "another");
    store.db.close();
    const folder = withMigration("ALTER TABLE `devices` ADD `note` text;");
    store = openTestStore(dir.path, clock, { migrations: folder });
    expect(store.migrations.backup).toBe(backupPath(db, CODE_MIGRATIONS));
    expect(readdirSync(dir.path).filter((name) => name.includes(".before-"))).toEqual([
      `${DATABASE_FILE}.before-${CODE_MIGRATIONS}`,
    ]);
  });

  test("one that only adds a table is applied without a copy", () => {
    store.db.close();
    const folder = withMigration("CREATE TABLE `extra` (`x` integer);");
    store = openTestStore(dir.path, clock, { migrations: folder });
    expect(store.migrations.ran).toEqual([CODE_MIGRATIONS]);
    expect(store.migrations.backup).toBeUndefined();
  });

  test("a database newer than the code is refused, and fatal.log says so", () => {
    store.db.run(
      `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('newer', 99999999999999)`,
    );
    store.db.close();
    const result = openStore({
      dataDir: dir.path,
      migrationsFolder: MIGRATIONS,
      clock,
      rules: DEFAULT_RULES,
      platform: process.platform,
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "storage",
      detail: { code: "newerThanCode" },
    });
    expect(readFileSync(fatalLogPath(dir.path), "utf8")).toContain('"kind":"refused"');
    store = openTestStore(join(dir.path, "fresh"), clock);
  });
});

describe("how the last run ended (section 10, HB34)", () => {
  const previous = (cleanStopMs: number | null): BootRow => ({
    id: bootId(4),
    startedMs: 0,
    startedTrusted: true,
    previousExit: "clean",
    cause: null,
    cleanStopMs,
    trustedAtMono: null,
    clockStepMs: null,
  });
  const entry = (kind: "uncaught" | "commitFailed", boot: number) => ({
    kind,
    boot,
    atMs: 1,
    mono: 1,
    origin: "x",
    message: `${kind} in ${boot}`,
  });

  test("clean with the clean-stop mark; crash with an uncaught error of that boot; else unknown", () => {
    expect(bootInfo(undefined, undefined)).toEqual({
      id: bootId(1),
      previousExit: "clean",
      cause: undefined,
    });
    expect(bootInfo(previous(5), entry("uncaught", 4))).toEqual({
      id: bootId(5),
      previousExit: "clean",
      cause: undefined,
    });
    expect(bootInfo(previous(null), entry("uncaught", 4))).toEqual({
      id: bootId(5),
      previousExit: "crash",
      cause: "uncaught in 4",
    });
    expect(bootInfo(previous(null), entry("uncaught", 3))).toEqual({
      id: bootId(5),
      previousExit: "unknown",
      cause: undefined,
    });
    expect(bootInfo(previous(null), undefined).previousExit).toBe("unknown");
  });

  test("a failed commit in fatal.log is not a crash", () => {
    appendFatal(dir.path, entry("uncaught", 4))._unsafeUnwrap();
    appendFatal(dir.path, entry("commitFailed", 5))._unsafeUnwrap();
    writeFileSync(
      fatalLogPath(dir.path),
      readFileSync(fatalLogPath(dir.path), "utf8") + "not json\n",
    );
    expect(lastUncaught(dir.path)._unsafeUnwrap()?.boot).toBe(4);
  });

  test("a clean stop, a crash and a power cut, each seen by the next start", () => {
    // Clean: the stop's commit writes the mark.
    const row = (id: number): BootRow => ({
      id: bootId(id),
      startedMs: clock.wall,
      startedTrusted: true,
      previousExit: "clean",
      cause: null,
      cleanStopMs: null,
      trustedAtMono: null,
      clockStepMs: null,
    });
    store.writer.stage([write("now", { table: "boots", op: "upsert", row: row(store.boot.id) })]);
    store.writer.flushIfDue(clock.mono)._unsafeUnwrap();
    store.writer.stop()._unsafeUnwrap();
    expect(reopen().boot).toEqual({ id: bootId(2), previousExit: "clean", cause: undefined });
    // Crash: the top-level handler writes fatal.log and the database.
    store.writer.stage([write("now", { table: "boots", op: "upsert", row: row(2) })]);
    store.writer.flushIfDue(clock.mono)._unsafeUnwrap();
    const failures = recordUncaught(
      {
        dataDir: dir.path,
        boot: bootId(2),
        now: () => clock.now(),
        db: store.db,
        statements: store.statements,
        nextSeq: () => seqOf(2, 17),
      },
      "shell/loop",
      new Error("boom"),
    );
    expect(failures).toEqual([]);
    expect(
      store.db.query("SELECT level, code, message FROM hub_events WHERE seq = ?").get(seqOf(2, 17)),
    ).toEqual({ level: "critical", code: "uncaught", message: "boom" });
    expect(reopen().boot).toEqual({ id: bootId(3), previousExit: "crash", cause: "boom" });
    // Power cut: neither.
    store.writer.stage([write("now", { table: "boots", op: "upsert", row: row(3) })]);
    store.writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(reopen().boot).toEqual({ id: bootId(4), previousExit: "unknown", cause: undefined });
  });

  test("the handler still writes fatal.log when the database cannot take it", () => {
    const failures = recordUncaught(
      {
        dataDir: dir.path,
        boot: undefined,
        now: () => clock.now(),
        db: undefined,
        statements: undefined,
        nextSeq: () => undefined,
      },
      "shell/main",
      "not an error",
    );
    expect(failures.map((f) => f.message)).toEqual(["no record sequence for the error"]);
    expect(existsSync(fatalLogPath(dir.path))).toBe(true);
    expect(lastUncaught(dir.path)._unsafeUnwrap()).toMatchObject({
      boot: null,
      message: "not an error",
    });
  });
});

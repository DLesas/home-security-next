/**
 * Migration 2 (m2-design.md section 4): applied to an M1a database holding rows, it keeps every
 * row, leaves `site` as M1a built it, copies the database first (it changes `hub_keys`), makes
 * the two fixed modes (D90), inserts `mode_state` from the sensors' states, and the other single
 * rows with their defaults, each with its one writer (section 4, "One writer per row").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { AWAY_MODE, DISARMED_MODE } from "../../../src/core/model/ids.ts";
import { BACKUP_STATE_DEFAULTS, ModeFixed } from "../../../src/core/model/rows.ts";
import { DATABASE_FILE } from "../../../src/shell/storage/store.ts";
import { MIGRATIONS, openTestStore, tempDir, TestClock } from "./fixtures.ts";

const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
const M2 = journal.entries.findIndex((e) => e.tag === "0002_m2");

const removers: (() => void)[] = [];
afterEach(() => {
  for (const remove of removers.splice(0)) remove();
});

/** An M1a database (migrations 0 and 1) with a site, a hub key row and sensors armed as given. */
function m1aDatabase(arms: readonly number[], removedArmed = false): string {
  const dir = tempDir("m1a");
  removers.push(() => {
    dir.remove();
  });
  const folder = join(dir.path, "migrations");
  cpSync(MIGRATIONS, folder, { recursive: true });
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, M2) }),
  );
  const db = new Database(join(dir.path, DATABASE_FILE), { create: true });
  db.run("PRAGMA page_size = 4096");
  migrate(drizzle(db), { migrationsFolder: folder });
  db.run(
    `INSERT INTO site VALUES (1, 32, 0, 0, NULL, NULL, NULL, NULL, 0, NULL, NULL, x'', x'', 30, 300, 22, 22, 30, 365)`,
  );
  db.run(`INSERT INTO hub_keys VALUES (x'01', x'02', x'03')`);
  const sensors = [...arms, ...(removedArmed ? [1] : [])];
  sensors.forEach((arm, i) => {
    const id = 10 + i;
    const state = removedArmed && i === sensors.length - 1 ? 4 : 2;
    db.run(
      `INSERT INTO devices VALUES (${id}, ${0x5e000000 + id}, 1, 'door-${id}', x'00', 65536, 0, ${state}, 1, NULL)`,
    );
    db.run(
      `INSERT INTO sensor_config VALUES (${id}, ${arm}, NULL, NULL, 30, 12, 5, 5, 5, 0, 0, 0, 255, 255, 0, 0, 1, x'')`,
    );
  });
  db.close(true);
  return dir.path;
}

describe("migration 2 on an M1a database (section 4)", () => {
  test("keeps every row, copies the database first, and makes Away and Disarmed (D90)", () => {
    const folder = m1aDatabase([0, 1]);
    const store = openTestStore(folder, new TestClock());
    expect(store.migrations.ran).toEqual([M2]);
    expect(store.migrations.backup).toBeDefined();
    expect(store.snapshot.devices).toHaveLength(2);
    expect(store.snapshot.sensorConfig.map((c) => c.arm)).toEqual([0, 1]);
    expect(store.snapshot.m2.modes).toEqual([
      { id: AWAY_MODE, name: "Away", fixed: ModeFixed.Away, revision: 0 },
      { id: DISARMED_MODE, name: "Disarmed", fixed: ModeFixed.Disarmed, revision: 0 },
    ]);
    // `site` is M1a's, untouched; the new single rows hold their defaults, and the app keys and
    // backup key are not made yet.
    expect(store.snapshot.site?.retentionEventDays).toBe(365);
    const siteColumns = store.db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('site')")
      .all();
    expect(siteColumns).toHaveLength(19);
    const keyColumns = store.db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('hub_keys')")
      .all()
      .map((c) => c.name);
    expect(keyColumns).not.toContain("backup_key");
    expect(store.snapshot.m2.appKeys).toBeUndefined();
    expect(store.snapshot.m2.backupKey).toBeUndefined();
    expect(store.snapshot.m2.peopleSettings).toEqual({ userManagement: false });
    expect(store.snapshot.m2.scheduleState).toEqual({ timeZone: null });
    expect(store.snapshot.m2.backupState).toEqual(BACKUP_STATE_DEFAULTS);
    store.db.close(true);
  });

  test.each([
    ["no sensor armed: Disarmed", [0, 0], DISARMED_MODE, false],
    ["every sensor armed, a waiting one included: Away", [1, 2, 3], AWAY_MODE, false],
    ["some armed: no mode, and changed", [1, 0], null, true],
    ["no sensor at all: Disarmed", [], DISARMED_MODE, false],
  ] as const)("%s", (_, arms, mode, modified) => {
    const store = openTestStore(m1aDatabase(arms), new TestClock());
    expect(store.snapshot.m2.modeState).toEqual({ currentModeId: mode, modeModified: modified });
    store.db.close(true);
  });

  test("a removed sensor's arming does not count", () => {
    const store = openTestStore(m1aDatabase([0, 0], true), new TestClock());
    expect(store.snapshot.m2.modeState?.currentModeId).toBe(DISARMED_MODE);
    store.db.close(true);
  });

  test("a new installation's single rows: Disarmed, user management off, no zone, nothing due", () => {
    const dir = tempDir("fresh");
    removers.push(() => {
      dir.remove();
    });
    const store = openTestStore(dir.path, new TestClock());
    expect(store.snapshot.m2.modeState).toEqual({
      currentModeId: DISARMED_MODE,
      modeModified: false,
    });
    expect(store.snapshot.m2.backupState).toEqual(BACKUP_STATE_DEFAULTS);
    store.db.close(true);
  });
});

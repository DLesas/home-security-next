/**
 * Migration 3, the joint step 0's (docs/m3-m4-plan.md): applied to an M2 database holding a
 * device and its key, it keeps the key with no key change pending (`next_key` null, `rekey` 0),
 * makes `relay_settings`' single row (the deployment's default relay), and its keys hold: one
 * image id among images not removed, at most one rollout not ended.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { DATABASE_FILE } from "../../../src/shell/storage/store.ts";
import { MIGRATIONS, openTestStore, tempDir, TestClock } from "./fixtures.ts";

const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
const M3 = journal.entries.findIndex((e) => e.tag === "0003_m3m4");

const removers: (() => void)[] = [];
afterEach(() => {
  for (const remove of removers.splice(0)) remove();
});

/** An M2 database (migrations 0 to 2) with one sensor and its key. */
function m2Database(): string {
  const dir = tempDir("m2");
  removers.push(() => {
    dir.remove();
  });
  const folder = join(dir.path, "migrations");
  cpSync(MIGRATIONS, folder, { recursive: true });
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, M3) }),
  );
  const db = new Database(join(dir.path, DATABASE_FILE), { create: true });
  db.run("PRAGMA page_size = 4096");
  migrate(drizzle(db), { migrationsFolder: folder });
  db.run(
    `INSERT INTO devices VALUES (10, ${String(0x5e00000a)}, 1, 'door-10', x'00', 65536, 0, 2, 1, NULL)`,
  );
  db.run(`INSERT INTO device_keys VALUES (10, x'000102030405060708090a0b0c0d0e0f')`);
  db.close();
  return dir.path;
}

function image(id: number, imageId: string, removedMs: number | null): string {
  return (
    `INSERT INTO firmware_images VALUES (${id}, x'${imageId}', x'${"00".repeat(32)}', 66304, 0, 14, ` +
    `1000, x'${"00".repeat(128)}', NULL, 'f.bin', 1, 'anna', ${removedMs ?? "NULL"})`
  );
}

function rollout(id: number, endedMs: number | null): string {
  return (
    `INSERT INTO rollouts VALUES (${id}, 1, x'', x'', 0, 'anna', 1, NULL, NULL, NULL, ` +
    `${endedMs ?? "NULL"})`
  );
}

describe("migration 3 on an M2 database (the joint step 0)", () => {
  test("is the journal's fourth, and runs alone on an M2 database", () => {
    expect(M3).toBe(3);
    const store = openTestStore(m2Database(), new TestClock());
    expect(store.migrations.ran).toEqual([M3]);
    store.db.close();
  });

  test("keeps the device key, with no key change pending", () => {
    const store = openTestStore(m2Database(), new TestClock());
    expect(
      store.db.query("SELECT device_id, hex(key) AS key, next_key, rekey FROM device_keys").all(),
    ).toEqual([
      { device_id: 10, key: "000102030405060708090A0B0C0D0E0F", next_key: null, rekey: 0 },
    ]);
    store.db.close();
  });

  test("makes relay_settings' one row: the default relay, revision 0", () => {
    const store = openTestStore(m2Database(), new TestClock());
    expect(store.db.query("SELECT url, revision FROM relay_settings").all()).toEqual([
      { url: null, revision: 0 },
    ]);
    store.db.close();
  });

  test("the new tables start empty", () => {
    const store = openTestStore(m2Database(), new TestClock());
    for (const table of [
      "firmware_images",
      "rollouts",
      "device_updates",
      "push_targets",
      "push_keys",
      "push_outbox",
    ])
      expect([table, store.db.query(`SELECT count(*) AS n FROM ${table}`).get()]).toEqual([
        table,
        { n: 0 },
      ]);
    store.db.close();
  });

  test("a device update defaults to a different-version rollout", () => {
    const store = openTestStore(m2Database(), new TestClock());
    const db = store.db;
    db.run(`INSERT INTO device_updates (device_id, state, method, held, bytes, attempts, since_ms)
      VALUES (1, 0, 0, 0, 0, 2, 0)`);
    expect(db.query("SELECT same_version, attempts FROM device_updates").get()).toEqual({
      same_version: 0,
      attempts: 2,
    });
    store.db.close();
  });

  test("an outbox row keeps whether a sensor was armed and the decision facts, or none", () => {
    const store = openTestStore(m2Database(), new TestClock());
    const db = store.db;
    db.run(`INSERT INTO push_outbox VALUES (1, 4294967297, 7, 1000, 0, 1, '{"mode":"Away"}')`);
    db.run(`INSERT INTO push_outbox VALUES (2, 4294967298, 7, 1000, 0, 0, NULL)`);
    // Left out, `armed` is 0 and `facts` null; `armed` is never null.
    db.run(`INSERT INTO push_outbox (id, notification_seq, client_id, created_ms, attempts)
      VALUES (3, 4294967299, 7, 1000, 0)`);
    expect(() =>
      db.run(`INSERT INTO push_outbox VALUES (4, 4294967300, 7, 1000, 0, NULL, NULL)`),
    ).toThrow(/NOT NULL/u);
    expect(db.query("SELECT id, armed, facts FROM push_outbox ORDER BY id").all()).toEqual([
      { id: 1, armed: 1, facts: '{"mode":"Away"}' },
      { id: 2, armed: 0, facts: null },
      { id: 3, armed: 0, facts: null },
    ]);
    db.close();
  });

  test("an image id is unique among images not removed", () => {
    const store = openTestStore(m2Database(), new TestClock());
    const db = store.db;
    db.run(image(1, "0102030405060708", 5));
    db.run(image(2, "0102030405060708", null));
    expect(() => db.run(image(3, "0102030405060708", null))).toThrow(/UNIQUE/u);
    db.run(image(4, "0102030405060709", null));
    db.close();
  });

  test("at most one rollout is not ended", () => {
    const store = openTestStore(m2Database(), new TestClock());
    const db = store.db;
    db.run(rollout(1, 10));
    db.run(rollout(2, 20));
    db.run(rollout(3, null));
    expect(() => db.run(rollout(4, null))).toThrow(/UNIQUE/u);
    db.run(rollout(5, 30));
    db.close();
  });

  test("a key row needs rekey; the key change's columns take a key and the required mark", () => {
    const store = openTestStore(m2Database(), new TestClock());
    const db = store.db;
    expect(() => db.run(`INSERT INTO device_keys VALUES (11, x'00', NULL, NULL)`)).toThrow(
      /NOT NULL/u,
    );
    db.run(
      `UPDATE device_keys SET next_key = x'${"11".repeat(16)}', rekey = 1 WHERE device_id = 10`,
    );
    expect(db.query("SELECT hex(next_key) AS next, rekey FROM device_keys").get()).toEqual({
      next: "11".repeat(16),
      rekey: 1,
    });
    db.close();
  });
});

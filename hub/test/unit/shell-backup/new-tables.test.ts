/**
 * Migration 3's tables in backups (docs/m3-m4-plan.md; `shell/backup/contents.ts` says why each):
 * `relay_settings` held and restored; `device_keys`' `next_key` and `rekey` held with the row, and
 * the restore's marking as U8 built it; `firmware_images`, `rollouts`, `device_updates`,
 * `push_targets` and `push_outbox` left out, `push_keys` never in any file; a file that holds one of
 * those anyway restored without it; every table of the schema decided; and a backup made before
 * migration 3 restored onto this code's schema.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { backupCodec } from "@hsn/protocol/app";
import { ok } from "neverthrow";
import { connId, jobId } from "../../../src/core/model/ids.ts";
import { Rekey } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  BACKUP_TABLES,
  LEFT_OUT_TABLES,
  MIGRATIONS_TABLE,
  NEVER_TABLES,
} from "../../../src/shell/backup/contents.ts";
import { runToEnd } from "../../../src/shell/backup/jobs.ts";
import { RESTORE_FILE, swapRestored } from "../../../src/shell/backup/restore.ts";
import { DATABASE_FILE } from "../../../src/shell/storage/store.ts";
import { MIGRATIONS, openTestStore, tempDir, TestClock } from "../storage/fixtures.ts";

const KEY = new Uint8Array(32).fill(0x31);
const DEVICE_KEY = new Uint8Array(16).fill(0xd1);
const NEXT_KEY = new Uint8Array(16).fill(0xd2);
const PUSH_KEY = new Uint8Array(32).fill(0x9e);
const APP_PUBLIC = new Uint8Array(32).fill(0x0a);
const RELAY = "wss://relay.example.test";

const folders: { remove(): void }[] = [];
afterAll(() => {
  for (const f of folders) f.remove();
});

let root: string;
let backups: string;
const uploads = new Map<string, string>();

beforeEach(() => {
  const dir = tempDir("new-tables");
  folders.push(dir);
  root = dir.path;
  backups = join(root, "backups");
  mkdirSync(backups);
});

function deps(db: Database, dataDir: string): Parameters<typeof runToEnd>[2] {
  return {
    db,
    dataDir,
    migrationsFolder: MIGRATIONS,
    rules: DEFAULT_RULES,
    uploads: { pathOf: (ref) => uploads.get(`${ref.conn}/${ref.job}`) },
    exports: { send: () => ok(undefined) },
    prefix: undefined,
    switchBlockedBy: () => undefined,
    nowMs: () => Date.UTC(2026, 10, 18, 3),
    salt: () => ok(new Uint8Array(8).fill(9)),
  };
}

/** Rows every hub has: its keys, a person and her phone, a sensor with its key and counter. */
function household(db: Database): void {
  db.run(
    `INSERT INTO hub_keys (signing_private, signing_public, identity, app_static_private, app_static_public) VALUES (?, ?, ?, ?, ?)`,
    [new Uint8Array(8), new Uint8Array(64), new Uint8Array(8), new Uint8Array(32), APP_PUBLIC],
  );
  db.run(`INSERT INTO people (id, name, created_ms, revision) VALUES (1, 'Anna', 1, 1)`);
  db.run(
    `INSERT INTO clients (id, person_id, static_key, kind, name, created_ms, last_seq, backup_key_epoch) VALUES (8, 1, ?, 2, 'phone', 1, 41, 1)`,
    [new Uint8Array(32).fill(8)],
  );
  db.run(
    `INSERT INTO devices (id, address, role, name, chip_id, firmware, development, state, added_ms) VALUES (3, 4660, 1, 'front', ?, 65536, 0, 1, 1)`,
    [new Uint8Array(8)],
  );
  db.run(`INSERT INTO device_keys (device_id, key) VALUES (3, ?)`, [DEVICE_KEY]);
  db.run(`INSERT INTO send_counters (device_id, resume_point) VALUES (3, 2048)`);
  db.run(
    `INSERT INTO backup_state (overdue_raised, last_result, last_change_ms) VALUES (0, 0, 1000)`,
  );
}

/** Migration 3's rows on this code's hub: every new table holding something. */
function m3Rows(db: Database): void {
  db.run(`UPDATE relay_settings SET url = ?, revision = 4`, [RELAY]);
  db.run(`UPDATE device_keys SET next_key = ?, rekey = ? WHERE device_id = 3`, [
    NEXT_KEY,
    Rekey.Required,
  ]);
  db.run(
    `INSERT INTO push_targets VALUES (8, x'0102030405060708', 1, 0, 'fcm-token-of-the-phone', 1, NULL)`,
  );
  db.run(`INSERT INTO push_keys VALUES (8, ?)`, [PUSH_KEY]);
  db.run(`INSERT INTO push_outbox VALUES (1, 4294967297, 8, 1000, 0, 1, NULL)`);
  db.run(
    `INSERT INTO firmware_images VALUES (1, x'${"11".repeat(16)}', x'${"00".repeat(32)}', 66304, 0, 14, 1000, x'${"00".repeat(128)}', NULL, 'f.bin', 1, 'anna', NULL)`,
  );
  db.run(`INSERT INTO rollouts VALUES (1, 1, x'', x'', 0, 'anna', 1, NULL, NULL, NULL, NULL)`);
  db.run(
    `INSERT INTO device_updates (device_id, rollout_id, same_version, state, method, held, bytes, attempts, since_ms) VALUES (3, 1, 1, 5, 0, 0, 0, 0, 1)`,
  );
}

function tablesOf(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((r) => r.name);
}

function count(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()?.n ?? -1;
}

/** A backup of `db` into the folder; the file's bytes. */
function backupOf(db: Database, dataDir: string): Uint8Array {
  const done = runToEnd(
    jobId(1),
    { kind: "backup", folder: backups, keep: 20, key: KEY, epoch: 1 },
    // On the thread: this test is of what a backup holds; the worker's is `write-job.test.ts`.
    { ...deps(db, dataDir), onThread: true },
  );
  expect(done).toMatchObject({ kind: "ready", outcome: { kind: "backupWritten" } });
  const name = readdirSync(backups).find((n) => n.endsWith(".hsnb")) ?? "";
  return new Uint8Array(readFileSync(join(backups, name)));
}

function opened(bytes: Uint8Array): Database {
  const open = backupCodec.open(KEY, bytes);
  expect(open.ok).toBe(true);
  return Database.deserialize(open.ok ? open.value.database : new Uint8Array());
}

/** `bytes` restored on a new hub with no devices; the prepared `hub.db.restore`, and its folder. */
function restored(bytes: Uint8Array, job = 1): { readonly db: Database; readonly data: string } {
  const upload = join(root, `upload-${job}.hsnb`);
  writeFileSync(upload, bytes);
  uploads.set(`9/${job}`, upload);
  const data = join(root, `new-${job}`);
  const store = openTestStore(data, new TestClock());
  const done = runToEnd(
    jobId(2),
    { kind: "applyRestore", upload: { conn: connId(9), job }, key: KEY },
    deps(store.db, data),
  );
  expect(done).toEqual({ kind: "ready", outcome: { kind: "restoreReady" } });
  store.writer.stop().match(
    () => undefined,
    () => undefined,
  );
  store.db.close(true);
  return { db: new Database(join(data, RESTORE_FILE), { readonly: true }), data };
}

describe("every table of the schema is decided", () => {
  test("each in exactly one of the three lists, and every list names only tables that exist", () => {
    const dir = tempDir("schema");
    folders.push(dir);
    const store = openTestStore(dir.path, new TestClock());
    const all = tablesOf(store.db).toSorted();
    store.db.close(true);
    const lists: string[] = [...BACKUP_TABLES, ...NEVER_TABLES, ...LEFT_OUT_TABLES];
    expect(lists.toSorted()).toEqual(all);
    expect(new Set(lists).size).toBe(lists.length);
  });

  test("migration 3's own: relay_settings held; push_keys never; the rest left out", () => {
    const held: readonly string[] = BACKUP_TABLES;
    const never: readonly string[] = NEVER_TABLES;
    const leftOut: readonly string[] = LEFT_OUT_TABLES;
    expect(held).toContain("relay_settings");
    expect(never).toContain("push_keys");
    for (const table of [
      "firmware_images",
      "rollouts",
      "device_updates",
      "push_targets",
      "push_outbox",
    ])
      expect(leftOut).toContain(table);
  });
});

describe("a backup on this code's schema", () => {
  function hub(): { readonly db: Database; readonly data: string } {
    const data = join(root, "hub");
    const store = openTestStore(data, new TestClock());
    household(store.db);
    m3Rows(store.db);
    return { db: store.db, data };
  }

  test("holds relay_settings and device_keys' next_key and rekey; none of the left-out tables; no push key anywhere", () => {
    const { db, data } = hub();
    const bytes = backupOf(db, data);
    const file = opened(bytes);
    expect(file.query("SELECT url, revision FROM relay_settings").all()).toEqual([
      { url: RELAY, revision: 4 },
    ]);
    expect(
      file
        .query<{ next_key: Uint8Array; rekey: number }, []>(
          "SELECT next_key, rekey FROM device_keys WHERE device_id = 3",
        )
        .get(),
    ).toEqual({ next_key: NEXT_KEY, rekey: Rekey.Required } as never);
    for (const table of [...NEVER_TABLES, ...LEFT_OUT_TABLES])
      expect([table, tablesOf(file).includes(table)]).toEqual([table, false]);
    expect(Buffer.from(file.serialize()).includes(Buffer.from(PUSH_KEY))).toBe(false);
    expect(Buffer.from(file.serialize()).includes(Buffer.from("fcm-token-of-the-phone"))).toBe(
      false,
    );
    file.close();
    db.close(true);
  });

  test("restored: the relay setting kept; no push target, key or outbox row, no image, rollout or device update; every key marked for change, the pending one BothHeld (U8)", () => {
    const { db, data } = hub();
    const { db: out } = restored(backupOf(db, data));
    db.close(true);
    expect(out.query("SELECT url, revision FROM relay_settings").all()).toEqual([
      { url: RELAY, revision: 4 },
    ]);
    for (const table of [
      "push_targets",
      "push_keys",
      "push_outbox",
      "firmware_images",
      "rollouts",
      "device_updates",
    ])
      expect([table, count(out, table)]).toEqual([table, 0]);
    expect(
      out
        .query<{ key: Uint8Array; next_key: Uint8Array; rekey: number }, []>(
          "SELECT key, next_key, rekey FROM device_keys",
        )
        .all(),
    ).toEqual([{ key: DEVICE_KEY, next_key: NEXT_KEY, rekey: Rekey.BothHeld }] as never);
    out.close(true);
  });

  test("the default relay (url null) restored as the default", () => {
    const data = join(root, "hub-default");
    const store = openTestStore(data, new TestClock());
    household(store.db);
    const { db: out } = restored(backupOf(store.db, data));
    store.db.close(true);
    expect(out.query("SELECT url, revision FROM relay_settings").all()).toEqual([
      { url: null, revision: 0 },
    ]);
    out.close(true);
  });

  test("a file holding a push key, a target, an outbox row and an image anyway: restored without them", () => {
    const { db, data } = hub();
    const bytes = backupOf(db, data);
    // The file's database with the hub's own rows of those tables added, sealed again with its header.
    const file = opened(bytes);
    for (const table of ["push_keys", "push_targets", "push_outbox", "firmware_images"]) {
      const sql = db
        .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
        .get(table)?.sql;
      file.run(sql ?? "");
      const rows = db.query(`SELECT * FROM "${table}"`).values();
      for (const row of rows)
        file.run(
          `INSERT INTO "${table}" VALUES (${row.map(() => "?").join(", ")})`,
          row as never[],
        );
    }
    const header = backupCodec.readHeader(bytes);
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    const sealed = backupCodec.seal(KEY, header.value, file.serialize());
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    file.close();
    expect(Buffer.from(opened(sealed.value).serialize()).includes(Buffer.from(PUSH_KEY))).toBe(
      true,
    );
    const { db: out } = restored(sealed.value, 2);
    db.close(true);
    for (const table of ["push_keys", "push_targets", "push_outbox", "firmware_images"])
      expect([table, count(out, table)]).toEqual([table, 0]);
    expect(count(out, "relay_settings")).toBe(1);
    out.close(true);
  });
});

describe("a backup made before migration 3 (an M2 hub's)", () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const M3 = journal.entries.findIndex((e) => e.tag === "0003_m3m4");

  /** An M2 hub's database (migrations 0 to 2) with the household. */
  function m2Hub(): { readonly db: Database; readonly data: string } {
    const data = join(root, "m2");
    mkdirSync(data);
    const folder = join(root, "m2-migrations");
    cpSync(MIGRATIONS, folder, { recursive: true });
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, M3) }),
    );
    const db = new Database(join(data, DATABASE_FILE), { create: true, strict: true });
    db.run("PRAGMA page_size = 4096");
    migrate(drizzle(db), { migrationsFolder: folder });
    household(db);
    return { db, data };
  }

  test("its file holds M2's tables at M2's schema: no relay_settings, device_keys without the new columns", () => {
    expect(M3).toBe(3);
    const { db, data } = m2Hub();
    const bytes = backupOf(db, data);
    db.close(true);
    const header = backupCodec.readHeader(bytes);
    expect(header.ok && header.value.schema).toBe(M3);
    const file = opened(bytes);
    expect(tablesOf(file)).not.toContain("relay_settings");
    expect(
      file
        .query<{ name: string }, []>(`PRAGMA table_info("device_keys")`)
        .all()
        .map((c) => c.name),
    ).toEqual(["device_id", "key"]);
    expect(count(file, MIGRATIONS_TABLE)).toBe(M3);
    file.close();
  });

  test("restored onto this code's schema: migrated, the default relay, empty new tables, every key marked Required; it opens and boots", () => {
    const { db, data } = m2Hub();
    const bytes = backupOf(db, data);
    db.close(true);
    const { db: out, data: newData } = restored(bytes);
    expect(count(out, MIGRATIONS_TABLE)).toBe(journal.entries.length);
    expect(out.query("SELECT url, revision FROM relay_settings").all()).toEqual([
      { url: null, revision: 0 },
    ]);
    for (const table of [
      "push_targets",
      "push_keys",
      "push_outbox",
      "firmware_images",
      "rollouts",
      "device_updates",
    ])
      expect([table, count(out, table)]).toEqual([table, 0]);
    expect(
      out
        .query<{ key: Uint8Array; next_key: Uint8Array | null; rekey: number }, []>(
          "SELECT key, next_key, rekey FROM device_keys",
        )
        .all(),
    ).toEqual([{ key: DEVICE_KEY, next_key: null, rekey: Rekey.Required }] as never);
    expect(out.query("SELECT last_seq AS s FROM clients").all()).toEqual([{ s: 41 + 2 ** 32 }]);
    out.close(true);
    // Put in place, it opens with nothing left to migrate, and its snapshot is a restored M3 hub's.
    expect(swapRestored(newData).isOk()).toBe(true);
    const reopened = openTestStore(newData, new TestClock());
    expect(reopened.migrations.ran).toEqual([]);
    expect(reopened.snapshot.m3m4?.relaySettings).toMatchObject({ url: null, revision: 0 });
    expect(reopened.snapshot.m3m4?.rekey).toEqual([3 as never]);
    expect(reopened.snapshot.m3m4?.pushTargets).toEqual([]);
    expect(reopened.snapshot.m2.backupState?.restoredFromMs).not.toBeNull();
    reopened.writer.stop().match(
      () => undefined,
      () => undefined,
    );
    reopened.db.close(true);
  });
});

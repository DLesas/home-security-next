/**
 * Restore's swap cut off at every step (m2-design.md section 10: "the old version or the new one
 * runs, never neither"; `swapSteps`' recovery rule): after each prefix of its steps, a new process
 * opening the data folder as the hub does at its start finds the old database, whole, before the
 * rename, and the restored one after it; never a new, empty one, and never a log or index of the
 * old database beside the restored one. Both as the hub leaves it (its connection still open and
 * idle after the clean stop's commit, its last commit's frames only in the log) and with the
 * connection closed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  BEFORE_RESTORE_FILE,
  RESTORE_FILE,
  retryWaitingRestore,
  swapRestored,
  swapSteps,
} from "../../../src/shell/backup/restore.ts";
import { SystemClock } from "../../../src/shell/clock/system-clock.ts";
import { closeDatabase } from "../../../src/shell/safe/sqlite.ts";
import { type OpenedStore, openStore } from "../../../src/shell/storage/store.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
const STORE = join(import.meta.dir, "..", "..", "..", "src", "shell", "storage", "store.ts");
const RULES = join(import.meta.dir, "..", "..", "..", "src", "core", "model", "rules.ts");
const CLOCK = join(import.meta.dir, "..", "..", "..", "src", "shell", "clock", "system-clock.ts");
const folders: string[] = [];

afterAll(async () => {
  await endProcesses();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

function open(dataDir: string): OpenedStore {
  return openStore({
    dataDir,
    migrationsFolder: MIGRATIONS,
    clock: new SystemClock({ wallTrusted: () => true }),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
}

/** The hub's next start, in a process of its own: the name of person 1, or what went wrong. */
async function nextStart(dataDir: string): Promise<string> {
  const code = `
    const { openStore } = await import(${JSON.stringify(STORE)});
    const { DEFAULT_RULES } = await import(${JSON.stringify(RULES)});
    const { SystemClock } = await import(${JSON.stringify(CLOCK)});
    const opened = openStore({ dataDir: ${JSON.stringify(dataDir)}, migrationsFolder: ${JSON.stringify(MIGRATIONS)},
      clock: new SystemClock({ wallTrusted: () => true }), rules: DEFAULT_RULES, platform: process.platform });
    if (opened.isErr()) { console.log("error: " + opened.error.message); process.exit(0); }
    const row = opened.value.db.query("SELECT name FROM people WHERE id = 1").get();
    console.log(row === null ? "(none: a new, empty database)" : row.name);
  `;
  const child = spawnTracked(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out.trim();
}

/**
 * A data folder as the switch finds it: the old database with person "old" (its last commit only
 * in the log, the connection kept open and idle unless `closed`), and `hub.db.restore` beside it
 * with person "restored", built with no log. Returns the old connection, to close after the test.
 */
function prepared(closed: boolean): { data: string; old: OpenedStore } {
  const root = mkdtempSync(join(tmpdir(), "hsn-swap-"));
  folders.push(root);
  const data = join(root, "data");
  const other = join(root, "other");
  mkdirSync(other);
  const from = open(other);
  from.db.run(`INSERT INTO people VALUES (1, 'restored', 0, NULL, 0)`);
  from.writer.stop()._unsafeUnwrap();
  from.db.run(`VACUUM INTO ?`, [join(root, "restored.db")]);
  closeDatabase(from.db, "test")._unsafeUnwrap();
  // `applyRestore` builds with no journal at all.
  const built = new Database(join(root, "restored.db"));
  built.run("PRAGMA journal_mode = DELETE");
  built.close(true);
  const old = open(data);
  old.db.run("PRAGMA wal_autocheckpoint = 0");
  old.db.run(`INSERT INTO people VALUES (1, 'old', 0, NULL, 0)`);
  old.writer.stop()._unsafeUnwrap();
  if (closed) closeDatabase(old.db, "test")._unsafeUnwrap();
  // Moved in last, as `applyRestore` places it.
  const placed = new Database(join(root, "restored.db"));
  placed.run(`VACUUM INTO ?`, [join(data, RESTORE_FILE)]);
  placed.close(true);
  return { data, old };
}

describe("restore's swap, cut off after each of its steps", () => {
  for (const closed of [false, true]) {
    const how = closed ? "the hub's connection closed" : "the hub's connection still open";
    test(`${how}: the next start finds the old database before the rename, the restored one after`, async () => {
      const steps = swapSteps("/");
      const rename = steps.findIndex((s) => s.name.includes("renamed over hub.db"));
      expect(rename).toBeGreaterThan(0);
      for (let done = 0; done <= steps.length; done++) {
        const { data, old } = prepared(closed);
        for (const step of swapSteps(data).slice(0, done)) expect(step.run().isOk()).toBe(true);
        if (!closed)
          closeDatabase(old.db, "test").match(
            () => undefined,
            () => undefined,
          );
        // After the log is checkpointed, the kept copy is the old database, whole on its own.
        if (done >= 2) {
          // A database in WAL mode needs its index made to open: read-write, on the copy alone.
          const kept = new Database(join(data, BEFORE_RESTORE_FILE));
          expect(kept.query("SELECT name FROM people WHERE id = 1").get()).toEqual({ name: "old" });
          kept.close(true);
        }
        // From the index's and log's removal on, neither is beside hub.db.
        if (done >= 3) {
          expect(existsSync(join(data, "hub.db-wal"))).toBe(false);
          expect(existsSync(join(data, "hub.db-shm"))).toBe(false);
        }
        expect(await nextStart(data)).toBe(done > rename ? "restored" : "old");
      }
    }, 60_000);
  }

  test("the whole swap: the restored database runs, the old one kept as hub.db.before-restore", async () => {
    const { data, old } = prepared(false);
    expect(swapRestored(data).isOk()).toBe(true);
    closeDatabase(old.db, "test").match(
      () => undefined,
      () => undefined,
    );
    expect(existsSync(join(data, RESTORE_FILE))).toBe(false);
    expect(await nextStart(data)).toBe("restored");
  });

  test("a step that fails leaves the old database running, the restored file unused", async () => {
    const { data } = prepared(true);
    // The log's path made a folder: the checkpoint cannot open it.
    rmSync(join(data, "hub.db-wal"), { force: true });
    rmSync(join(data, "hub.db-shm"), { force: true });
    mkdirSync(join(data, "hub.db-wal", "x"), { recursive: true });
    expect(swapRestored(data).isErr()).toBe(true);
    rmSync(join(data, "hub.db-wal"), { recursive: true, force: true });
    expect(existsSync(join(data, RESTORE_FILE))).toBe(true);
    expect(await nextStart(data)).toBe("old");
  });

  test("a reader holding the log: the checkpoint is busy, the swap refused, everything as it was", async () => {
    const { data, old } = prepared(false);
    // Another connection (an administrator's sqlite3, a backup tool) in a read transaction that
    // sees the log's frames: the log cannot be emptied, so nothing may move.
    const reader = new Database(join(data, "hub.db"));
    reader.run("BEGIN");
    expect(reader.query("SELECT name FROM people WHERE id = 1").get()).toEqual({ name: "old" });
    const refused = swapRestored(data);
    expect(refused.isErr() ? refused.error : "").toContain("the log is in use");
    reader.run("COMMIT");
    reader.close(true);
    closeDatabase(old.db, "test").match(
      () => undefined,
      () => undefined,
    );
    expect(existsSync(join(data, BEFORE_RESTORE_FILE))).toBe(false);
    expect(existsSync(join(data, RESTORE_FILE))).toBe(true);
    expect(await nextStart(data)).toBe("old");
  });

  test("no restored database: refused, nothing touched", () => {
    const { data } = prepared(true);
    rmSync(join(data, RESTORE_FILE));
    expect(swapRestored(data)).toMatchObject({ error: "no restored database is ready" });
    expect(existsSync(join(data, BEFORE_RESTORE_FILE))).toBe(false);
  });
});

describe("a swap that did not happen: retried at the next start, before the database opens", () => {
  /** The restore mark in the database now: what `upkeep` records once as `restored`. */
  function mark(path: string): unknown {
    const db = new Database(path);
    const row = db.query("SELECT restored_from_ms AS m FROM backup_state").get();
    db.close(true);
    return row;
  }

  test("nothing waiting: nothing done", () => {
    const { data } = prepared(true);
    rmSync(join(data, RESTORE_FILE));
    expect(retryWaitingRestore(data)).toEqual({ kind: "nothing" });
  });

  test("cut off after any step of the first swap, the next start finishes it", async () => {
    const steps = swapSteps("/");
    const rename = steps.findIndex((s) => s.name.includes("renamed over hub.db"));
    for (let done = 0; done <= rename; done++) {
      const { data, old } = prepared(false);
      for (const step of swapSteps(data).slice(0, done)) expect(step.run().isOk()).toBe(true);
      closeDatabase(old.db, "test").match(
        () => undefined,
        () => undefined,
      );
      // The hub's next start: the retry, then the store.
      expect(retryWaitingRestore(data)).toEqual({ kind: "swapped" });
      expect(await nextStart(data)).toBe("restored");
      expect(retryWaitingRestore(data)).toEqual({ kind: "nothing" });
    }
  }, 60_000);

  test("refused twice, then swapped at the third start; never removed while it waits; its mark carried once", async () => {
    const { data, old } = prepared(true);
    // The restored file carries its restore mark, as `applyRestore` writes it.
    const restoredFile = new Database(join(data, RESTORE_FILE));
    restoredFile.run("DELETE FROM backup_state");
    restoredFile.run(
      "INSERT INTO backup_state (restored_from_ms, overdue_raised, last_result) VALUES (1234, 0, 0)",
    );
    restoredFile.close(true);
    const marked = mark(join(data, RESTORE_FILE));
    closeDatabase(old.db, "test").match(
      () => undefined,
      () => undefined,
    );
    for (let start = 1; start <= 2; start++) {
      // An outside reader holds the log at this start.
      const holder = new Database(join(data, "hub.db"));
      holder.run("PRAGMA wal_autocheckpoint = 0");
      holder.run("UPDATE people SET name = name WHERE id = 1");
      const reader = new Database(join(data, "hub.db"));
      reader.run("BEGIN");
      reader.query("SELECT name FROM people").all();
      const retry = retryWaitingRestore(data);
      expect(retry.kind).toBe("refused");
      expect(retry.kind === "refused" ? retry.reason : "").toContain("the log is in use");
      reader.run("COMMIT");
      reader.close(true);
      holder.close(true);
      expect(existsSync(join(data, RESTORE_FILE))).toBe(true);
      expect(await nextStart(data)).toBe("old");
    }
    expect(retryWaitingRestore(data)).toEqual({ kind: "swapped" });
    expect(await nextStart(data)).toBe("restored");
    // The file is gone once swapped, so no later start swaps or marks again.
    expect(existsSync(join(data, RESTORE_FILE))).toBe(false);
    expect(retryWaitingRestore(data)).toEqual({ kind: "nothing" });
    // The mark arrives with the swapped file, once; upkeep's first start records and clears it.
    expect(mark(join(data, "hub.db"))).toEqual(marked);
  }, 60_000);
});

/**
 * "A swap that did not happen" (m2-design.md section 9): at every start, before the store opens
 * the database, a waiting `hub.db.restore` is put in place. Swapped, the hub runs the restored
 * database and records `restored` once (which it can do only because the store opened the
 * restored file, not the old one: the order is what this checks); refused (an outside reader
 * holds the old database's log), it runs the old database and warns `restore_waiting`.
 */
import { shortTempFolder } from "../../world/temp-folder.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { endProcesses, spawnTracked } from "../../world/processes.ts";

const MAIN = join(import.meta.dir, "..", "..", "..", "src", "shell", "main.ts");
const root = shortTempFolder("hsn-rr-");
afterAll(async () => {
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
});

/** One run of the hub on `dataDir`, stopped cleanly once its control socket is up. */
async function run(dataDir: string): Promise<number> {
  const hub = spawnTracked(
    ["bun", MAIN, "--data", dataDir, "--port", "0", "--no-usb-watch", "--app-ports", "0,0"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const sock = join(dataDir, "control.sock");
  for (let i = 0; i < 200 && !existsSync(sock); i++) await Bun.sleep(25);
  await Bun.sleep(300);
  hub.kill("SIGTERM");
  return hub.exited;
}

/** A first run, then a restored copy of its database waiting beside it, marked as restored. */
async function waitingRestore(name: string): Promise<string> {
  const dataDir = mkdtempSync(join(root, name));
  expect(await run(dataDir)).toBe(0);
  const restored = join(dataDir, "hub.db.restore");
  copyFileSync(join(dataDir, "hub.db"), restored);
  const db = new Database(restored);
  // What only the restored database holds.
  db.run(
    "INSERT INTO people (id, name, created_ms, removed_ms, revision) VALUES (90, 'Restored', 1, NULL, 0)",
  );
  const marked = db.run("UPDATE backup_state SET restored_from_ms = 1700000000000");
  if (marked.changes === 0)
    db.run(
      "INSERT INTO backup_state (overdue_raised, last_result, restored_from_ms) VALUES (0, 0, 1700000000000)",
    );
  db.close(true);
  return dataDir;
}

const count = (dataDir: string, sql: string): number => {
  const db = new Database(join(dataDir, "hub.db"), { readonly: true });
  const n = db.query<{ n: number }, []>(sql).get()?.n ?? -1;
  db.close(true);
  return n;
};

describe("a restore whose swap did not happen is put in place at the next start (section 9)", () => {
  test("waiting: swapped before the database opens; the restored one runs; restored recorded once", async () => {
    const dataDir = await waitingRestore("swap");
    expect(await run(dataDir)).toBe(0);
    expect(existsSync(join(dataDir, "hub.db.restore"))).toBe(false);
    expect(existsSync(join(dataDir, "hub.db.before-restore"))).toBe(true);
    expect(count(dataDir, "SELECT count(*) AS n FROM people WHERE name = 'Restored'")).toBe(1);
    expect(count(dataDir, "SELECT count(*) AS n FROM decisions WHERE kind = 'restored'")).toBe(1);
    // A later start records nothing more.
    expect(await run(dataDir)).toBe(0);
    expect(count(dataDir, "SELECT count(*) AS n FROM decisions WHERE kind = 'restored'")).toBe(1);
  }, 60_000);

  test("refused (an outside reader holds the log): the old database runs, the file waits, restore_waiting", async () => {
    const dataDir = await waitingRestore("refused");
    // An outside reader in the middle of a read: the swap's checkpoint cannot finish.
    const reader = new Database(join(dataDir, "hub.db"), { readonly: true });
    reader.run("BEGIN");
    reader.query("SELECT count(*) FROM site").get();
    // Some log for the reader to hold: a write by another connection after it began.
    const writer = new Database(join(dataDir, "hub.db"));
    writer.run(
      "INSERT INTO people (id, name, created_ms, removed_ms, revision) VALUES (91, 'Old', 1, NULL, 0)",
    );
    writer.close();
    expect(await run(dataDir)).toBe(0);
    reader.run("COMMIT");
    reader.close();
    expect(existsSync(join(dataDir, "hub.db.restore"))).toBe(true);
    expect(count(dataDir, "SELECT count(*) AS n FROM people WHERE name = 'Restored'")).toBe(0);
    expect(count(dataDir, "SELECT count(*) AS n FROM people WHERE name = 'Old'")).toBe(1);
    expect(
      count(dataDir, "SELECT count(*) AS n FROM hub_events WHERE code = 'restore_waiting'"),
    ).toBe(1);
  }, 60_000);
});

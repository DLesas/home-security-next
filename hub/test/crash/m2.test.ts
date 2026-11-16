/**
 * M2's crash points (m2-design.md section 10, "Crash tests"; section 3, "Classes of the new
 * state"), on the whole hub of `test/world/home.ts` with M2's household (`budget/household.ts`):
 * power lost at each point of section 4's table in the turn that commits each M2 change, then a
 * restart from what was on the disk, checking the class section 3 gives the state:
 *
 * - an app request (now): answered only after its commit; retried with the same `seq`, given the
 *   stored reply and done once; replayed with an old `seq`, refused;
 * - a schedule entry's run (now, in the commit of its arming): never twice; an entry due while
 *   the hub was off is recorded as missed, never run late (D116);
 * - a link (now, before `LinkResult`): a token works once across the crash;
 * - a client's removal (now, before `closeClient`): still removed; no session reopens;
 * - a settings change with its backup (the change and the due mark now, the result routine): a
 *   change answered is still due or backed up after the crash, and the backup that follows holds
 *   it; a backup cut off mid-write leaves no file a restore would take for a backup;
 * - staging an update (the staged record now, after the job): a staging cut off leaves no version
 *   folder, and the same release stages after the restart;
 * - restore's switch (the shell's): cut off after any of its steps, the next start opens the old
 *   database or the restored one, never a new empty one.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AppReply } from "@hsn/protocol/app";
import { ok } from "neverthrow";
import { type ConnId, connId, jobId, tokenId } from "../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import { startJob } from "../../src/shell/backup/jobs.ts";
import {
  BEFORE_RESTORE_FILE,
  RESTORE_FILE,
  retryWaitingRestore,
  swapSteps,
} from "../../src/shell/backup/restore.ts";
import { SystemClock } from "../../src/shell/clock/system-clock.ts";
import { openStore } from "../../src/shell/storage/store.ts";
import { TEST_PUBLISHER_KEY } from "../../src/shell/update/publisher-keys.ts";
import { Staging } from "../../src/shell/update/stage.ts";
import { installPaths } from "../../../hub/launcher/src/layout.ts";
import { releaseOf } from "../../packaging/shared/make-release.ts";
import { tempDir } from "../unit/storage/fixtures.ts";
import {
  ANNA_LAPTOP,
  BROWSERS,
  CONSOLE,
  Household,
  seedHousehold,
  homePorts,
} from "../budget/household.ts";
import { CRASH_POINTS, type CrashPoint, Home, HOUR, MINUTE, SECOND } from "../world/home.ts";
import { DAY_TEST_TIMEOUT_MS } from "../world/timeouts.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");
const BEN_BROWSER = BROWSERS[2]?.client ?? CONSOLE;

let home: Home | undefined;
const folders: { remove(): void }[] = [];
afterEach(() => {
  home?.close();
  home = undefined;
});
afterAll(() => {
  for (const f of folders) f.remove();
});

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

/** A small home with the household, its facts given, the clock at 01:00. */
async function household(seed: number): Promise<Household> {
  const ports = homePorts();
  home = await Home.create(
    {
      name: "m2",
      sensors: 2,
      sirens: 1,
      gateways: 1,
      seed,
      calendar: ports.calendar,
      files: ports.files,
    },
    seedHousehold,
  );
  ports.attach(home);
  const h = new Household(home);
  h.facts();
  must(home.advanceTo(HOUR));
  return h;
}

function one<T>(rows: readonly T[]): T | undefined {
  expect(rows).toHaveLength(1);
  return rows[0];
}

const errorCode = (reply: AppReply | undefined): string | undefined =>
  reply?.ok === false ? reply.error.code : undefined;

describe.each(CRASH_POINTS.map((p) => [p]))("power lost at %s", (point: CrashPoint) => {
  test(
    "an app request: answered only after its commit; retried, done once; replayed, refused",
    async () => {
      const h = await household(11);
      const hub = h.home;
      let conn = h.connect(ANNA_LAPTOP);
      // 18 changes first, so the oldest `seq`s are no longer kept (the last 16 replies, section 4).
      for (let i = 0; i < 18; i++)
        h.request(conn, ANNA_LAPTOP, { op: "mode.switch", body: { mode: 1 + (i % 2) } });
      const restarts = hub.restarts;
      hub.crashAt(point, true);
      const seq = h.seqOf(ANNA_LAPTOP) + 1;
      const id = h.request(conn, ANNA_LAPTOP, { op: "mode.switch", body: { mode: 1 } }, seq);
      expect(hub.restarts).toBe(restarts + 1);
      const answered = h.reply(conn, id);
      const stored = (): { last_seq: number } | undefined =>
        one(
          hub.query<{ last_seq: number }>(`SELECT last_seq FROM clients WHERE id = ?`, ANNA_LAPTOP),
        );
      const mode = (): number | null | undefined =>
        one(hub.query<{ m: number | null }>(`SELECT current_mode_id AS m FROM mode_state`))?.m;
      const switches = (): number =>
        hub.query<{ n: number }>(
          `SELECT count(*) AS n FROM decisions WHERE kind = 'mode_switched'`,
        )[0]?.n ?? 0;
      const committed = stored()?.last_seq === seq;
      // "Now": nothing is answered before its commit, so an answer means it is on the disk.
      if (answered !== undefined) expect(committed).toBe(true);
      if (committed) expect(mode()).toBe(1);
      const before = switches();
      // The client did not see the answer, or did: either way it retries with the same `seq`.
      conn = h.connect(ANNA_LAPTOP);
      const retry = h.request(conn, ANNA_LAPTOP, { op: "mode.switch", body: { mode: 1 } }, seq);
      const again = h.reply(conn, retry);
      expect(again?.ok).toBe(true);
      if (committed) {
        expect(again?.repeat).toBe(true);
        expect(switches()).toBe(before);
      } else expect(switches()).toBe(before + 1);
      expect(stored()?.last_seq).toBe(seq);
      expect(mode()).toBe(1);
      // A `seq` no longer kept is refused, whatever it asks.
      const old = h.request(conn, ANNA_LAPTOP, { op: "mode.switch", body: { mode: 2 } }, seq - 17);
      expect(errorCode(h.reply(conn, old))).toBe("seqTooLow");
      expect(mode()).toBe(1);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(
    "a schedule entry's run: never twice, never late",
    async () => {
      const h = await household(12);
      const hub = h.home;
      const conn = h.connect(CONSOLE);
      const made = h.request(conn, CONSOLE, {
        op: "schedule.create",
        body: {
          name: "Noon",
          action: "switchMode",
          target: { mode: 1 },
          at: "12:00",
          days: "everyDay",
          enabled: true,
        },
      });
      expect(h.reply(conn, made)?.ok).toBe(true);
      h.close(conn);
      must(hub.advanceTo(12 * HOUR - SECOND));
      hub.crashAt(point, true);
      must(hub.advanceTo(13 * HOUR));
      expect(hub.restarts).toBe(1);
      const kinds = (kind: string): number =>
        hub.query<{ n: number }>(`SELECT count(*) AS n FROM decisions WHERE kind = ?`, kind)[0]
          ?.n ?? 0;
      const ran = kinds("schedule_ran");
      const missed = kinds("schedule_missed");
      // Run once and committed with its arming, or lost with the turn and then missed, not run late.
      expect(ran).toBeLessThanOrEqual(1);
      expect(ran + missed).toBe(1);
      const mode = hub.query<{ m: number | null }>(`SELECT current_mode_id AS m FROM mode_state`)[0]
        ?.m;
      expect(mode === 1).toBe(ran === 1);
      const row = hub.query<{ last_run_ms: number | null; missed_count: number }>(
        `SELECT last_run_ms, missed_count FROM schedules`,
      )[0];
      expect(row?.last_run_ms !== null).toBe(ran === 1);
      expect(row?.missed_count).toBe(missed);
      // The next day's run is not affected.
      must(hub.advanceTo(36 * HOUR + MINUTE));
      expect(kinds("schedule_ran")).toBe(ran + 1);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(
    "a link: `LinkResult` only after its commit; the token works once across the crash",
    async () => {
      const h = await household(13);
      const hub = h.home;
      const conn = h.connect(ANNA_LAPTOP);
      const asked = h.request(conn, ANNA_LAPTOP, {
        op: "link.create",
        body: { kind: { newPerson: {} }, form: "qr" },
      });
      const reply = h.reply(conn, asked);
      expect(reply?.ok).toBe(true);
      const token = (reply as { body: { token: number } }).body.token;
      const complete = (linkConn: ConnId, key: number): void => {
        hub.input({
          kind: "linkCompleted",
          conn: linkConn,
          token: tokenId(token),
          staticKey: new Uint8Array(32).fill(key),
          listener: "lan",
          // A different person each time, so only the token can refuse a second use.
          link: { name: "a laptop", kind: "web", person: { name: `Eve ${key}` } },
        });
      };
      const linked = (key: number): number =>
        hub.query<{ n: number }>(
          `SELECT count(*) AS n FROM clients WHERE static_key = ?`,
          new Uint8Array(32).fill(key) as unknown as string,
        )[0]?.n ?? 0;
      const resultOn = (linkConn: ConnId): boolean =>
        hub.app.some((e) => e.kind === "appSend" && e.conn === linkConn && !("t" in e.message));
      hub.crashAt(point, true);
      const first = connId(9001);
      complete(first, 0x71);
      expect(hub.restarts).toBe(1);
      if (resultOn(first)) expect(linked(0x71)).toBe(1);
      // The same token again, from another key: it links only if the first did not commit.
      const second = connId(9002);
      complete(second, 0x72);
      expect(linked(0x71) + linked(0x72)).toBe(1);
      expect(resultOn(second)).toBe(linked(0x72) === 1);
      complete(connId(9003), 0x73);
      expect(linked(0x73)).toBe(0);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(
    "a client's removal: still removed after the crash; no session reopens",
    async () => {
      const h = await household(14);
      const hub = h.home;
      const conn = h.connect(ANNA_LAPTOP);
      const bens = h.connect(BEN_BROWSER);
      hub.crashAt(point, true);
      const asked = h.request(conn, ANNA_LAPTOP, {
        op: "client.remove",
        body: { client: BEN_BROWSER, also: [] },
      });
      expect(hub.restarts).toBe(1);
      const removed = (): boolean =>
        hub.query<{ r: number | null }>(
          `SELECT removed_ms AS r FROM clients WHERE id = ?`,
          BEN_BROWSER,
        )[0]?.r !== null;
      const closedBen = hub.app.some(
        (e) =>
          (e.kind === "closeClient" && e.client === BEN_BROWSER) ||
          (e.kind === "closeConn" && e.conn === bens),
      );
      if (h.reply(conn, asked)?.ok === true || closedBen) expect(removed()).toBe(true);
      if (!removed()) {
        const again = h.connect(ANNA_LAPTOP);
        expect(
          h.reply(
            again,
            h.request(again, ANNA_LAPTOP, {
              op: "client.remove",
              body: { client: BEN_BROWSER, also: [] },
            }),
          )?.ok,
        ).toBe(true);
      }
      expect(removed()).toBe(true);
      // A removed client's session is closed, and answered nothing.
      const later = h.connect(BEN_BROWSER);
      const snap = h.request(later, BEN_BROWSER, { op: "snapshot", body: {} });
      expect(h.reply(later, snap)?.ok).not.toBe(true);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(
    "a settings change and its backup: the change and the due mark survive; the backup holds it",
    async () => {
      const h = await household(15);
      const hub = h.home;
      const folder = tempDir("crash-backups");
      folders.push(folder);
      const conn = h.connect(CONSOLE);
      expect(
        h.reply(
          conn,
          h.request(conn, CONSOLE, { op: "backup.settings", body: { folder: folder.path } }),
        )?.ok,
      ).toBe(true);
      must(hub.advanceBy(2 * MINUTE));
      must(hub.advanceBy(2 * MINUTE));
      const files = (): readonly string[] =>
        readdirSync(folder.path).filter((n) => !n.startsWith("."));
      const written = files().length;
      hub.crashAt(point, true);
      const asked = h.request(conn, CONSOLE, {
        op: "person.rename",
        body: { person: 4, name: "Daniel", ifRevision: 0 },
      });
      const answered = h.reply(conn, asked)?.ok === true;
      expect(hub.restarts).toBe(1);
      const renamed =
        hub.query<{ name: string }>(`SELECT name FROM people WHERE id = 4`)[0]?.name === "Daniel";
      if (answered) expect(renamed).toBe(true);
      const state = hub.query<{ due: number | null; change: number | null }>(
        `SELECT due_since_ms AS due, last_change_ms AS change FROM backup_state`,
      )[0];
      // "Now": a change on the disk is either held by a backup already written, or still due.
      if (renamed) expect(state?.due !== null || files().length > written).toBe(true);
      // The restarted hub writes the backup that holds it, and the mark clears (routine).
      for (let i = 0; i < 10; i++) {
        must(hub.advanceBy(MINUTE));
      }
      must(hub.advanceBy(10 * MINUTE));
      expect(hub.store?.writer.flush("due").isOk()).toBe(true);
      if (renamed) {
        expect(files().length).toBeGreaterThan(written);
        expect(
          hub.query<{ due: number | null }>(`SELECT due_since_ms AS due FROM backup_state`)[0]?.due,
        ).toBeNull();
      }
      for (const name of files())
        expect(statSync(join(folder.path, name)).size).toBeGreaterThan(64);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("whole-file work cut off by a power cut (section 9)", () => {
  test("a backup cut off at any piece leaves no file a restore would take for a backup", async () => {
    const h = await household(16);
    const store = h.home.store;
    expect(store).toBeDefined();
    if (store === undefined) return;
    // Enough configuration for several pieces: 2,000 people's rows (the file is built from them).
    store.db.transaction(() => {
      for (let i = 100; i < 2100; i++)
        store.db.run(`INSERT INTO people VALUES (?, ?, 0, NULL, 0)`, [
          i,
          `person ${i} ${"x".repeat(200)}`,
        ]);
    })();
    const deps = {
      db: store.db,
      dataDir: join(store.path, ".."),
      migrationsFolder: MIGRATIONS,
      rules: DEFAULT_RULES,
      uploads: { pathOf: () => undefined },
      exports: { send: () => ok(undefined) },
      prefix: undefined,
      switchBlockedBy: () => undefined,
      nowMs: () => Date.UTC(2026, 10, 14),
      salt: () => ok(new Uint8Array(8).fill(1)),
    };
    const key = new Uint8Array(32).fill(5);
    const work = (folder: string) => ({ kind: "backup" as const, folder, keep: 20, key, epoch: 1 });
    // The file a whole run writes (the same time and salt give the same bytes).
    const whole = tempDir("whole-backup");
    folders.push(whole);
    const full = startJob(jobId(1), work(whole.path), deps);
    if (full.kind !== "pieces") return;
    let pieces = 0;
    while (full.pieces.next() === undefined) pieces++;
    const [reference] = readdirSync(whole.path);
    expect(reference).toBeDefined();
    const referenceBytes = readFileSync(join(whole.path, reference ?? ""));
    let cuts = 0;
    for (let stopAfter = 1; stopAfter <= pieces; stopAfter++) {
      const folder = tempDir("cut-backup");
      folders.push(folder);
      const started = startJob(jobId(stopAfter), work(folder.path), deps);
      if (started.kind !== "pieces") return;
      for (let piece = 0; piece < stopAfter; piece++) started.pieces.next();
      // Power lost here: no abort, the folder as it is. Every file a restore lists is whole.
      cuts++;
      for (const name of readdirSync(folder.path).filter((n) => !n.startsWith("."))) {
        expect(name).toBe(reference ?? "");
        expect(readFileSync(join(folder.path, name)).equals(referenceBytes)).toBe(true);
      }
    }
    // The job really ran in several pieces, so the cuts above were inside it.
    expect(cuts).toBeGreaterThanOrEqual(2);
  });

  test("staging cut off at any piece leaves no version folder; the same release stages after", () => {
    const root = tempDir("cut-stage");
    folders.push(root);
    const source = join(root.path, "source");
    mkdirSync(join(source, "bin"), { recursive: true });
    mkdirSync(join(source, "drizzle"), { recursive: true });
    writeFileSync(join(source, "bin", "hsn-hub"), new Uint8Array(3 * 1024 * 1024).fill(7), {
      mode: 0o755,
    });
    writeFileSync(join(source, "drizzle", "0000.sql"), "CREATE TABLE x (a);");
    const upload = join(root.path, "upload.hsnr");
    writeFileSync(
      upload,
      releaseOf(source, "9.0.0", "darwin-arm64", new Uint8Array(32).fill(7), 0)._unsafeUnwrap(),
    );
    // The hub's own program tree (section 9, two trees): its state, and staged versions in
    // `staged/`; the running 0.1.0 is the package's, in the other tree.
    const prefix = join(root.path, "program");
    mkdirSync(installPaths(prefix).state, { recursive: true });
    writeFileSync(
      installPaths(prefix).launcherFile,
      JSON.stringify({
        current: "0.1.0",
        previous: null,
        trial: null,
        rolledBack: null,
        failed: [],
      }),
    );
    const staging = (): Staging =>
      new Staging({
        path: upload,
        prefix,
        runningVersion: "0.1.0",
        platform: "darwin-arm64",
        keys: [TEST_PUBLISHER_KEY],
        wanted: () => true,
      });
    // Where staging puts a version (the hub's own tree, `installPaths(...).staged`).
    const staged = join(installPaths(prefix).staged, "9.0.0");
    let cuts = 0;
    for (let stopAfter = 1; ; stopAfter++) {
      const job = staging();
      let outcome;
      for (let piece = 0; piece < stopAfter && outcome === undefined; piece++) outcome = job.next();
      if (outcome !== undefined) {
        expect(outcome.kind).not.toBe("failed");
        expect(existsSync(join(staged, "bin", "hsn-hub"))).toBe(true);
        break;
      }
      // Power lost mid-staging: no version folder a launcher could switch to.
      cuts++;
      expect(existsSync(staged)).toBe(false);
    }
    expect(cuts).toBeGreaterThanOrEqual(3);
  });

  // The swap's steps (`swapSteps`, A8's fix of the FAULT-A8 this test found): a power cut after
  // any of them, then the next start as `main.ts` makes it (`retryWaitingRestore` before the
  // database opens). At every cut point hub.db is a whole database, the old one or the restored
  // one, and the start finishes the swap: never neither.
  test("restore's switch cut off after any of its steps: the old or the restored database, never neither", () => {
    const open = (dataDir: string) =>
      openStore({
        dataDir,
        migrationsFolder: MIGRATIONS,
        clock: new SystemClock({ wallTrusted: () => true }),
        rules: DEFAULT_RULES,
        platform: process.platform,
      })._unsafeUnwrap();
    /** The name the database in `dataDir` holds, opened as a start opens it. */
    const nameIn = (dataDir: string): string => {
      const store = open(dataDir);
      const name = store.db
        .query<{ name: string }, []>(`SELECT name FROM people WHERE id = 1`)
        .get()?.name;
      store.writer.stop()._unsafeUnwrap();
      store.db.close(true);
      return name ?? "(none: a new, empty database)";
    };
    const steps = swapSteps("/");
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (let cut = 0; cut <= steps.length; cut++) {
      const data = tempDir("cut-restore");
      const other = tempDir("cut-restore-from");
      folders.push(data, other);
      // The restored database, prepared beside hub.db as `applyRestore` leaves it.
      const from = open(other.path);
      from.db.run(`INSERT INTO people VALUES (1, 'restored', 0, NULL, 0)`);
      from.db.run(`VACUUM INTO ?`, [join(data.path, RESTORE_FILE)]);
      from.writer.stop()._unsafeUnwrap();
      from.db.close(true);
      // The old one, stopped cleanly as the switch does first: what it committed may still be in
      // its log, as a stopped hub leaves it.
      const old = open(data.path);
      old.db.run(`INSERT INTO people VALUES (1, 'old', 0, NULL, 0)`);
      old.writer.stop()._unsafeUnwrap();
      old.db.close(true);
      // The power goes after `cut` of the real steps.
      for (const step of swapSteps(data.path).slice(0, cut))
        expect(step.run().isOk() ? "ok" : step.name).toBe("ok");
      // What is on the disk is a whole database: hub.db, the old one or the restored one.
      expect(existsSync(join(data.path, "hub.db"))).toBe(true);
      const look = tempDir("cut-restore-look");
      folders.push(look);
      for (const name of readdirSync(data.path).filter((n) => n.startsWith("hub.db")))
        writeFileSync(join(look.path, name), readFileSync(join(data.path, name)));
      for (const name of [RESTORE_FILE, BEFORE_RESTORE_FILE])
        rmSync(join(look.path, name), { force: true });
      expect(["old", "restored"]).toContain(nameIn(look.path));
      // The next start finishes the swap, and runs on the restored database.
      // (Once the restored file is renamed over hub.db, nothing is left to do.)
      const waiting = existsSync(join(data.path, RESTORE_FILE));
      expect(retryWaitingRestore(data.path).kind).toBe(waiting ? "swapped" : "nothing");
      expect(nameIn(data.path)).toBe("restored");
      // The old database is kept, whole, as hub.db.before-restore.
      const kept = tempDir("cut-restore-kept");
      folders.push(kept);
      writeFileSync(join(kept.path, "hub.db"), readFileSync(join(data.path, BEFORE_RESTORE_FILE)));
      expect(nameIn(kept.path)).toBe("old");
    }
  });
});

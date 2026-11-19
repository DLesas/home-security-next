/**
 * A restore's upload outlives a wrong key (m2-design.md section 9: a wrong key is `wrongKey`, "and
 * the token stays usable until it expires"): the shell's `ended` (`AppSide`, `app-wiring.ts`) frees
 * an `applyRestore`'s upload only once the restore is applied, or the hub stops, so the phone's next
 * try with the right key finds the file and restores, where it was answered `busy` before. The
 * other jobs' uploads go as before: a header read that failed, a staging however it ended.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import type { FileWork } from "../../../src/core/model/effects.ts";
import type { HubError } from "../../../src/core/model/errors.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { type ConnId, connId, jobId, type JobId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import { ensureHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import { type AppStart, AppSide, startApp } from "../../../src/shell/app-wiring.ts";
import { runToEnd } from "../../../src/shell/backup/jobs.ts";
import { MIGRATIONS, openTestStore, tempDir, TestClock } from "../storage/fixtures.ts";

const KEY = new Uint8Array(32).fill(0x31);
const WRONG_KEY = new Uint8Array(32).fill(0x77);
const CONSOLE = connId(500);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

/** A backup of a hub with a person in it, sealed with `KEY`. */
function backupFile(root: string): Uint8Array {
  const store = openTestStore(join(root, "old"), new TestClock());
  store.db.run(
    `INSERT INTO hub_keys (signing_private, signing_public, identity, app_static_private, app_static_public) VALUES (?, ?, ?, ?, ?)`,
    [
      new Uint8Array(8),
      new Uint8Array(64),
      new Uint8Array(8),
      new Uint8Array(32),
      new Uint8Array(32).fill(5),
    ],
  );
  store.db.run(`INSERT INTO people (id, name, created_ms, revision) VALUES (1, 'Anna', 1, 1)`);
  const folder = join(root, "backups");
  mkdirSync(folder);
  const done = runToEnd(
    jobId(1),
    { kind: "backup", folder, keep: 20, key: KEY, epoch: 1 },
    {
      db: store.db,
      dataDir: join(root, "old"),
      migrationsFolder: MIGRATIONS,
      rules: DEFAULT_RULES,
      uploads: { pathOf: () => undefined },
      exports: { send: () => ok(undefined) },
      prefix: undefined,
      switchBlockedBy: () => undefined,
      nowMs: () => Date.UTC(2026, 10, 18),
      salt: () => ok(new Uint8Array(8).fill(9)),
    },
  );
  expect(done).toMatchObject({ kind: "ready", outcome: { kind: "backupWritten" } });
  store.db.close();
  return new Uint8Array(readFileSync(join(folder, readdirSync(folder)[0] ?? "")));
}

/** The new hub's app side, as `main.ts` makes it, without its listeners. */
async function newHub(root: string): Promise<{ readonly side: AppSide; readonly start: AppStart }> {
  const data = join(root, "new");
  const store = openTestStore(data, new TestClock());
  cleanups.push(() => {
    store.db.close();
  });
  const reports: HubError[] = [];
  const options = {
    dataDir: data,
    db: store.db,
    writer: store.writer,
    random: (length: number) => ok(crypto.getRandomValues(new Uint8Array(length))),
    nowMs: () => Date.now(),
    rules: DEFAULT_RULES,
    paths: { migrations: MIGRATIONS, web: mkdtempSync(join(root, "web-")) },
    ports: { lan: 0, console: 0 },
    env: {},
    writerStatus: () => ({
      lastCommitMs: null,
      stagedItems: 0,
      databaseBytes: null,
      historyShortened: false,
    }),
    report: (error: HubError) => reports.push(error),
    history: { rows: () => ok([]), staged: () => [] },
    publisherKeys: [],
  };
  (await ensureHubKeys(store.snapshot.hubKeys, store.writer))._unsafeUnwrap();
  const start = startApp(options, [])._unsafeUnwrap();
  const state = makeCore(MODULES).emptyState();
  const side = AppSide.make(
    options,
    start,
    () => state,
    () => undefined,
  )._unsafeUnwrap();
  cleanups.push(() => {
    side.stop();
  });
  return { side, start };
}

/** The console's upload `job` of `bytes`, in chunks of 48 KB ‡, as `fileChunk` requests send it. */
function upload(start: AppStart, conn: ConnId, job: number, bytes: Uint8Array): void {
  const size = 48_000;
  const chunks = Math.max(1, Math.ceil(bytes.length / size));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (let n = 0; n < chunks; n++) {
    const data = Buffer.from(bytes.subarray(n * size, (n + 1) * size)).toString("base64url");
    const taken = start.uploads.chunk(conn, {
      job,
      n,
      data,
      ...(n === chunks - 1 ? { end: { chunks, sha256 } } : {}),
    });
    expect(taken.ok).toBe(true);
  }
  expect(start.uploads.finished({ conn, job })).toBeDefined();
}

/** A job run as the loop runs it, a piece a turn, then `ended` as the loop calls it. */
function run(side: AppSide, job: JobId, work: FileWork): FileOutcome {
  const started = side.job(job, work);
  let outcome: FileOutcome;
  if (started.kind === "ready") outcome = started.outcome;
  else if (started.kind === "pieces") {
    for (;;) {
      const piece = started.pieces.next();
      if (piece.done) {
        outcome = piece.outcome;
        break;
      }
    }
  } else outcome = { kind: "failed", reason: "io", message: "a switch" };
  side.ended(job, work, outcome);
  return outcome;
}

describe("a restore's upload and a wrong key (section 9)", () => {
  test("a wrong key: wrongKey, the upload kept; the right key then restores, and only then is it freed", async () => {
    const root = mkdtempSync(join(tempDir("restore-retry").path, "r-"));
    const file = backupFile(root);
    const { side, start } = await newHub(root);
    upload(start, CONSOLE, 5, file);
    const ref = { conn: CONSOLE, job: 5 };

    expect(run(side, jobId(10), { kind: "readRestore", upload: ref })).toMatchObject({
      kind: "restoreRead",
      epoch: 1,
    });
    expect(start.uploads.finished(ref)).toBeDefined();

    const wrong = run(side, jobId(11), { kind: "applyRestore", upload: ref, key: WRONG_KEY });
    expect(wrong).toMatchObject({ kind: "failed", reason: "wrongKey" });
    expect(start.uploads.finished(ref)).toBeDefined();
    // And again: a second wrong try keeps it too.
    expect(
      run(side, jobId(12), { kind: "applyRestore", upload: ref, key: WRONG_KEY }),
    ).toMatchObject({ kind: "failed", reason: "wrongKey" });
    expect(start.uploads.finished(ref)).toBeDefined();

    expect(run(side, jobId(13), { kind: "applyRestore", upload: ref, key: KEY })).toEqual({
      kind: "restoreReady",
    });
    expect(start.uploads.finished(ref)).toBeUndefined();
  });

  test("an applyRestore cut off by a stop (no outcome): its upload freed", async () => {
    const root = mkdtempSync(join(tempDir("restore-stop").path, "r-"));
    const { side, start } = await newHub(root);
    upload(start, CONSOLE, 6, new Uint8Array(100).fill(1));
    const ref = { conn: CONSOLE, job: 6 };
    side.ended(jobId(1), { kind: "applyRestore", upload: ref, key: KEY }, undefined);
    expect(start.uploads.finished(ref)).toBeUndefined();
  });

  test("a damaged file: badFile, the upload kept while the restore's token lives (the core keeps it offered)", async () => {
    const root = mkdtempSync(join(tempDir("restore-bad").path, "r-"));
    const file = backupFile(root);
    file[file.length - 1] = (file[file.length - 1] ?? 0) ^ 1;
    const { side, start } = await newHub(root);
    upload(start, CONSOLE, 7, file);
    const ref = { conn: CONSOLE, job: 7 };
    expect(run(side, jobId(20), { kind: "applyRestore", upload: ref, key: KEY })).toMatchObject({
      kind: "failed",
    });
    expect(start.uploads.finished(ref)).toBeDefined();
  });

  test("as before: a header read that failed frees its upload, one that succeeded keeps it; a staging frees its upload however it ended", async () => {
    const root = mkdtempSync(join(tempDir("restore-others").path, "r-"));
    const { side, start } = await newHub(root);
    upload(start, CONSOLE, 8, new Uint8Array(100).fill(2));
    const notBackup = { conn: CONSOLE, job: 8 };
    expect(run(side, jobId(30), { kind: "readRestore", upload: notBackup })).toMatchObject({
      kind: "failed",
      reason: "badFile",
    });
    expect(start.uploads.finished(notBackup)).toBeUndefined();

    upload(start, CONSOLE, 9, new Uint8Array(100).fill(3));
    const release = { conn: CONSOLE, job: 9 };
    side.ended(
      jobId(31),
      { kind: "stageUpdate", upload: release },
      { kind: "failed", reason: "badFile", message: "x" },
    );
    expect(start.uploads.finished(release)).toBeUndefined();
  });

  test("a release fetched over the relay is not the app side's to free: ended leaves the uploads alone", async () => {
    const root = mkdtempSync(join(tempDir("restore-fetch").path, "r-"));
    const { side, start } = await newHub(root);
    upload(start, CONSOLE, 4, new Uint8Array(100).fill(4));
    side.ended(
      jobId(4),
      {
        kind: "fetchRelease",
        release: "hub",
        file: "hsn-hub-9.0.0-darwin-arm64.hsnr",
        bytes: 100,
        sha256: new Uint8Array(32),
      },
      { kind: "updateStaged", version: "9.0.0" },
    );
    expect(start.uploads.finished({ conn: CONSOLE, job: 4 })).toBeDefined();
  });
});

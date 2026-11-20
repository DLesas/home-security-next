/**
 * A staging through the app side's file jobs (`AppSide.job`, `app-wiring.ts`), as `main.ts` wires
 * them for the loop: the job says it is waiting while its worker stages, so the loop asks no turn
 * for it, and the worker's outcome asks for one through `wake` (the loop's `askTurn`). Without the
 * wake the job never says it waits, and the loop turns for it as for any job.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok, Result } from "neverthrow";
import { connId, jobId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import { ensureHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import { type AppStart, AppSide, startApp } from "../../../src/shell/app-wiring.ts";
import { installPaths } from "../../../launcher/src/layout.ts";
import { releaseOfFiles } from "../../../packaging/shared/make-release.ts";
import { programName } from "../../../src/shell/update/program-name.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { platformOf } from "../../../src/shell/update/release.ts";
import { stagingBusy } from "../../../src/shell/update/stage-job.ts";
import { MIGRATIONS, openTestStore, tempDir, TestClock } from "../storage/fixtures.ts";

const PLATFORM = platformOf(process.platform, process.arch);
const JOB = jobId(5);
const CONN = connId(3);
const cleanups: (() => void)[] = [];
afterEach(async () => {
  // The worker's thread gone before its folders go (Windows removes no file still open).
  for (let i = 0; i < 2000 && stagingBusy(); i++) await Bun.sleep(5);
  for (const clean of cleanups.splice(0).reverse()) clean();
});

const WORK = { kind: "stageUpdate", upload: { conn: CONN, job: 1 } } as const;
/** The longest a staging here may take: past it, the test fails rather than waits on. */
const STAGING_MS = 15_000;

setDefaultTimeout(60_000);

/**
 * A folder of this test's, removed after it if it can be: on Windows a database just closed can
 * keep its file a moment, and the folder then stays in the temporary folder, as
 * `restore-retry.test.ts`'s do.
 */
function folder(): string {
  const dir = tempDir("hsn-app-staging-");
  cleanups.push(() => {
    Result.fromThrowable(() => {
      dir.remove();
    })().match(
      () => undefined,
      () => undefined,
    );
  });
  return dir.path;
}

/** The program tree the launcher would have made, running 0.0.1. */
function programTree(root: string): string {
  const prefix = join(root, "program");
  mkdirSync(join(prefix, "staged", "0.0.1", "bin"), { recursive: true });
  mkdirSync(join(prefix, "state"), { recursive: true });
  writeFileSync(
    installPaths(prefix).launcherFile,
    JSON.stringify({ current: "0.0.1", previous: null, trial: null, rolledBack: null }),
  );
  return prefix;
}

/** The app side as `main.ts` makes it, without its listeners; the core staging `JOB`. */
async function appSide(
  root: string,
  prefix: string,
  wake?: () => void,
): Promise<{ side: AppSide; start: AppStart }> {
  const data = join(root, "data");
  const store = openTestStore(data, new TestClock());
  cleanups.push(() => {
    store.db.close();
  });
  const options = {
    dataDir: data,
    db: store.db,
    writer: store.writer,
    random: (length: number) => ok(crypto.getRandomValues(new Uint8Array(length))),
    nowMs: () => Date.now(),
    rules: DEFAULT_RULES,
    paths: { migrations: MIGRATIONS, web: mkdtempSync(join(root, "web-")) },
    ports: { lan: 0, console: 0 },
    env: { HSN_PROGRAM: prefix },
    writerStatus: () => ({
      lastCommitMs: null,
      stagedItems: 0,
      databaseBytes: null,
      historyShortened: false,
    }),
    report: () => undefined,
    history: { rows: () => ok([]), staged: () => [] },
    publisherKeys: [TEST_PUBLISHER_KEY],
    ...(wake === undefined ? {} : { wake }),
  };
  (await ensureHubKeys(store.snapshot.hubKeys, store.writer))._unsafeUnwrap();
  const start = startApp(options, [])._unsafeUnwrap();
  const empty = makeCore(MODULES).emptyState();
  // The core is staging `JOB` (as after `update.fetch`), so the job is wanted.
  const state: HubState = {
    ...empty,
    upkeep: { ...empty.upkeep, staging: { source: "fetch", job: JOB, version: "9.0.0" } },
  };
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

/** A release for this computer, newer than the running hub, uploaded as the console's upload 1. */
function uploaded(start: AppStart): void {
  const data = new TextEncoder().encode("a program\n".repeat(10_000));
  const bytes = releaseOfFiles(
    [{ path: `bin/${programName(PLATFORM ?? "linux-x64")}`, data, executable: true }],
    "9.0.0",
    PLATFORM ?? "linux-x64",
    new Uint8Array(32).fill(7),
    0,
  )._unsafeUnwrap();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // In chunks of 48 KB ‡, as `fileChunk` requests send it.
  const size = 48_000;
  const chunks = Math.ceil(bytes.length / size);
  for (let n = 0; n < chunks; n++) {
    const taken = start.uploads.chunk(CONN, {
      job: 1,
      n,
      data: Buffer.from(bytes.subarray(n * size, (n + 1) * size)).toString("base64url"),
      ...(n === chunks - 1 ? { end: { chunks, sha256 } } : {}),
    });
    expect(taken.ok).toBe(true);
  }
}

describe.skipIf(PLATFORM === undefined)("a staging through the app side's file jobs", () => {
  test("waits while its worker stages; the outcome asks for a turn once", async () => {
    const root = folder();
    const prefix = programTree(root);
    const woken = Promise.withResolvers<undefined>();
    let wakes = 0;
    const { side, start } = await appSide(root, prefix, () => {
      wakes += 1;
      woken.resolve(undefined);
    });
    uploaded(start);
    const started = side.job(JOB, WORK);
    expect(started.kind).toBe("pieces");
    if (started.kind !== "pieces") return;
    expect(started.pieces.waiting?.()).toBe(true);
    expect(started.pieces.next()).toEqual({ done: false });
    const woke = await Promise.race([
      woken.promise.then(() => true),
      Bun.sleep(STAGING_MS).then(() => false),
    ]);
    expect(woke, `a wake within ${STAGING_MS} ms`).toBe(true);
    expect(wakes).toBe(1);
    expect(started.pieces.waiting?.()).toBe(false);
    const outcome = { kind: "updateStaged", version: "9.0.0" } as const;
    expect(started.pieces.next()).toEqual({ done: true, outcome });
    // The job's end, as the loop tells it: its upload freed.
    side.ended(JOB, WORK, outcome);
  });

  test("without a wake it never says it waits, and the loop turns for it until it ends", async () => {
    const root = folder();
    const { side, start } = await appSide(root, programTree(root));
    uploaded(start);
    const started = side.job(JOB, WORK);
    if (started.kind !== "pieces") return;
    const end = performance.now() + STAGING_MS;
    for (;;) {
      expect(performance.now(), `staged within ${STAGING_MS} ms`).toBeLessThan(end);
      expect(started.pieces.waiting?.()).toBe(false);
      const piece = started.pieces.next();
      if (piece.done) {
        expect(piece.outcome).toEqual({ kind: "updateStaged", version: "9.0.0" });
        side.ended(JOB, WORK, piece.outcome);
        break;
      }
      await Bun.sleep(1);
    }
  });
});

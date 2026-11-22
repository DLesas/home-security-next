/**
 * The file jobs the hub runs off its thread, through the app side's file jobs (`AppSide.job`,
 * `app-wiring.ts`), as `main.ts` wires them for the loop: a firmware image's staging, a backup
 * and a restore on their workers (D145), and a firmware image's removal off the loop. Each job the
 * hub is given (a restore's header read, `readRestore`, too) says it is waiting while its work runs, so the loop asks no turn for it, and its
 * outcome asks for one turn through `wake` (the loop's `askTurn`). Without the wake the job never
 * says it waits, and the loop turns for it as for any job. (An update's staging is
 * `shell-update/app-staging.test.ts`'s.)
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok, Result } from "neverthrow";
import type { FileWork } from "../../../src/core/model/effects.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { connId, imageId, jobId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import { ensureHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import { type AppStart, AppSide, startApp } from "../../../src/shell/app-wiring.ts";
import { imageFileName, storeFolder } from "../../../src/shell/firmware/store.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { gateBusy } from "../../../src/shell/worker/job.ts";
import { espImage, sha256 } from "../shell-firmware/support.ts";
import { MIGRATIONS, openTestStore, tempDir, TestClock } from "../storage/fixtures.ts";

const CONN = connId(3);
const KEY = new Uint8Array(32).fill(0x31);
const cleanups: (() => void)[] = [];
/** The longest a job here may take: past it, the test fails rather than waits on. */
const JOB_MS = 15_000;

setDefaultTimeout(60_000);

afterEach(async () => {
  // Every worker's thread gone before its folders go (Windows removes no file still open).
  for (let i = 0; i < 2000 && gateBusy("applyRestore"); i++) await Bun.sleep(5);
  await Bun.sleep(50);
  for (const clean of cleanups.splice(0).reverse()) clean();
});

function folder(): string {
  const dir = tempDir("hsn-worker-jobs-");
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

interface Side {
  readonly side: AppSide;
  readonly start: AppStart;
  readonly data: string;
}

/** The app side as `main.ts` makes it, without its listeners; with the loop's wake if given. */
async function appSide(root: string, wake?: () => void): Promise<Side> {
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
    env: {},
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
  const side = AppSide.make(
    options,
    start,
    () => empty,
    () => undefined,
  )._unsafeUnwrap();
  cleanups.push(() => {
    side.stop();
  });
  return { side, start, data };
}

/** `bytes` uploaded as the console's upload `job`, in chunks of 48 KB ‡ as `fileChunk` sends it. */
function upload(start: AppStart, job: number, bytes: Uint8Array): void {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const size = 48_000;
  const chunks = Math.max(1, Math.ceil(bytes.length / size));
  for (let n = 0; n < chunks; n++) {
    const taken = start.uploads.chunk(CONN, {
      job,
      n,
      data: Buffer.from(bytes.subarray(n * size, (n + 1) * size))
        .toString("base64url")
        .replace(/=+$/u, ""),
      ...(n === chunks - 1 ? { end: { chunks, sha256: hash } } : {}),
    });
    expect(taken.ok).toBe(true);
  }
}

/** A job given with the wake: it waits, wakes the loop once, then gives its outcome. */
async function withWake(
  root: string,
  prepare: (side: Side) => FileWork,
): Promise<{ readonly outcome: FileOutcome; readonly side: Side }> {
  const woken = Promise.withResolvers<undefined>();
  let wakes = 0;
  const side = await appSide(root, () => {
    wakes += 1;
    woken.resolve(undefined);
  });
  const work = prepare(side);
  const job = jobId(7);
  const started = side.side.job(job, work);
  expect(started.kind).toBe("pieces");
  if (started.kind !== "pieces")
    return { outcome: { kind: "failed", reason: "io", message: "" }, side };
  expect(started.pieces.waiting?.()).toBe(true);
  expect(started.pieces.next()).toEqual({ done: false });
  const woke = await Promise.race([
    woken.promise.then(() => true),
    Bun.sleep(JOB_MS).then(() => false),
  ]);
  expect(woke, `a wake within ${JOB_MS} ms`).toBe(true);
  // One wake, and no other until the loop takes the outcome.
  await Bun.sleep(50);
  expect(wakes).toBe(1);
  expect(started.pieces.waiting?.()).toBe(false);
  const piece = started.pieces.next();
  expect(piece.done).toBe(true);
  const outcome = piece.done
    ? piece.outcome
    : { kind: "failed" as const, reason: "io" as const, message: "" };
  side.side.ended(job, work, outcome);
  return { outcome, side };
}

/** The same job given without a wake: it never says it waits; turned for until it ends. */
async function withoutWake(root: string, prepare: (side: Side) => FileWork): Promise<FileOutcome> {
  const side = await appSide(root);
  const work = prepare(side);
  const job = jobId(8);
  const started = side.side.job(job, work);
  expect(started.kind).toBe("pieces");
  if (started.kind !== "pieces") return { kind: "failed", reason: "io", message: "" };
  const end = performance.now() + JOB_MS;
  for (;;) {
    expect(performance.now(), `ended within ${JOB_MS} ms`).toBeLessThan(end);
    expect(started.pieces.waiting?.()).toBe(false);
    const piece = started.pieces.next();
    if (piece.done) {
      side.side.ended(job, work, piece.outcome);
      return piece.outcome;
    }
    await Bun.sleep(1);
  }
}

/** An owner's own build uploaded as upload 1: `stageFirmware`. */
function firmware(side: Side): FileWork {
  upload(side.start, 1, espImage({ size: 300_000, seed: 3 }));
  return { kind: "stageFirmware", upload: { conn: CONN, job: 1 }, own: { version: "1.4.0" } };
}

/** A backup into a folder beside the data folder. */
function backup(side: Side): FileWork {
  const folder = join(side.data, "..", "backups");
  mkdirSync(folder, { recursive: true });
  return { kind: "backup", folder, keep: 20, key: KEY, epoch: 1 };
}

/** An image's file in the store that no image in the index names: `removeFirmware`. */
function removal(side: Side): FileWork {
  const file = imageFileName(sha256(Uint8Array.of(9)));
  mkdirSync(storeFolder(side.data), { recursive: true });
  writeFileSync(join(storeFolder(side.data), file), "an image");
  return { kind: "removeFirmware", image: imageId(4), file };
}

describe("the jobs off the hub's thread, through the app side's file jobs", () => {
  test.each([
    ["a firmware image's staging", firmware, "firmwareStaged"],
    ["a backup", backup, "backupWritten"],
    ["a firmware image's removal", removal, "firmwareRemoved"],
  ] as const)("%s waits, wakes the loop once, then ends", async (_name, prepare, kind) => {
    const { outcome } = await withWake(folder(), prepare);
    expect(outcome.kind).toBe(kind);
  });

  test.each([
    ["a firmware image's staging", firmware, "firmwareStaged"],
    ["a backup", backup, "backupWritten"],
    ["a firmware image's removal", removal, "firmwareRemoved"],
  ] as const)("%s, without a wake, never says it waits", async (_name, prepare, kind) => {
    expect((await withoutWake(folder(), prepare)).kind).toBe(kind);
  });

  /** A backup of a hub, written by its own job, uploaded to this one as upload 2. */
  async function restoreWork(
    root: string,
    kind: "applyRestore" | "readRestore" = "applyRestore",
  ): Promise<(side: Side) => FileWork> {
    const { side } = await withWake(join(root, "old"), backup);
    const folderPath = join(side.data, "..", "backups");
    const [name] = readdirSync(folderPath).filter((n) => n.endsWith(".hsnb"));
    const bytes = new Uint8Array(readFileSync(join(folderPath, name ?? "")));
    return (target) => {
      upload(target.start, 2, bytes);
      return kind === "applyRestore"
        ? { kind, upload: { conn: CONN, job: 2 }, key: KEY }
        : { kind, upload: { conn: CONN, job: 2 } };
    };
  }

  test("a restore waits, wakes the loop once, then ends; without a wake it never says it waits", async () => {
    const root = folder();
    mkdirSync(join(root, "old"), { recursive: true });
    mkdirSync(join(root, "new"), { recursive: true });
    mkdirSync(join(root, "plain"), { recursive: true });
    const work = await restoreWork(root);
    expect((await withWake(join(root, "new"), work)).outcome).toEqual({ kind: "restoreReady" });
    expect(await withoutWake(join(root, "plain"), work)).toEqual({ kind: "restoreReady" });
  });

  test("a restore's header read (readRestore) off the loop: waits, wakes once; without a wake never says it waits", async () => {
    const root = folder();
    for (const sub of ["old", "new", "plain"]) mkdirSync(join(root, sub), { recursive: true });
    const work = await restoreWork(root, "readRestore");
    expect((await withWake(join(root, "new"), work)).outcome).toMatchObject({
      kind: "restoreRead",
      epoch: 1,
    });
    expect(await withoutWake(join(root, "plain"), work)).toMatchObject({ kind: "restoreRead" });
  });
});

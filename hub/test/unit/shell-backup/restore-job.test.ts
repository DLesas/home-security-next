/**
 * A restore's candidate database built on its worker thread (`shell/backup/restore-job.ts`,
 * `restore-serve.ts`), as the loop drives it: the same outcomes and the same restored database as
 * `RestorePieces` on the thread, nothing of `hub.db` read; a stop, with the worker answering and
 * not; a worker that does not start, throws or exits first, `hub.db.restore` among what it leaves
 * removed (the next start would put it in place); one restore at a time; and the swap still the
 * switch's, after the stop, on the candidate the worker left closed and whole.
 *
 * A worker stuck in two ways, each let go by the test: in a real file call, the upload made a FIFO
 * with no writer, whose header the first piece reads, so the worker blocks in `open()`, nothing
 * written yet (FIFOs are Linux's and macOS's); and on every system, Windows too, a stand-in worker
 * that builds as the real one but holds its thread at its first piece of opening, the scratch
 * plaintext file made (`restore-workers/held.ts`).
 *
 * The loop's time is asserted in a child process holding nothing but the job
 * (`restore-timing-child.ts`), for the reason `shell-update`'s `stage-job.test.ts` gives.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err } from "neverthrow";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { RestoreJob } from "../../../src/shell/backup/restore-job.ts";
import {
  RESTORE_FILE,
  type RestoreInputs,
  RestorePieces,
  swapRestored,
} from "../../../src/shell/backup/restore.ts";
import { type JobThreadEvents, startJobThread } from "../../../src/shell/safe/job-thread.ts";
import { jobControl } from "../../../src/shell/worker/control.ts";
import {
  gateBusy,
  STOP_WAIT_MS,
  type StartWorker,
  type WorkerJobOptions,
} from "../../../src/shell/worker/job.ts";
import type { KindData, WorkerData } from "../../../src/shell/worker/kinds.ts";
import { backupFileOf, backupHub, KEY } from "./backup-rig.ts";
import type { RestoreChildArgs, RestoreChildNumbers } from "./restore-timing-child.ts";

/** A restore's worker data. */
type Restored = KindData<"applyRestore">;

const POSIX = process.platform !== "win32";
const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
const CHILD = join(import.meta.dir, "restore-timing-child.ts");
const root = mkdtempSync(join(tmpdir(), "hsn-restore-job-"));
const writers: ReturnType<typeof Bun.spawn>[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
/** The jobs this test made: each aborted after it, so that a failed test leaves no worker held. */
const opened: RestoreJob[] = [];
/** The stuck restores this test made: each let go after it. */
const stuck: { readonly at: Rig; readonly way: StuckWay }[] = [];
let rigs = 0;

/** The longest a drive waits for the job's wake, and the most turns it may ask for one restore. */
const WAKE_WAIT_MS = 6000;
const MOST_TURNS = 20;
/** A home's configuration, about 180 KB ‡. */
const PEOPLE_KB = 180;

setDefaultTimeout(60_000);

/** One backup of a home's configuration, made once: every restore here opens a copy of it. */
const BACKUP = (() => {
  const base = join(root, "old");
  mkdirSync(join(base, "backups"), { recursive: true });
  const store = backupHub(join(base, "data"), PEOPLE_KB);
  const file = backupFileOf(store, join(base, "data"), join(base, "backups"));
  store.db.close(true);
  return file;
})();

afterEach(async () => {
  for (const { at, way } of stuck.splice(0)) way.letGo(at);
  for (const job of opened.splice(0)) job.abort("the test is over");
  await until(() => !gateBusy("applyRestore"), 20_000);
});

afterAll(() => {
  for (const spawned of [...writers, ...children]) spawned.kill(9);
  rmSync(root, { recursive: true, force: true });
});

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    expect(performance.now()).toBeLessThan(end);
    await Bun.sleep(5);
  }
}

/** A new hub's data folder, the upload in it a copy of `upload` (or a FIFO). */
interface Rig {
  readonly dataDir: string;
  readonly upload: string;
}

function rig(upload: Uint8Array | "fifo" = readFileSync(BACKUP)): Rig {
  const dataDir = join(root, `new-${(rigs += 1)}`);
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const path = join(dataDir, "uploads", "1");
  if (upload === "fifo") expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  else writeFileSync(path, upload);
  return { dataDir, upload: path };
}

function inputs(at: Rig, key: Uint8Array = KEY): RestoreInputs {
  return {
    dataDir: at.dataDir,
    uploadPath: at.upload,
    key,
    migrationsFolder: MIGRATIONS,
    rules: DEFAULT_RULES,
  };
}

/** `RestorePieces` on this thread, a piece after another: what the loop did before the worker. */
function onThread(restoreInputs: RestoreInputs): FileOutcome {
  const pieces = new RestorePieces(restoreInputs);
  for (;;) {
    const outcome = pieces.next();
    if (outcome !== undefined) return outcome;
  }
}

/** Every table of the database at `path` and its rows, as JSON. */
function dump(path: string): Record<string, string> {
  const db = new Database(path, { readonly: true });
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  const out: Record<string, string> = {};
  for (const table of tables)
    out[table] = JSON.stringify(
      db.query(`SELECT * FROM "${table}"`).all(),
      (_key, value: unknown) =>
        value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value,
    );
  db.close(true);
  return out;
}

/** The data folder's names but the upload's folder. */
function made(at: Rig): readonly string[] {
  return readdirSync(at.dataDir)
    .filter((name) => name !== "uploads")
    .toSorted();
}

interface Drive {
  readonly job: RestoreJob;
  wakes: number;
  /**
   * Runs turns as the loop does until the job ends: none while it waits, a wake asking for one.
   * A wake not come within `WAKE_WAIT_MS`, or more than `MOST_TURNS` turns, fails.
   */
  readonly end: () => Promise<FileOutcome>;
}

/** A job with a wake, driven as the loop drives it. */
function driven(
  restoreInputs: RestoreInputs,
  options: Omit<WorkerJobOptions<Restored>, "wake"> = {},
): Drive {
  let woken = Promise.withResolvers<undefined>();
  const drive: Drive = {
    job: new RestoreJob(restoreInputs, {
      ...options,
      wake: () => {
        drive.wakes += 1;
        woken.resolve(undefined);
      },
    }),
    wakes: 0,
    end: async () => {
      for (let turns = 1; ; turns++) {
        expect(turns, "turns asked for one restore").toBeLessThanOrEqual(MOST_TURNS);
        const outcome = drive.job.next();
        if (outcome !== undefined) return outcome;
        if (drive.job.waiting()) {
          const woke = await Promise.race([
            woken.promise.then(() => true),
            Bun.sleep(WAKE_WAIT_MS).then(() => false),
          ]);
          expect(woke, `a wake within ${WAKE_WAIT_MS} ms`).toBe(true);
          woken = Promise.withResolvers<undefined>();
        } else await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
  opened.push(drive.job);
  return drive;
}

const startWith =
  (entry: string): StartWorker<Restored> =>
  (data, events) =>
    startJobThread(data, events, new URL(`./restore-workers/${entry}`, import.meta.url));

describe("a restore on its worker", () => {
  test("the same outcome and restored database as on the thread; one wake; closed and whole when told", async () => {
    const before = rig();
    expect(onThread(inputs(before))).toEqual({ kind: "restoreReady" });
    const after = rig();
    const drive = driven(inputs(after));
    expect(drive.job.waiting()).toBe(true);
    expect(await drive.end()).toEqual({ kind: "restoreReady" });
    expect(drive.wakes).toBe(1);
    // Only the candidate is left, its scratch files gone; no journal beside it, so it was closed.
    expect(made(after)).toEqual([RESTORE_FILE]);
    expect(dump(join(after.dataDir, RESTORE_FILE))).toEqual(
      dump(join(before.dataDir, RESTORE_FILE)),
    );
  });

  test.each([
    { name: "a wrong key", make: () => readFileSync(BACKUP), key: new Uint8Array(32).fill(2) },
    {
      name: "a damaged file",
      make: () => {
        const bytes = readFileSync(BACKUP);
        bytes[bytes.length - 40] = (bytes[bytes.length - 40] ?? 0) ^ 1;
        return bytes;
      },
      key: KEY,
    },
    { name: "a cut file", make: () => readFileSync(BACKUP).subarray(0, 5000), key: KEY },
    { name: "not a backup", make: () => new TextEncoder().encode("hello"), key: KEY },
  ])("refused as on the thread: $name, nothing left behind", async ({ make, key }) => {
    const before = rig(make());
    const expected = onThread(inputs(before, key));
    expect(expected.kind).toBe("failed");
    const after = rig(make());
    expect(await driven(inputs(after, key)).end()).toEqual(expected);
    expect(made(after)).toEqual([]);
  });

  test("nothing of hub.db read: with hub.db a folder no database opens, the same restore", async () => {
    const at = rig();
    mkdirSync(join(at.dataDir, "hub.db"));
    expect(await driven(inputs(at)).end()).toEqual({ kind: "restoreReady" });
    expect(made(at)).toEqual(["hub.db", RESTORE_FILE]);
  });

  test("the swap still the switch's: after the stop, the candidate the worker left goes in place", async () => {
    const at = rig();
    // A hub's own database in the data folder, closed, as after the clean stop.
    backupHub(at.dataDir, 1).db.close(true);
    expect(await driven(inputs(at)).end()).toEqual({ kind: "restoreReady" });
    const candidate = dump(join(at.dataDir, RESTORE_FILE));
    const swapped = swapRestored(at.dataDir);
    expect(swapped.isOk() ? "" : swapped.error).toBe("");
    expect(dump(join(at.dataDir, "hub.db"))).toEqual(candidate);
  });

  test("one restore at a time: a second waits for the first to be over", async () => {
    const first = driven(inputs(rig()), { start: startWith("holds.ts") });
    const starts: number[] = [];
    const second = driven(inputs(rig()), {
      start: (data, events) => {
        starts.push(performance.now());
        return startJobThread(data, events);
      },
    });
    expect(starts).toEqual([]);
    const firstEnded = first.end();
    expect(await second.end()).toEqual({ kind: "restoreReady" });
    expect(await firstEnded).toEqual({ kind: "restoreReady" });
    expect(starts).toHaveLength(1);
  });

  test("without a wake the job never says it waits (the loop then turns for it)", async () => {
    const job = new RestoreJob(inputs(rig()));
    opened.push(job);
    expect(job.waiting()).toBe(false);
    for (;;) {
      if (job.next() !== undefined) break;
      await Bun.sleep(1);
    }
  });
});

const STOPPED = { kind: "failed", reason: "io", message: "the hub is stopping" } as const;

/** A way to have the worker stuck in a file call, and to let it go on. */
interface StuckWay {
  readonly rig: () => Rig;
  readonly start: StartWorker<Restored>;
  /** Until the worker is at its stuck point. */
  readonly reached: (at: Rig) => Promise<void>;
  /** Lets it go on, after `afterMs`. */
  readonly letGo: (at: Rig, afterMs?: number) => void;
}

/** Writes `data` to `path` after `afterMs`, from another process: this thread may be in a stop's wait. */
function writeLater(path: string, data: string, afterMs: number): void {
  writers.push(
    Bun.spawn([
      process.execPath,
      "-e",
      `await Bun.sleep(${afterMs}); require("node:fs").writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(data)});`,
    ]),
  );
}

const FIFO: StuckWay = {
  rig: () => rig("fifo"),
  start: (data, events) => startJobThread(data, events),
  // Nothing marks a blocked open(): the worker has started and reached it well within this.
  reached: () => Bun.sleep(300),
  letGo: (at, afterMs = 0) => {
    writeLater(at.upload, "not a backup", afterMs);
  },
};

const HELD: StuckWay = {
  rig: () => rig(),
  start: startWith("held.ts"),
  reached: async (at) => {
    await until(() => existsSync(join(at.dataDir, `${RESTORE_FILE}.new.plain`)));
    await Bun.sleep(50);
  },
  letGo: (at, afterMs = 0) => {
    writeLater(join(at.dataDir, "go"), "", afterMs);
  },
};

const STUCK: readonly (readonly [string, StuckWay])[] = [
  ...(POSIX ? [["in a real file call (the upload a FIFO, nothing written)", FIFO] as const] : []),
  ["at its first piece of opening, its scratch file made (a stand-in, on every system)", HELD],
];

function stuckRig(way: StuckWay): Rig {
  const at = way.rig();
  stuck.push({ at, way });
  return at;
}

/** The data folder as a restore that never began left it (the stand-in's `go` aside). */
function nothingLeft(at: Rig): void {
  expect(made(at).filter((name) => name !== "go")).toEqual([]);
}

describe.each(STUCK)("a worker stuck %s", (_name, way) => {
  test("a stop shorter than the worker's wait ends at its bound; let go, the worker removes what it made", async () => {
    const at = stuckRig(way);
    const drive = driven(inputs(at), { start: way.start, stopWaitMs: 300 });
    await way.reached(at);
    expect(drive.job.next()).toBeUndefined();
    expect(drive.job.waiting()).toBe(true);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    const took = performance.now() - start;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1000);
    expect(drive.wakes).toBe(0);
    // Its thread still alive, the gate stays shut; let go, it sees the stop and removes its files.
    expect(gateBusy("applyRestore")).toBe(true);
    way.letGo(at);
    await until(() => !gateBusy("applyRestore"));
    nothingLeft(at);
  });

  test("a stop waits for the worker, which removes what it made: nothing left, no outcome for the core", async () => {
    const at = stuckRig(way);
    const drive = driven(inputs(at), { start: way.start });
    await way.reached(at);
    way.letGo(at, 200);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(performance.now() - start).toBeLessThan(1500);
    nothingLeft(at);
    expect(drive.wakes).toBe(0);
    expect(drive.job.next()).toEqual(STOPPED);
  });
});

describe("a worker held before it builds", () => {
  test("a stand-in held 1.5 s: waiting all the while, then the outcome", async () => {
    const drive = driven(inputs(rig()), { start: startWith("holds.ts") });
    await Bun.sleep(1000);
    expect(drive.job.waiting()).toBe(true);
    expect(drive.job.next()).toBeUndefined();
    expect(await drive.end()).toEqual({ kind: "restoreReady" });
  });

  test("a stop told during the hold: answered when it ends, within the bound, nothing made", async () => {
    const at = rig();
    const drive = driven(inputs(at), { start: startWith("holds.ts") });
    await Bun.sleep(300);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    const took = performance.now() - start;
    expect(took).toBeGreaterThan(500);
    expect(took).toBeLessThan(STOP_WAIT_MS);
    nothingLeft(at);
  });
});

describe("a stop after the worker's outcome came, before the loop took it", () => {
  test("no outcome for the core; the candidate whole in place, as after a cut between the rename and the core's step", async () => {
    const at = rig();
    const drive = driven(inputs(at));
    await until(() => !drive.job.waiting());
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(drive.job.next()).toEqual(STOPPED);
    expect(made(at)).toEqual([RESTORE_FILE]);
  });
});

describe("a worker that fails", () => {
  test("does not start: failed, saying so, nothing made", async () => {
    const at = rig();
    expect(await driven(inputs(at), { start: () => err("no thread for it") }).end()).toEqual({
      kind: "failed",
      reason: "io",
      message: "the restore worker did not start: no thread for it",
    });
    nothingLeft(at);
  });

  test("whose entry Bun refuses at once (a bare name): failed, saying so, nothing made", async () => {
    const at = rig();
    const refused = (data: WorkerData<Restored>, events: JobThreadEvents) =>
      startJobThread(data, events, "entry.ts");
    const said = refused(
      { kind: "applyRestore", inputs: inputs(at), control: jobControl() },
      { ended: () => undefined, failed: () => undefined, exited: () => undefined },
    );
    expect(said._unsafeUnwrapErr()).toContain("absolute path or a relative path");
    const outcome = await driven(inputs(at), { start: refused }).end();
    expect(outcome.kind === "failed" ? outcome.message : "").toStartWith(
      "the restore worker did not start: ",
    );
    nothingLeft(at);
  });

  test.each([
    ["throws", "throws.ts", "JSON Parse error"],
    ["exits first", "exits.ts", "exit code 3"],
  ])(
    "%s, having made every file, hub.db.restore too: failed, saying so, all of them removed",
    async (_name, entry, why) => {
      const at = rig();
      const outcome = await driven(inputs(at), { start: startWith(entry) }).end();
      expect(outcome).toMatchObject({ kind: "failed", reason: "io" });
      const message = outcome.kind === "failed" ? outcome.message : "";
      expect(message).toStartWith("the restore worker ended without an outcome: ");
      expect(message).toContain(why);
      // `hub.db.restore` too: the next start would otherwise put it in place. By their own names.
      for (const name of [
        "hub.db.restore",
        "hub.db.restore.new",
        "hub.db.restore.new-wal",
        "hub.db.restore.new-shm",
        "hub.db.restore.new.plain",
      ])
        expect(existsSync(join(at.dataDir, name)), name).toBe(false);
      nothingLeft(at);
    },
  );
});

/** Runs `restore-timing-child.ts` with `args`: its numbers, once it ended on its own within 30 s. */
async function inChild(args: RestoreChildArgs): Promise<RestoreChildNumbers> {
  const child = Bun.spawn([process.execPath, CHILD, JSON.stringify(args)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const ended = await Promise.race([child.exited, Bun.sleep(30_000).then(() => "running")]);
  const [out, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ ended, stderr }).toEqual({ ended: 0, stderr: "" });
  const line = out.split("\n").find((l) => l.startsWith("TIMING "));
  expect(line).toBeDefined();
  const numbers = JSON.parse((line ?? "").slice("TIMING ".length)) as RestoreChildNumbers;
  console.log(`the loop's thread in the child: ${JSON.stringify(numbers)}`);
  return numbers;
}

/** Section 3's limit for one of the loop's calls ‡: the job's constructor, and each `next()`. */
const CALL_MS = 20;
/** How late the loop's 10 ms timer may come while the job is open. */
const LATE_MS = 50;

function loopKeptFree(numbers: RestoreChildNumbers): void {
  expect(numbers.constructMs).toBeLessThan(CALL_MS);
  expect(numbers.longestCallMs).toBeLessThan(CALL_MS);
  expect(numbers.worstLateMs).toBeLessThan(LATE_MS);
}

describe("the loop's thread, in a process holding nothing but the job", () => {
  test("a real restore of a home's configuration, start to outcome: every call short, the timer on time", async () => {
    const at = rig();
    const numbers = await inChild({ ...at, entry: "real", windowMs: 10_000, untilOutcome: true });
    expect(numbers.outcome).toEqual({ kind: "restoreReady" });
    expect(numbers.wakes).toBe(1);
    loopKeptFree(numbers);
  });

  test("a worker held at its first piece of opening (a stand-in): the loop free all the while", async () => {
    const at = rig();
    const numbers = await inChild({ ...at, entry: "held.ts", windowMs: 1500 });
    expect(numbers.outcome).toBeNull();
    loopKeptFree(numbers);
  });

  test("a stand-in held 1.5 s before it builds: the loop free all the while", async () => {
    const numbers = await inChild({ ...rig(), entry: "holds.ts", windowMs: 1000 });
    expect(numbers.outcome).toBeNull();
    loopKeptFree(numbers);
  });
});

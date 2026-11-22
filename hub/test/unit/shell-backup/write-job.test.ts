/**
 * A backup with its file work on its worker thread (`shell/backup/write-job.ts`,
 * `write-serve.ts`), as the loop drives it: the same outcomes and the same folder as
 * `BackupPieces` on the thread, what the backup needs of `hub.db` read on the loop; a stop, with
 * the worker answering and not; a worker that does not start, throws or exits first; nothing
 * left behind.
 *
 * A worker stuck in two ways, each let go by the test: in a real file call, one of this hub's
 * older backups in the folder made a FIFO with no writer, whose header the pruning reads, so the
 * worker blocks in `open()` with the new backup in place (FIFOs are Linux's and macOS's); and on
 * every system, Windows too, a stand-in worker that writes as the real one but holds its thread in
 * a sealed piece's sync, the temporary file begun (`backup-workers/held.ts`).
 *
 * The loop's time (the job's constructor, which reads the configuration of a home's size from a
 * real database, and each `next()` within section 3's 20 ms, a 10 ms timer never 50 ms late) is
 * asserted in a child process holding nothing but the job (`backup-timing-child.ts`), for the
 * reason `shell-update`'s `stage-job.test.ts` gives.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appIdentityBytes, formatIdentity } from "@hsn/protocol/app";
import { sha256 } from "@noble/hashes/sha2.js";
import { err, ok } from "neverthrow";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { BackupJob } from "../../../src/shell/backup/write-job.ts";
import {
  BackupPieces,
  type BackupWork,
  backupTemporary,
  readBackup,
  type WriteDeps,
} from "../../../src/shell/backup/write.ts";
import type { OpenedStore } from "../../../src/shell/storage/store.ts";
import { type JobThreadEvents, startJobThread } from "../../../src/shell/safe/job-thread.ts";
import { jobControl } from "../../../src/shell/worker/control.ts";
import {
  STOP_WAIT_MS,
  type StartWorker,
  type WorkerJobOptions,
} from "../../../src/shell/worker/job.ts";
import type { KindData, WorkerData } from "../../../src/shell/worker/kinds.ts";
import type { BackupChildArgs, BackupChildNumbers } from "./backup-timing-child.ts";
import { backupHub, KEY, WALL } from "./backup-rig.ts";

/** A backup's worker data. */
type Written = KindData<"writeBackup">;

const POSIX = process.platform !== "win32";
const CHILD = join(import.meta.dir, "backup-timing-child.ts");
const root = mkdtempSync(join(tmpdir(), "hsn-write-job-"));
const writers: ReturnType<typeof Bun.spawn>[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const stores: OpenedStore[] = [];
/** The jobs this test made: each aborted after it, so that a failed test leaves no worker held. */
const opened: BackupJob[] = [];
/** The stuck backups this test made: each let go after it. */
const stuck: { readonly at: Rig; readonly way: StuckWay }[] = [];
let rigs = 0;

/** The longest a drive waits for the job's wake, and the most turns it may ask for one backup. */
const WAKE_WAIT_MS = 6000;
const MOST_TURNS = 20;
/** A home's configuration, about 180 KB ‡. */
const PEOPLE_KB = 180;
const DEPS: WriteDeps = { nowMs: () => WALL, salt: () => ok(new Uint8Array(8).fill(9)) };
const IDENTITY = formatIdentity(appIdentityBytes(sha256, new Uint8Array(32).fill(0x0a)));

setDefaultTimeout(60_000);

afterEach(async () => {
  for (const { at, way } of stuck.splice(0)) way.letGo(at);
  for (const job of opened.splice(0)) job.abort("the test is over");
  await Bun.sleep(50);
  for (const store of stores.splice(0)) store.db.close(true);
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

/** A hub's data folder and database, and a backup folder beside. */
interface Rig {
  readonly dataDir: string;
  readonly folder: string;
  readonly store: OpenedStore;
}

function rig(people = 20): Rig {
  const base = join(root, `rig-${(rigs += 1)}`);
  const dataDir = join(base, "data");
  const folder = join(base, "backups");
  mkdirSync(folder, { recursive: true });
  const store = backupHub(dataDir, people);
  stores.push(store);
  return { dataDir, folder, store };
}

function work(at: Rig, keep = 20, epoch = 1): BackupWork {
  return { folder: at.folder, keep, key: KEY, epoch };
}

/** `BackupPieces` on this thread, a piece after another: what the loop did before the worker. */
function onThread(at: Rig, backup: BackupWork, deps: WriteDeps = DEPS): FileOutcome {
  const pieces = new BackupPieces(at.store.db, backup, deps, at.dataDir);
  for (;;) {
    const outcome = pieces.next();
    if (outcome !== undefined) return outcome;
  }
}

/** The folder's files, by name, with their bytes. */
function files(folder: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(folder)) return found;
  for (const name of readdirSync(folder))
    found.set(name, readFileSync(join(folder, name)).toString("base64"));
  return found;
}

interface Drive {
  readonly job: BackupJob;
  wakes: number;
  /**
   * Runs turns as the loop does until the job ends: none while it waits, a wake asking for one.
   * A wake not come within `WAKE_WAIT_MS`, or more than `MOST_TURNS` turns, fails.
   */
  readonly end: () => Promise<FileOutcome>;
}

/** A job with a wake, driven as the loop drives it. */
function driven(
  at: Rig,
  backup: BackupWork,
  options: Omit<WorkerJobOptions<Written>, "wake"> = {},
  deps: WriteDeps = DEPS,
): Drive {
  let woken = Promise.withResolvers<undefined>();
  const drive: Drive = {
    job: new BackupJob(at.store.db, backup, deps, at.dataDir, {
      ...options,
      wake: () => {
        drive.wakes += 1;
        woken.resolve(undefined);
      },
    }),
    wakes: 0,
    end: async () => {
      for (let turns = 1; ; turns++) {
        expect(turns, "turns asked for one backup").toBeLessThanOrEqual(MOST_TURNS);
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
  (entry: string): StartWorker<Written> =>
  (data, events) =>
    startJobThread(data, events, new URL(`./backup-workers/${entry}`, import.meta.url));

/** No temporary file in the folder. */
function noTemporary(at: Rig): void {
  expect(readdirSync(at.folder).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

describe("a backup on its worker", () => {
  test("the same outcome and file as on the thread, byte for byte; one wake", async () => {
    const before = rig(PEOPLE_KB);
    const expected = onThread(before, work(before));
    expect(expected.kind).toBe("backupWritten");
    const after = rig(PEOPLE_KB);
    const drive = driven(after, work(after));
    expect(drive.job.waiting()).toBe(true);
    expect(await drive.end()).toEqual(expected);
    expect(drive.wakes).toBe(1);
    // The same time and salt seal the same bytes.
    expect(files(after.folder)).toEqual(files(before.folder));
    expect([...files(after.folder).keys()]).toEqual([`hsn-${IDENTITY}-20261121T030000000Z.hsnb`]);
  });

  test("pruning as on the thread: the newest `keep` kept, an older epoch's removed", async () => {
    const results: Map<string, string>[] = [];
    for (const way of ["thread", "worker"] as const) {
      const at = rig();
      for (let i = 0; i < 4; i++) {
        const deps: WriteDeps = { ...DEPS, nowMs: () => WALL + i * 60_000 };
        if (way === "thread") onThread(at, work(at, 3), deps);
        else await driven(at, work(at, 3), {}, deps).end();
      }
      const later: WriteDeps = { ...DEPS, nowMs: () => WALL + 10 * 60_000 };
      if (way === "thread") onThread(at, work(at, 3, 2), later);
      else
        expect(await driven(at, work(at, 3, 2), {}, later).end()).toMatchObject({
          kind: "backupWritten",
        });
      results.push(files(at.folder));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1]?.size).toBe(1);
  });

  test.each([
    {
      name: "an unreachable folder",
      // One path for both runs: the refusal names it.
      prepare: (at: Rig): BackupWork => ({ ...work(at), folder: join(root, "unplugged") }),
      deps: DEPS,
    },
    {
      name: "no salt to be had",
      prepare: (at: Rig): BackupWork => work(at),
      deps: { ...DEPS, salt: () => err("no randomness") },
    },
    {
      name: "a key the sealing refuses",
      prepare: (at: Rig): BackupWork => ({ ...work(at), key: new Uint8Array(5) }),
      deps: DEPS,
    },
  ])("refused as on the thread: $name, nothing left behind", async ({ prepare, deps }) => {
    const before = rig();
    const expected = onThread(before, prepare(before), deps);
    expect(expected.kind).toBe("failed");
    const after = rig();
    expect(await driven(after, prepare(after), {}, deps).end()).toEqual(expected);
    expect(readdirSync(after.folder)).toEqual([]);
  });

  test("a hub without its app key: refused as on the thread, the folder checked first", async () => {
    const at = rig();
    at.store.db.run("UPDATE hub_keys SET app_static_public = NULL");
    const expected = onThread(at, work(at));
    expect(expected).toMatchObject({ kind: "failed", message: "the hub has no app key yet" });
    expect(await driven(at, work(at)).end()).toEqual(expected);
    // An unreachable folder is told before the missing key, as on the thread.
    const gone = { ...work(at), folder: join(at.folder, "unplugged") };
    expect(onThread(at, gone)).toMatchObject({ reason: "unreachable" });
    expect(await driven(at, gone).end()).toMatchObject({ reason: "unreachable" });
  });

  test("the configuration read on the loop as the job starts; the worker given it as data", async () => {
    const at = rig();
    const given: WorkerData<Written>[] = [];
    let salts = 0;
    const deps: WriteDeps = {
      ...DEPS,
      salt: () => {
        salts += 1;
        return ok(new Uint8Array(8).fill(9));
      },
    };
    const drive = driven(
      at,
      work(at),
      {
        start: (data, events) => {
          given.push(data);
          return startJobThread(data, events);
        },
      },
      deps,
    );
    expect(salts).toBe(1);
    expect(given[0]?.read).toEqual(readBackup(at.store.db, 1, deps));
    expect(await drive.end()).toMatchObject({ kind: "backupWritten" });
    expect(salts).toBe(2);
  });

  test("without a wake the job never says it waits (the loop then turns for it)", async () => {
    const at = rig();
    const job = new BackupJob(at.store.db, work(at), DEPS, at.dataDir);
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
  readonly start: StartWorker<Written>;
  /** Until the worker is at its stuck point. */
  readonly reached: (at: Rig) => Promise<void>;
  /** Lets it go on, after `afterMs`. */
  readonly letGo: (at: Rig, afterMs?: number) => void;
  /** What a stop leaves in the folder once the worker has ended: the names. */
  readonly left: (at: Rig) => readonly string[];
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

/** One of this hub's backups, older than any a test writes: the pruning reads its header. */
const OLDER = `hsn-${IDENTITY}-20200101T000000000Z.hsnb`;
const NEW = `hsn-${IDENTITY}-20261121T030000000Z.hsnb`;

const FIFO: StuckWay = {
  rig: () => {
    const at = rig();
    expect(Bun.spawnSync(["mkfifo", join(at.folder, OLDER)]).exitCode).toBe(0);
    return at;
  },
  start: (data, events) => startJobThread(data, events),
  // The new backup in place: the pruning is at the FIFO.
  reached: async (at) => {
    await until(() => existsSync(join(at.folder, NEW)));
    await Bun.sleep(100);
  },
  letGo: (at, afterMs = 0) => {
    writeLater(join(at.folder, OLDER), "not a backup", afterMs);
  },
  // The stop came once the backup was in place: it stays, a whole backup, with the older one.
  left: () => [NEW, OLDER],
};

const HELD: StuckWay = {
  rig: () => rig(),
  start: startWith("held.ts"),
  reached: async (at) => {
    await until(() => readdirSync(at.folder).some((name) => name.endsWith(".tmp")));
    await Bun.sleep(50);
  },
  letGo: (at, afterMs = 0) => {
    writeLater(join(at.folder, "..", "go"), "", afterMs);
  },
  left: () => [],
};

const STUCK: readonly (readonly [string, StuckWay])[] = [
  ...(POSIX
    ? [["in a real file call (an older backup a FIFO, the new one in place)", FIFO] as const]
    : []),
  ["in a sealed piece's sync, the temporary file begun (a stand-in, on every system)", HELD],
];

function stuckRig(way: StuckWay): Rig {
  const at = way.rig();
  stuck.push({ at, way });
  return at;
}

describe.each(STUCK)("a worker stuck %s", (_name, way) => {
  test("a stop shorter than the worker's wait ends at its bound; let go, the worker removes what it wrote", async () => {
    const at = stuckRig(way);
    const drive = driven(at, work(at), { start: way.start, stopWaitMs: 300 });
    await way.reached(at);
    expect(drive.job.next()).toBeUndefined();
    expect(drive.job.waiting()).toBe(true);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    const took = performance.now() - start;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1000);
    expect(drive.wakes).toBe(0);
    way.letGo(at);
    await until(() => readdirSync(at.folder).every((name) => !name.endsWith(".tmp")));
    await Bun.sleep(100);
    expect(readdirSync(at.folder).toSorted()).toEqual([...way.left(at)].toSorted());
  });

  test("a stop waits for the worker, which ends: no outcome for the core, nothing half written", async () => {
    const at = stuckRig(way);
    const drive = driven(at, work(at), { start: way.start });
    await way.reached(at);
    way.letGo(at, 200);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(performance.now() - start).toBeLessThan(1500);
    noTemporary(at);
    expect(readdirSync(at.folder).toSorted()).toEqual([...way.left(at)].toSorted());
    expect(drive.wakes).toBe(0);
    expect(drive.job.next()).toEqual(STOPPED);
  });
});

describe("a worker held before it writes", () => {
  test("a stand-in held 1.5 s: waiting all the while, then the outcome", async () => {
    const at = rig();
    const drive = driven(at, work(at), { start: startWith("holds.ts") });
    await Bun.sleep(1000);
    expect(drive.job.waiting()).toBe(true);
    expect(drive.job.next()).toBeUndefined();
    expect(await drive.end()).toMatchObject({ kind: "backupWritten" });
  });

  test("a stop told during the hold: answered when it ends, within the bound, nothing written", async () => {
    const at = rig();
    const drive = driven(at, work(at), { start: startWith("holds.ts") });
    await Bun.sleep(300);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    const took = performance.now() - start;
    expect(took).toBeGreaterThan(500);
    expect(took).toBeLessThan(STOP_WAIT_MS);
    expect(readdirSync(at.folder)).toEqual([]);
  });
});

describe("a stop after the worker's outcome came, before the loop took it", () => {
  test("no outcome for the core; the backup stays in the folder, whole, a good backup", async () => {
    const before = rig();
    onThread(before, work(before));
    const at = rig();
    const drive = driven(at, work(at));
    await until(() => !drive.job.waiting());
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(drive.job.next()).toEqual(STOPPED);
    expect(files(at.folder)).toEqual(files(before.folder));
  });
});

describe("a worker that fails", () => {
  test("does not start: failed, saying so, nothing written", async () => {
    const at = rig();
    const drive = driven(at, work(at), { start: () => err("no thread for it") });
    expect(await drive.end()).toEqual({
      kind: "failed",
      reason: "io",
      message: "the backup worker did not start: no thread for it",
    });
    expect(readdirSync(at.folder)).toEqual([]);
  });

  test("whose entry Bun refuses at once (a bare name): failed, saying so, nothing written", async () => {
    const at = rig();
    const refused = (data: WorkerData<Written>, events: JobThreadEvents) =>
      startJobThread(data, events, "entry.ts");
    const said = refused(
      {
        kind: "writeBackup",
        read: readBackup(at.store.db, 1, DEPS),
        work: work(at),
        dataDir: at.dataDir,
        control: jobControl(),
      },
      { ended: () => undefined, failed: () => undefined, exited: () => undefined },
    );
    expect(said._unsafeUnwrapErr()).toContain("absolute path or a relative path");
    const outcome = await driven(at, work(at), { start: refused }).end();
    expect(outcome.kind === "failed" ? outcome.message : "").toStartWith(
      "the backup worker did not start: ",
    );
    expect(readdirSync(at.folder)).toEqual([]);
  });

  test.each([
    ["throws", "throws.ts", "JSON Parse error"],
    ["exits first", "exits.ts", "exit code 3"],
  ])(
    "%s, having written its temporary file: failed, saying so, the file removed",
    async (_name, entry, why) => {
      const at = rig();
      const temporary = backupTemporary(at.folder, readBackup(at.store.db, 1, DEPS));
      expect(temporary).toBeDefined();
      const outcome = await driven(at, work(at), { start: startWith(entry) }).end();
      expect(outcome).toMatchObject({ kind: "failed", reason: "io" });
      const message = outcome.kind === "failed" ? outcome.message : "";
      expect(message).toStartWith("the backup worker ended without an outcome: ");
      expect(message).toContain(why);
      expect(readdirSync(at.folder)).toEqual([]);
    },
  );
});

/** Runs `backup-timing-child.ts` with `args`: its numbers, once it ended on its own within 30 s. */
async function inChild(args: BackupChildArgs): Promise<BackupChildNumbers> {
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
  const numbers = JSON.parse((line ?? "").slice("TIMING ".length)) as BackupChildNumbers;
  console.log(`the loop's thread in the child: ${JSON.stringify(numbers)}`);
  return numbers;
}

/** Section 3's limit for one of the loop's calls ‡: the job's constructor, and each `next()`. */
const CALL_MS = 20;
/** How late the loop's 10 ms timer may come while the job is open. */
const LATE_MS = 50;

function loopKeptFree(numbers: BackupChildNumbers): void {
  expect(numbers.constructMs).toBeLessThan(CALL_MS);
  expect(numbers.longestCallMs).toBeLessThan(CALL_MS);
  expect(numbers.worstLateMs).toBeLessThan(LATE_MS);
}

/** A fresh data folder and backup folder for a child, which makes the database itself. */
function childFolders(): { readonly dataDir: string; readonly folder: string } {
  const base = join(root, `child-${(rigs += 1)}`);
  mkdirSync(join(base, "backups"), { recursive: true });
  return { dataDir: join(base, "data"), folder: join(base, "backups") };
}

describe("the loop's thread, in a process holding nothing but the job", () => {
  test("a real backup of a home's configuration, start to outcome: the constructor and every call short, the timer on time", async () => {
    const numbers = await inChild({
      ...childFolders(),
      peopleKb: PEOPLE_KB,
      entry: "real",
      windowMs: 10_000,
      untilOutcome: true,
    });
    expect(numbers.outcome?.kind).toBe("backupWritten");
    expect(numbers.wakes).toBe(1);
    loopKeptFree(numbers);
  });

  test("a worker stuck in a sealed piece's sync (a stand-in): the loop free all the while", async () => {
    const numbers = await inChild({
      ...childFolders(),
      peopleKb: PEOPLE_KB,
      entry: "held.ts",
      windowMs: 1500,
    });
    expect(numbers.temporarySeen).toBe(true);
    expect(numbers.outcome).toBeNull();
    loopKeptFree(numbers);
  });

  test("a stand-in held 1.5 s before it writes: the loop free all the while", async () => {
    const numbers = await inChild({
      ...childFolders(),
      peopleKb: PEOPLE_KB,
      entry: "holds.ts",
      windowMs: 1000,
    });
    expect(numbers.outcome).toBeNull();
    loopKeptFree(numbers);
  });
});

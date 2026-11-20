/**
 * Staging on its worker thread (`shell/update/stage-job.ts`, `stage-serve.ts`), as the loop drives
 * it: the same outcomes and the same staged folder as `Staging` on the thread; the loop's calls
 * short and the loop free while the worker is stuck; a cancel and a stop, with the worker
 * answering and not; a worker that does not start, throws or exits first; one staging at a time.
 *
 * A worker stuck with every file copied, its folder half made, in two ways, each let go by the
 * test: in a real file call, the program tree's launcher file made a FIFO with no writer, which
 * `Staging` opens at the end of its second pass (`#prepareRemoval`), so the worker blocks in
 * `open()` (FIFOs are Linux's and macOS's); and on every system, Windows too, a stand-in worker
 * that stages as the real one but holds its thread in that same read (`staging-workers/held.ts`).
 *
 * The drive's waits are bounded, so a job that never wakes the loop, or asks a turn when it has
 * nothing to do, fails by an assertion rather than hanging the file.
 */
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
import { join, relative } from "node:path";
import { err } from "neverthrow";
import { installPaths } from "../../../launcher/src/layout.ts";
import { releaseOfFiles } from "../../../packaging/shared/make-release.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import {
  startStagingThread,
  type StagingThreadEvents,
} from "../../../src/shell/safe/staging-thread.ts";
import { programName } from "../../../src/shell/update/program-name.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import { platformOf, type ReleasePlatform } from "../../../src/shell/update/release.ts";
import { Staging, type StageInputs } from "../../../src/shell/update/stage.ts";
import { stagingControl, type StagingWorkerData } from "../../../src/shell/update/stage-serve.ts";
import {
  CANCELLED,
  STOP_WAIT_MS,
  StagingJob,
  type StagingJobOptions,
  stagingBusy,
} from "../../../src/shell/update/stage-job.ts";

const HERE: ReleasePlatform = platformOf(process.platform, process.arch) ?? "linux-x64";
const OTHER: ReleasePlatform = HERE === "linux-x64" ? "darwin-arm64" : "linux-x64";
const POSIX = process.platform !== "win32";
const SEED = new Uint8Array(32).fill(7);
const root = mkdtempSync(join(tmpdir(), "hsn-stage-job-"));
const writers: ReturnType<typeof Bun.spawn>[] = [];
/** The stuck stagings this test made: each let go after it, so that none stays stuck for the next. */
const stuckTrees: { readonly prefix: string; readonly way: StuckWay }[] = [];
let trees = 0;

/** The jobs this test made: each aborted after it, so that a failed test holds no staging open. */
const opened: StagingJob[] = [];

/** The longest a drive waits for the job's wake, and the most turns it may ask for one staging. */
const WAKE_WAIT_MS = 6000;
const MOST_TURNS = 20;

setDefaultTimeout(60_000);

afterEach(async () => {
  for (const { prefix, way } of stuckTrees.splice(0)) way.letGo(prefix);
  for (const job of opened.splice(0)) job.abort("the test is over");
  // Every test leaves no staging running for the next: the gate is the process's.
  await until(() => !stagingBusy(), 20_000);
});

afterAll(() => {
  for (const writer of writers) writer.kill(9);
  rmSync(root, { recursive: true, force: true });
});

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    expect(performance.now()).toBeLessThan(end);
    await Bun.sleep(5);
  }
}

const LAUNCHER_STATE = JSON.stringify({
  current: "0.1.0",
  previous: null,
  trial: null,
  rolledBack: null,
});

/** The program tree the launcher would have made, running 0.1.0; its launcher file a FIFO if asked. */
function programTree(fifo = false): string {
  const prefix = join(root, `tree-${(trees += 1)}`);
  mkdirSync(join(prefix, "staged", "0.1.0", "bin"), { recursive: true });
  mkdirSync(join(prefix, "state"), { recursive: true });
  const launcher = installPaths(prefix).launcherFile;
  if (fifo) expect(Bun.spawnSync(["mkfifo", launcher]).exitCode).toBe(0);
  else writeFileSync(launcher, LAUNCHER_STATE);
  return prefix;
}

/**
 * Writes `data` to `path` after `afterMs`, from another process: this thread may be in a stop's
 * wait then. A FIFO's writer lets the worker opening it go on.
 */
function writeLater(path: string, data: string, afterMs: number): void {
  writers.push(
    Bun.spawn([
      process.execPath,
      "-e",
      `await Bun.sleep(${afterMs}); require("node:fs").writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(data)});`,
    ]),
  );
}

/** A way to have the worker stuck with every file copied, and to let it go on. */
interface StuckWay {
  /** A program tree whose staging will be stuck. */
  readonly tree: () => string;
  readonly start: typeof startStagingThread;
  /** Lets it go on, after `afterMs`. */
  readonly letGo: (prefix: string, afterMs?: number) => void;
}

const FIFO: StuckWay = {
  tree: () => programTree(true),
  start: (data, events) => startStagingThread(data, events),
  letGo: (prefix, afterMs = 0) => {
    writeLater(installPaths(prefix).launcherFile, LAUNCHER_STATE, afterMs);
  },
};

const HELD: StuckWay = {
  tree: () => programTree(),
  start: (data, events) =>
    startStagingThread(data, events, new URL("./staging-workers/held.ts", import.meta.url)),
  letGo: (prefix, afterMs = 0) => {
    writeLater(`${installPaths(prefix).launcherFile}.go`, "", afterMs);
  },
};

const STUCK: readonly (readonly [string, StuckWay])[] = [
  ...(POSIX ? [["in a real file call (its launcher file a FIFO)", FIFO] as const] : []),
  ["held in its read of the launcher file (a stand-in, on every system)", HELD],
];

/** A program tree whose staging `way` will be stuck in, let go after the test at the latest. */
function stuckTree(way: StuckWay): string {
  const prefix = way.tree();
  stuckTrees.push({ prefix, way });
  return prefix;
}

const text = (s: string) => new TextEncoder().encode(s);
const FILES: readonly (readonly [string, Uint8Array])[] = [
  [`bin/${programName(HERE)}`, text("a program\n".repeat(100_000))],
  ["drizzle/0000.sql", text("CREATE TABLE x (a);")],
  ...Array.from(
    { length: 40 },
    (_, i) => [`web/f${i}.js`, text(`export const x${i} = 1;\n`)] as const,
  ),
];
/** The last file pass 2 writes: once it is there, the worker is at the launcher file. */
const LAST = "web/f9.js";

/** A release of `FILES`: for this computer, version 9.0.0, signed with the tests' key, unless told. */
function release(
  options: {
    version?: string;
    platform?: ReleasePlatform;
    seed?: Uint8Array;
    spoil?: boolean;
  } = {},
): string {
  const entries = FILES.map(([path, data]) => ({
    path,
    data,
    executable: path.startsWith("bin/"),
  }));
  const bytes = releaseOfFiles(
    entries.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    options.version ?? "9.0.0",
    options.platform ?? HERE,
    options.seed ?? SEED,
    0,
  )._unsafeUnwrap();
  if (options.spoil === true) bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  const path = join(root, `release-${(trees += 1)}.hsnr`);
  writeFileSync(path, bytes);
  return path;
}

function inputs(path: string, prefix: string | undefined, wanted?: () => boolean): StageInputs {
  return {
    path,
    prefix,
    runningVersion: "0.1.0",
    platform: HERE,
    keys: [TEST_PUBLISHER_KEY],
    ...(wanted === undefined ? {} : { wanted }),
  };
}

/** `Staging` on this thread, a piece after another: what the loop did before the worker. */
function onThread(stageInputs: StageInputs): FileOutcome {
  const job = new Staging(stageInputs);
  for (;;) {
    const outcome = job.next();
    if (outcome !== undefined) return outcome;
  }
}

interface Drive {
  readonly job: StagingJob;
  /** How long each of the loop's `next()` calls took, in ms. */
  readonly calls: number[];
  wakes: number;
  /**
   * Runs turns as the loop does until the job ends: none while it waits, a wake asking for one.
   * A wake not come within `WAKE_WAIT_MS`, or more than `MOST_TURNS` turns, fails.
   */
  readonly end: (each?: () => void) => Promise<FileOutcome>;
}

/** A job with a wake, driven as the loop drives it. */
function driven(stageInputs: StageInputs, options: Omit<StagingJobOptions, "wake"> = {}): Drive {
  let woken = Promise.withResolvers<undefined>();
  const drive: Drive = {
    job: new StagingJob(stageInputs, {
      ...options,
      wake: () => {
        drive.wakes += 1;
        woken.resolve(undefined);
      },
    }),
    calls: [],
    wakes: 0,
    end: async (each) => {
      for (let turns = 1; ; turns++) {
        expect(turns, "turns asked for one staging").toBeLessThanOrEqual(MOST_TURNS);
        const start = performance.now();
        const outcome = drive.job.next();
        drive.calls.push(performance.now() - start);
        if (outcome !== undefined) return outcome;
        each?.();
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

/** Every file below `folder`, by its path, with its bytes. */
function tree(folder: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(relative(folder, path), readFileSync(path).toString("base64"));
    }
  return files;
}

/** A thread's gaps: a 10 ms timer's lateness, in ms, while `ms` pass. */
async function lateness(ms: number, each: () => void): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const end = last + ms;
  while (performance.now() < end) {
    await Bun.sleep(10);
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
    each();
  }
  return worst;
}

const startWith =
  (entry: string): typeof startStagingThread =>
  (data, events) =>
    startStagingThread(data, events, new URL(`./staging-workers/${entry}`, import.meta.url));

describe("staging on its worker", () => {
  test("the same outcome and folder as Staging on the thread; the loop's calls short; one wake", async () => {
    const path = release();
    const before = programTree();
    expect(onThread(inputs(path, before))).toEqual({ kind: "updateStaged", version: "9.0.0" });
    const after = programTree();
    const drive = driven(inputs(path, after));
    expect(drive.job.waiting()).toBe(true);
    expect(await drive.end()).toEqual({ kind: "updateStaged", version: "9.0.0" });
    expect(drive.wakes).toBe(1);
    expect(drive.job.waiting()).toBe(false);
    expect(tree(join(after, "staged"))).toEqual(tree(join(before, "staged")));
    expect(readdirSync(join(after, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
    expect(Math.max(...drive.calls)).toBeLessThan(5);
  });

  test.each([
    ["badFile", { spoil: true }],
    ["badSignature", { seed: new Uint8Array(32).fill(8) }],
    ["wrongSystem", { platform: OTHER }],
    ["notNewer", { version: "0.0.9" }],
  ] as const)("refused %s as on the thread, nothing left behind", async (reason, options) => {
    const path = release(options);
    const before = onThread(inputs(path, programTree()));
    expect(before).toMatchObject({ kind: "failed", reason });
    const prefix = programTree();
    expect(await driven(inputs(path, prefix)).end()).toEqual(before);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });

  test("no program tree (a hub the launcher did not start): io, as on the thread", async () => {
    const path = release();
    const before = onThread(inputs(path, undefined));
    expect(before).toMatchObject({ kind: "failed", reason: "io" });
    expect(await driven(inputs(path, undefined)).end()).toEqual(before);
  });

  test("without a wake the job never says it waits (the loop then turns for it)", async () => {
    const job = new StagingJob(inputs(release(), programTree()));
    opened.push(job);
    expect(job.waiting()).toBe(false);
    for (;;) {
      if (job.next() !== undefined) break;
      await Bun.sleep(1);
    }
  });
});

const CANCELLED_OUTCOME = { kind: "failed", reason: "io", message: CANCELLED } as const;
const STOPPED = { kind: "failed", reason: "io", message: "the hub is stopping" } as const;

/** A staging that counts its worker's starts. */
function counted(starts: number[], start: typeof startStagingThread = startStagingThread) {
  return {
    start: ((data, events) => {
      starts.push(performance.now());
      return start(data, events);
    }) satisfies typeof startStagingThread,
  };
}

describe.each(STUCK)("a worker stuck with every file copied, %s", (_name, way) => {
  const folderOf = (prefix: string) => join(installPaths(prefix).staged, ".staging-9.0.0");
  const stuck = async (prefix: string) => {
    await until(() => existsSync(join(folderOf(prefix), LAST)));
    await Bun.sleep(50);
  };

  test("the loop's calls short and its timers on time; a stop shorter than the worker's wait ends at its bound; the gate shut until the worker ends", async () => {
    const prefix = stuckTree(way);
    const drive = driven(inputs(release(), prefix), { start: way.start, stopWaitMs: 300 });
    await stuck(prefix);
    // For half a second the loop takes a turn every 10 ms.
    const late = await lateness(500, () => {
      const start = performance.now();
      expect(drive.job.next()).toBeUndefined();
      drive.calls.push(performance.now() - start);
    });
    expect(drive.job.waiting()).toBe(true);
    expect(Math.max(...drive.calls)).toBeLessThan(5);
    expect(late).toBeLessThan(50);
    // The worker cannot answer: the stop waits its bound, then gives up waiting.
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    const took = performance.now() - start;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1000);
    expect(drive.wakes).toBe(0);
    // Its thread still alive, the gate stays shut; let go, it sees the stop and removes its folder.
    expect(stagingBusy()).toBe(true);
    way.letGo(prefix);
    await until(() => !stagingBusy());
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });

  test("a stop waits for the worker, which removes its folder: nothing left, no outcome for the core", async () => {
    const prefix = stuckTree(way);
    const drive = driven(inputs(release(), prefix), { start: way.start });
    await stuck(prefix);
    way.letGo(prefix, 200);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    // Within its bound: the worker answered once let go.
    expect(performance.now() - start).toBeLessThan(1500);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
    expect(drive.wakes).toBe(0);
    expect(drive.job.next()).toEqual(STOPPED);
    await until(() => !stagingBusy());
  });

  test("a cancel, the worker answering once let go: its folder removed, the job ends cancelled", async () => {
    const prefix = stuckTree(way);
    let wanted = true;
    const drive = driven(
      inputs(release(), prefix, () => wanted),
      { start: way.start },
    );
    await stuck(prefix);
    wanted = false;
    expect(drive.job.next()).toBeUndefined();
    expect(drive.job.waiting()).toBe(true);
    way.letGo(prefix, 100);
    expect(await drive.end()).toEqual(CANCELLED_OUTCOME);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });

  test("a cancel, the worker not answering within its bound: its folder removed off the loop, cancelled; the next staging waits until the worker's thread ends", async () => {
    const prefix = stuckTree(way);
    let wanted = true;
    const drive = driven(
      inputs(release(), prefix, () => wanted),
      {
        start: way.start,
        cancelWaitMs: 300,
      },
    );
    await stuck(prefix);
    wanted = false;
    const start = performance.now();
    expect(await drive.end()).toEqual(CANCELLED_OUTCOME);
    expect(performance.now() - start).toBeGreaterThanOrEqual(290);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
    expect(Math.max(...drive.calls)).toBeLessThan(5);
    // The job is over, its worker still stuck: the gate stays shut, and a second staging waits.
    expect(stagingBusy()).toBe(true);
    const starts: number[] = [];
    const next = programTree();
    const second = driven(inputs(release(), next), counted(starts));
    await Bun.sleep(300);
    expect(starts).toEqual([]);
    expect(stagingBusy()).toBe(true);
    // Let go, the worker sees the cancel and ends; then the second starts, and stages.
    way.letGo(prefix);
    expect(await second.end()).toEqual({ kind: "updateStaged", version: "9.0.0" });
    expect(starts).toHaveLength(1);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
    expect(readdirSync(join(next, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
  });
});

describe("a worker held before it stages", () => {
  test("a stand-in held 1.5 s: the loop free all the while, then the outcome", async () => {
    const prefix = programTree();
    const drive = driven(inputs(release(), prefix), { start: startWith("holds.ts") });
    const late = await lateness(1000, () => {
      const start = performance.now();
      expect(drive.job.next()).toBeUndefined();
      drive.calls.push(performance.now() - start);
    });
    expect(late).toBeLessThan(50);
    expect(Math.max(...drive.calls)).toBeLessThan(5);
    expect(await drive.end()).toEqual({ kind: "updateStaged", version: "9.0.0" });
  });

  test("a stop told during the hold: answered when it ends, within the bound, nothing written", async () => {
    const prefix = programTree();
    const drive = driven(inputs(release(), prefix), { start: startWith("holds.ts") });
    await Bun.sleep(300);
    const start = performance.now();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    const took = performance.now() - start;
    // The hold's 1.5 s, less the 300 ms before the stop, and the worker's start.
    expect(took).toBeGreaterThan(500);
    expect(took).toBeLessThan(STOP_WAIT_MS);
    expect(stagingBusy()).toBe(true);
    await until(() => !stagingBusy());
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });

  test("a cancel told during the hold: answered when it ends, cancelled, nothing written", async () => {
    const prefix = programTree();
    let wanted = true;
    const drive = driven(
      inputs(release(), prefix, () => wanted),
      {
        start: startWith("holds.ts"),
      },
    );
    await Bun.sleep(300);
    wanted = false;
    const start = performance.now();
    expect(await drive.end()).toEqual(CANCELLED_OUTCOME);
    expect(performance.now() - start).toBeGreaterThan(500);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });
});

describe("a stop", () => {
  test("after the worker's outcome came, before the loop took it: no outcome for the core; the next staging removes the version", async () => {
    const prefix = programTree();
    const drive = driven(inputs(release(), prefix));
    await until(() => !drive.job.waiting());
    expect(readdirSync(join(prefix, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(drive.job.next()).toEqual(STOPPED);
    await until(() => !stagingBusy());
    // The core never heard of 9.0.0: the next staging removes it as any version but the current.
    const again = driven(inputs(release({ version: "9.0.1" }), prefix));
    expect(await again.end()).toEqual({ kind: "updateStaged", version: "9.0.1" });
    expect(readdirSync(join(prefix, "staged")).toSorted()).toEqual(["0.1.0", "9.0.1"]);
  });

  test("of a staging still waiting for an earlier one: nothing started, nothing waited for", async () => {
    const first = driven(inputs(release(), programTree()), { start: startWith("holds.ts") });
    const queuedStarts: number[] = [];
    const second = driven(inputs(release(), programTree()), counted(queuedStarts));
    const start = performance.now();
    expect(second.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(performance.now() - start).toBeLessThan(50);
    expect(await first.end()).toEqual({ kind: "updateStaged", version: "9.0.0" });
    await until(() => !stagingBusy());
    expect(queuedStarts).toEqual([]);
  });
});

describe("a cancel (the core no longer wants it)", () => {
  test("after the worker had put the version in place: removed while the job waits, and it ends cancelled", async () => {
    const prefix = programTree();
    let wanted = true;
    const drive = driven(inputs(release(), prefix, () => wanted));
    // The worker's outcome has come, not yet taken, when the core stops wanting it.
    await until(() => !drive.job.waiting());
    expect(readdirSync(join(prefix, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
    wanted = false;
    // The removal runs off the loop; the job waits for it, asking no turn.
    expect(drive.job.next()).toBeUndefined();
    expect(drive.job.waiting()).toBe(true);
    expect(await drive.end()).toEqual(CANCELLED_OUTCOME);
    expect(drive.wakes).toBe(2);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });

  test("a stop while that version is being removed: the gate shut until the removal is done", async () => {
    const prefix = programTree();
    let wanted = true;
    let exited = false;
    const drive = driven(
      inputs(release(), prefix, () => wanted),
      {
        start: (data, events) =>
          startStagingThread(data, {
            ...events,
            exited: () => {
              exited = true;
              events.exited();
            },
          }),
      },
    );
    // The outcome came and the worker's thread is gone: only the removal can hold the gate.
    await until(() => exited);
    wanted = false;
    expect(drive.job.next()).toBeUndefined();
    expect(drive.job.abort("the hub is stopping")).toEqual(STOPPED);
    expect(stagingBusy()).toBe(true);
    await until(() => !stagingBusy());
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });

  test("a refusal that came when the core no longer wanted it: cancelled too, as any outcome", async () => {
    const prefix = programTree();
    let wanted = true;
    const drive = driven(inputs(release({ spoil: true }), prefix, () => wanted));
    await until(() => !drive.job.waiting());
    wanted = false;
    expect(await drive.end()).toEqual(CANCELLED_OUTCOME);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });

  test("of a staging still waiting for an earlier one: cancelled at once, nothing started then or after", async () => {
    const first = driven(inputs(release(), programTree()), { start: startWith("holds.ts") });
    let wanted = true;
    const queuedStarts: number[] = [];
    const second = driven(
      inputs(release(), programTree(), () => wanted),
      counted(queuedStarts),
    );
    expect(second.job.next()).toBeUndefined();
    wanted = false;
    expect(second.job.next()).toEqual(CANCELLED_OUTCOME);
    expect(await first.end()).toEqual({ kind: "updateStaged", version: "9.0.0" });
    await until(() => !stagingBusy());
    expect(queuedStarts).toEqual([]);
  });
});

describe("a worker that fails", () => {
  test("does not start: failed, saying so, nothing written; the next staging is not held up", async () => {
    const prefix = programTree();
    const drive = driven(inputs(release(), prefix), { start: () => err("no thread for it") });
    expect(await drive.end()).toEqual({
      kind: "failed",
      reason: "io",
      message: "the staging worker did not start: no thread for it",
    });
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
    await until(() => !stagingBusy());
    expect(await driven(inputs(release(), programTree())).end()).toMatchObject({
      kind: "updateStaged",
    });
  });

  test("whose entry Bun refuses at once (a bare name): failed, saying so, nothing written", async () => {
    const prefix = programTree();
    const refused = (data: StagingWorkerData, events: StagingThreadEvents) =>
      startStagingThread(data, events, "stage-worker.ts");
    const said = refused(
      { inputs: inputs(release(), prefix), control: stagingControl() },
      { ended: () => undefined, failed: () => undefined, exited: () => undefined },
    );
    expect(said._unsafeUnwrapErr()).toContain("absolute path or a relative path");
    const drive = driven(inputs(release(), prefix), { start: refused });
    const outcome = await drive.end();
    expect(outcome).toMatchObject({ kind: "failed", reason: "io" });
    expect(outcome.kind === "failed" ? outcome.message : "").toStartWith(
      "the staging worker did not start: ",
    );
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });

  test("whose entry is not there: failed, saying so", async () => {
    const drive = driven(inputs(release(), programTree()), { start: startWith("missing.ts") });
    const outcome = await drive.end();
    expect(outcome).toMatchObject({ kind: "failed", reason: "io" });
    expect(outcome.kind === "failed" ? outcome.message : "").toStartWith(
      "the staging worker ended without an outcome: ",
    );
  });

  test.each([
    ["throws", "throws.ts", "JSON Parse error"],
    ["exits first", "exits.ts", "exit code 3"],
  ])("%s, having written: failed, saying so, what it wrote removed", async (_name, entry, why) => {
    const prefix = programTree();
    const drive = driven(inputs(release(), prefix), { start: startWith(entry) });
    const outcome = await drive.end();
    expect(outcome).toMatchObject({ kind: "failed", reason: "io" });
    expect(outcome.kind === "failed" ? outcome.message : "").toStartWith(
      "the staging worker ended without an outcome: ",
    );
    expect(outcome.kind === "failed" ? outcome.message : "").toContain(why);
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
  });
});

describe("one staging at a time", () => {
  test("a second waits for the first to be over, then stages", async () => {
    const first = driven(inputs(release(), programTree()), { start: startWith("holds.ts") });
    const started: number[] = [];
    const prefix = programTree();
    const second = driven(inputs(release(), prefix), {
      start: (data, events) => {
        started.push(performance.now());
        return startStagingThread(data, events);
      },
    });
    expect(second.job.waiting()).toBe(true);
    expect(started).toEqual([]);
    const firstEnded = first.end();
    expect(await second.end()).toEqual({ kind: "updateStaged", version: "9.0.0" });
    expect(await firstEnded).toEqual({ kind: "updateStaged", version: "9.0.0" });
    expect(started).toHaveLength(1);
    expect(readdirSync(join(prefix, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
  });

  test("a second waits at most its bound: failed, saying so, nothing written", async () => {
    const first = driven(inputs(release(), programTree()), { start: startWith("holds.ts") });
    const prefix = programTree();
    const second = driven(inputs(release(), prefix), { queueWaitMs: 200 });
    expect(await second.end()).toEqual({
      kind: "failed",
      reason: "io",
      message: "an earlier staging has not yet ended",
    });
    expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
    expect(await first.end()).toMatchObject({ kind: "updateStaged" });
  });
});

/**
 * Staging in pieces between the loop's turns (the reviewer's decision of step 1, wave 2), on a
 * release of realistic size (a 112 MB program, as section 3 has it for Linux arm64): run as the
 * loop is asked to run it (`startJob`'s comment: inputs first, then one piece, then another turn),
 * with door reports arriving on a timer all the while. Each piece's work is bounded by what it
 * reads and makes (at most `STAGING_PIECE_BYTES` ‡ of the release, at most
 * `STAGING_FILES_PER_PIECE` ‡ files), which is what the ordinary run asserts; the result is byte
 * for byte the version's folder, and a stop or a cancel half-way, in either pass, leaves nothing
 * behind.
 *
 * Wall time depends on what else the machine does, so the ordinary run asserts only a bound
 * generous enough for a loaded machine (`LOADED_BOUND_MS`), which catches a piece doing far more
 * than its bytes, never a busy neighbour. The tight figures, the 20 ms ‡ of section 3 and a door
 * report's wait, are measured and asserted by the opt-in timing test (`HSN_TIMING=1`), run alone.
 *
 * On Windows the ordinary run times each file call. On the hosted Windows runners a create that
 * gives a folder's index a new block (the 8th file of `web/`, then every 21st from the 42nd) can
 * wait half a second with the thread doing nothing; the hosted policy (`hosted-timing.ts`) lets
 * such a piece pass, saying so, only if the wait is in a create and the rest of the piece is
 * within the bound. The tests after the ordinary run stage with one piece made to misbehave, and
 * show what still fails, on a hosted runner and off one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
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
import { basename, join, relative, sep } from "node:path";
import { ResultAsync } from "neverthrow";
import { releaseOf } from "../../../packaging/shared/make-release.ts";
import { installPaths } from "../../../launcher/src/layout.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import {
  STAGING_FILES_PER_PIECE,
  STAGING_PIECE_BYTES,
  Staging,
} from "../../../src/shell/update/stage.ts";

import {
  type FileCall,
  HOSTED_TIMING,
  retryHostedTiming,
  timePiece,
  type TimingMiss,
} from "../../world/hosted-timing.ts";

/** Section 3's limit for one piece ‡: asserted only by the opt-in timing test. */
const PIECE_BOUND_MS = 20;
/** A bound for a loaded machine (the whole suite at once): a piece reading far more than its bytes. */
const LOADED_BOUND_MS = 250;
const TIMING = process.env.HSN_TIMING === "1";
const fixturePlatform = process.platform === "win32" ? "windows-x64" : "darwin-arm64";
const programPath = process.platform === "win32" ? "bin/hsn-hub.exe" : "bin/hsn-hub";
const SEED = new Uint8Array(32).fill(7);
const folders: string[] = [];
let root: string;
let upload: string;
let source: string;
let restoreFileCalls: (() => void) | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hsn-pieces-"));
  folders.push(root);
  source = join(root, "source");
  mkdirSync(join(source, "bin"), { recursive: true });
  mkdirSync(join(source, "web"), { recursive: true });
  mkdirSync(join(source, "drizzle"), { recursive: true });
  const bun = readFileSync(process.execPath);
  // A 112 MB program: the Bun runtime and a mirrored copy of its first 48 MB, as compressible.
  writeFileSync(
    join(source, programPath),
    Buffer.concat([bun, Buffer.from(bun.subarray(0, 48 * 1024 * 1024)).reverse()]),
    { mode: 0o755 },
  );
  for (let i = 0; i < 200; i++)
    writeFileSync(join(source, "web", `f${i}.js`), `export const x${i} = 1;\n`.repeat(1250));
  writeFileSync(join(source, "drizzle", "0000.sql"), "CREATE TABLE x (a);");
  upload = join(root, "upload.hsnr");
  writeFileSync(upload, releaseOf(source, "9.0.0", fixturePlatform, SEED, 0)._unsafeUnwrap());
}, 60_000);

afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

afterEach(() => {
  restoreFileCalls?.();
  restoreFileCalls = undefined;
});

/** One call to delay, as the hosted disk delays a create: its name, its path below the folder. */
interface Delay {
  readonly name: "openSync" | "mkdirSync";
  readonly path: string;
  readonly ms: number;
  /** How many such calls to let through first. */
  readonly skip?: number;
}

/**
 * Times the real filesystem calls so a slow piece can be traced to an individual operation, each
 * with what it was called on (a path below `under`, or a file's name), and whether it made a file
 * (`openSync` with `wx`, as pass 2 makes each one). `delay` makes one call of that name on that
 * path (the first after `skip` of them) wait so long inside the call.
 */
function timeFileCalls(under: string, delay?: Delay) {
  const names = ["openSync", "readSync", "writeSync", "closeSync", "mkdirSync"] as const;
  interface Call {
    name: (typeof names)[number];
    ms: number;
    path: string;
    create: boolean;
  }
  let calls: Call[] = [];
  let matching = 0;
  const opened = new Map<number, string>();
  const named = (path: string) => {
    const below = relative(under, path);
    return below.startsWith("..") ? basename(path) : below.split(sep).join("/");
  };
  const spies = names.map((name) => {
    const original = fs[name];
    return spyOn(fs, name).mockImplementation((...args: Parameters<typeof original>) => {
      const [target, flags] = args;
      const path =
        typeof target === "string"
          ? named(target)
          : typeof target === "number"
            ? (opened.get(target) ?? "?")
            : "?";
      const start = performance.now();
      if (delay?.name === name && delay.path === path && matching++ === (delay.skip ?? 0))
        Bun.sleepSync(delay.ms);
      const value = Reflect.apply(original, fs, args) as ReturnType<typeof original>;
      const ms = performance.now() - start;
      if (name === "openSync" && typeof value === "number") opened.set(value, path);
      calls.push({ name, ms, path, create: name === "openSync" && flags === "wx" });
      return value;
    });
  });
  restoreFileCalls = () => {
    for (const spy of spies) spy.mockRestore();
  };
  /** Collects one piece's timings and drops the spies' references to its buffers. */
  return () => {
    const piece = calls;
    calls = [];
    for (const spy of spies) spy.mockClear();
    return piece;
  };
}

/** The piece's longest file call, for the hosted policy. */
function longestCall(
  calls: ReturnType<ReturnType<typeof timeFileCalls>> | undefined,
): FileCall | undefined {
  let longest: FileCall | undefined;
  for (const call of calls ?? []) if (call.ms > (longest?.ms ?? -1)) longest = call;
  return longest;
}

function prefix(name: string): string {
  const p = join(root, name);
  mkdirSync(join(p, "staged", "0.1.0", "bin"), { recursive: true });
  mkdirSync(join(p, "staged", "0.0.9", "bin"), { recursive: true });
  mkdirSync(join(p, "state"), { recursive: true });
  writeFileSync(
    installPaths(p).launcherFile,
    JSON.stringify({ current: "0.1.0", previous: "0.0.9", trial: null, rolledBack: null }),
  );
  return p;
}

function staging(p: string, wanted: () => boolean = () => true): Staging {
  return new Staging({
    path: upload,
    prefix: p,
    runningVersion: "0.1.0",
    platform: fixturePlatform,
    keys: [TEST_PUBLISHER_KEY],
    wanted,
  });
}

/** What a test makes one staging do beyond its real work, to show what the ordinary run catches. */
interface Misbehaviour {
  /** The folder's name, so that tests do not share one. */
  readonly name: string;
  /** Times the file calls (and thread CPU) even off Windows. */
  readonly timeCalls?: boolean;
  /** Runs inside each timed piece, after its real work. */
  readonly after?: (piece: {
    index: number;
    phase: Staging["phase"];
    job: Staging;
    folder: string;
  }) => void;
  /** Makes one file call wait so long inside it. */
  readonly delay?: Delay;
}

/** Reads the assertion error from a failed staging, or undefined if it passed. */
async function failureOf(run: Promise<void>): Promise<string | undefined> {
  const result = await ResultAsync.fromPromise(run, (reason: unknown) => reason);
  return result.isErr() ? String(result.error) : undefined;
}

/** Spends at least `ms` of this thread's processor time. */
function spin(ms: number): void {
  const start = process.threadCpuUsage();
  for (;;) {
    const used = process.threadCpuUsage(start);
    if ((used.user + used.system) / 1000 >= ms) return;
  }
}

describe("staging a 112 MB program in pieces", () => {
  /** Stages a fresh release and checks its work, leaving wall timing to the hosted policy. */
  function boundedPieces(attempt: number, misbehaviour?: Misbehaviour) {
    const p = prefix(`${misbehaviour?.name ?? "bytes"}-${attempt}`);
    const job = staging(p);
    const folder = join(p, "staged", ".staging-9.0.0");
    const fileCalls =
      process.platform === "win32" || TIMING || misbehaviour?.timeCalls === true
        ? timeFileCalls(folder, misbehaviour?.delay)
        : undefined;
    const misses: TimingMiss[] = [];
    let read = 0;
    let longest: {
      phase: Staging["phase"];
      ms: number;
      bytes: number;
      read: number;
      cpuMs?: number;
      calls?: ReturnType<ReturnType<typeof timeFileCalls>>;
    } = {
      phase: job.phase,
      ms: 0,
      bytes: 0,
      read: 0,
    };
    let pieces = 0;
    let madeBefore = 0;
    let outcome;
    for (;;) {
      const phase = job.phase;
      const index = pieces;
      const {
        value,
        wallMs: ms,
        cpuMs,
      } = timePiece(
        () => {
          const ended = job.next();
          misbehaviour?.after?.({ index, phase, job, folder });
          return ended;
        },
        HOSTED_TIMING || fileCalls !== undefined,
      );
      outcome = value;
      const calls = fileCalls?.();
      if (ms >= LOADED_BOUND_MS) {
        const call = longestCall(calls);
        misses.push({
          label: phase,
          wallMs: ms,
          cpuMs,
          limitMs: LOADED_BOUND_MS,
          ...(call === undefined ? {} : { call }),
        });
      }
      if (ms > longest.ms) {
        longest = {
          phase,
          ms,
          bytes: job.bytesRead - read,
          read,
          ...(Number.isFinite(cpuMs) ? { cpuMs } : {}),
          ...(calls === undefined ? {} : { calls }),
        };
      }
      pieces += 1;
      expect(job.bytesRead - read).toBeLessThanOrEqual(STAGING_PIECE_BYTES);
      read = job.bytesRead;
      if (phase === "copy" && job.phase === "copy") {
        const made = readdirSync(folder, { recursive: true }).length;
        expect(made - madeBefore).toBeLessThanOrEqual(STAGING_FILES_PER_PIECE + 3);
        madeBefore = made;
      }
      if (outcome !== undefined) break;
    }
    expect(outcome).toEqual({ kind: "updateStaged", version: "9.0.0" });
    // The whole payload read twice (hash, then copy), so at least that many pieces.
    const payload = readFileSync(upload).length;
    expect(read).toBeGreaterThan(2 * (payload - 1024 * 1024));
    expect(pieces).toBeGreaterThanOrEqual(
      2 * Math.floor((payload - 1024 * 1024) / STAGING_PIECE_BYTES),
    );
    const diagnostics = `longest piece: ${JSON.stringify({ ...longest, payloadBytes: read / 2 })}`;
    if (fileCalls !== undefined) console.log(diagnostics);
    for (const path of [programPath, "web/f0.js", "web/f199.js", "drizzle/0000.sql"])
      expect(
        Buffer.from(readFileSync(join(p, "staged", "9.0.0", path))).equals(
          readFileSync(join(source, path)),
        ),
      ).toBe(true);
    restoreFileCalls?.();
    restoreFileCalls = undefined;
    if (misbehaviour !== undefined) rmSync(p, { recursive: true, force: true });
    return {
      misses,
      assertTiming: () => {
        expect(longest.ms, diagnostics).toBeLessThan(LOADED_BOUND_MS);
      },
    };
  }

  test(
    "each piece reads at most its bytes and makes at most its files; both passes in pieces; byte for byte",
    () => retryHostedTiming(boundedPieces),
    60_000,
  );

  /** The ordinary run with one piece misbehaving, as on a hosted runner (`true`) and off one. */
  function misbehaving(hosted: boolean, misbehaviour: Misbehaviour) {
    const name = `${misbehaviour.name}-${hosted ? "hosted" : "local"}`;
    return failureOf(
      retryHostedTiming(
        (attempt) => boundedPieces(attempt, { timeCalls: true, ...misbehaviour, name }),
        hosted,
      ),
    );
  }

  // A file well away from the creates that grow `web/`'s index (its 8th, 42nd, 63rd...), so that a
  // hosted disk's own wait does not land in the same piece.
  const QUIET_CREATE = "web/f124.js";

  test("a piece over the bound that waited in one create passes on a hosted runner, saying what it measured; off one it fails", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const delay = { name: "openSync", path: QUIET_CREATE, ms: LOADED_BOUND_MS + 150 } as const;
    const hosted = await misbehaving(true, { name: "create-wait", delay });
    log.mockRestore();
    expect(hosted).toBeUndefined();
    const passed = lines.find((line) => line.startsWith("Passing hosted timing"));
    expect(passed).toMatch(
      /waited in one file create, the rest of it within the limit, in attempt 1: (?:.*; )?copy: [\d.]+ ms wall, [\d.]+ ms thread CPU \(limit 250 ms\); 4\d\d\.\d ms of it in one file create \(web\/f124\.js\)/u,
    );
    expect(lines.join("\n")).not.toContain("paused");
    expect(await misbehaving(false, { name: "create-wait", delay })).toContain("Expected: < 250");
  }, 60_000);

  test("a piece over the bound that waited outside any create is retried as a pause on a hosted runner, and fails", async () => {
    const after = ({ index }: { index: number }) => {
      if (index === 10) Bun.sleepSync(LOADED_BOUND_MS + 150);
    };
    expect(await misbehaving(true, { name: "pause", after })).toMatch(
      /the runner paused the process in all three attempts\n(?:attempt [123]: hash: [\d.]+ ms wall, [\d.]+ ms thread CPU \(limit 250 ms\); [\d.]+ ms of it in one readSync \(upload\.hsnr\), [\d.]+ ms outside it[^\n]*\n?){3}/u,
    );
  }, 60_000);

  // Pass 2 makes `web/` again before each of its files: the one before the quiet create.
  const QUIET_MKDIR = { name: "mkdirSync", path: "web", skip: 29, phase: "copy" } as const;

  test.each([
    { hosted: true, ...QUIET_MKDIR },
    { hosted: false, ...QUIET_MKDIR },
    // The upload is opened to be read, not made: not a create.
    { hosted: true, name: "openSync", path: "upload.hsnr", skip: 0, phase: "start" },
  ] as const)(
    "a piece over the bound that waited in one file call other than a create fails, naming the call ($name $path, hosted runner: $hosted)",
    async ({ hosted, name, path, skip, phase }) => {
      const delay = { name, path, skip, ms: LOADED_BOUND_MS + 150 };
      const failure = await misbehaving(hosted, { name: `wait-${name}`, delay });
      if (hosted) {
        expect(failure).toContain(
          `one file call waited, which a hosted runner allows only for a file create of at most 750 ms: ${phase}: `,
        );
        // The delay (400 ms), measured inside the call and named by it.
        expect(failure?.match(/; (\d+)\.\d ms of it in one (\w+) \(([^)]+)\)/u)?.slice(2)).toEqual([
          name,
          path,
        ]);
        expect(Number(failure?.match(/; (\d+)\.\d ms of it in one/u)?.[1])).toBeGreaterThanOrEqual(
          400,
        );
      } else expect(failure).toContain("Expected: < 250");
      expect(failure).not.toContain("paused");
    },
    60_000,
  );

  test("a piece that spends more processor time than the bound fails, on a hosted runner and off one", async () => {
    let attempts = 0;
    const after = ({ index }: { index: number }) => {
      if (index !== 10) return;
      attempts += 1;
      spin(LOADED_BOUND_MS + 50);
    };
    const hosted = await misbehaving(true, { name: "cpu", after });
    // Failed on the processor time, at the first attempt: never retried as a pause.
    expect(hosted).toMatch(
      /hash: [\d.]+ ms wall, (?:2[5-9]\d|[3-9]\d\d)\.\d ms thread CPU \(limit 250 ms\)/u,
    );
    expect(hosted).not.toContain("paused");
    expect(attempts).toBe(1);
    expect(await misbehaving(false, { name: "cpu", after })).toContain("Expected: < 250");
  }, 60_000);

  test.each([true, false])(
    "a piece that reads more than its bytes fails (hosted runner: %p)",
    async (hosted) => {
      const after = ({ index, job }: { index: number; job: Staging }) => {
        if (index === 10) job.next();
      };
      expect(await misbehaving(hosted, { name: "bytes-over", after })).toContain(
        `Expected: <= ${STAGING_PIECE_BYTES}\nReceived: ${2 * STAGING_PIECE_BYTES}`,
      );
    },
  );

  test.each([true, false])(
    "a piece that makes more than its files fails (hosted runner: %p)",
    async (hosted) => {
      let extra = false;
      const after = ({ phase, folder }: { phase: Staging["phase"]; folder: string }) => {
        if (phase !== "copy" || extra) return;
        extra = true;
        for (let i = 0; i < STAGING_FILES_PER_PIECE + 4; i++)
          writeFileSync(join(folder, `extra-${i}`), "");
      };
      expect(await misbehaving(hosted, { name: "files-over", after })).toContain(
        `Expected: <= ${STAGING_FILES_PER_PIECE + 3}`,
      );
    },
  );

  /** Stages between simulated door reports to measure the opt-in timing budget. */
  async function reportsBetweenPieces(attempt: number) {
    const p = prefix(`loop-${attempt}`);
    const job = staging(p);
    const latencies: number[] = [];
    // Door reports, one every 10 ms from the start, by the clock: one that arrives while a piece
    // runs waits for it, which is what is measured (a timer firing late would hide it).
    const start = performance.now();
    let nextReport = start;
    const pieces: number[] = [];
    const misses: TimingMiss[] = [];
    const byPhase = new Map<string, number[]>();
    let madeBefore = 0;
    let outcome;
    for (;;) {
      // A turn: what arrived is taken first...
      await new Promise((resolve) => setImmediate(resolve));
      const now = performance.now();
      for (; nextReport <= now; nextReport += 10) latencies.push(now - nextReport);
      // ...then one piece.
      const phase = job.phase;
      const { value, wallMs: took, cpuMs } = timePiece(() => job.next());
      outcome = value;
      if (took >= PIECE_BOUND_MS)
        misses.push({ label: phase, wallMs: took, cpuMs, limitMs: PIECE_BOUND_MS });
      pieces.push(took);
      byPhase.set(phase, [...(byPhase.get(phase) ?? []), took]);
      // Pass 2 makes at most so many files a piece (a card pays for each).
      if (phase === "copy" && job.phase === "copy") {
        const made = readdirSync(join(p, "staged", ".staging-9.0.0"), {
          recursive: true,
        }).length;
        expect(made - madeBefore).toBeLessThanOrEqual(STAGING_FILES_PER_PIECE + 3);
        madeBefore = made;
      }
      if (outcome !== undefined) break;
    }
    expect(outcome).toEqual({ kind: "updateStaged", version: "9.0.0" });
    const longest = Math.max(...pieces);
    const sorted = pieces.toSorted((a, b) => a - b);
    const phases = [...byPhase].map(([phase, t]) => {
      const o = t.toSorted((a, b) => a - b);
      return `${phase}: ${t.length} pieces, longest ${o.at(-1)?.toFixed(2)} ms, p99 ${o[Math.floor(o.length * 0.99)]?.toFixed(2)} ms`;
    });
    console.log(
      `staging: ${pieces.length} pieces, longest ${longest.toFixed(2)} ms, p99 ${sorted[Math.floor(sorted.length * 0.99)]?.toFixed(2)} ms; ${phases.join("; ")}; ` +
        `door reports ${latencies.length}, longest wait ${Math.max(...latencies).toFixed(2)} ms`,
    );
    expect(latencies.length).toBeGreaterThan(10);

    // Byte for byte the version's folder.
    for (const path of [programPath, "web/f0.js", "web/f199.js", "drizzle/0000.sql"])
      expect(
        Buffer.from(readFileSync(join(p, "staged", "9.0.0", path))).equals(
          readFileSync(join(source, path)),
        ),
      ).toBe(true);
    expect(readdirSync(join(p, "staged", "9.0.0", "web"))).toHaveLength(200);
    expect(readdirSync(join(p, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
    return {
      misses,
      /** A report waits at most one piece and the turn around it. */
      assertTiming: () => {
        expect(longest).toBeLessThan(PIECE_BOUND_MS);
        expect(Math.max(...latencies)).toBeLessThan(PIECE_BOUND_MS + 20);
      },
    };
  }

  test.if(TIMING)(
    "timing, opt-in (HSN_TIMING=1, alone): no piece past 20 ms ‡; door reports are taken within a piece and a turn; byte for byte",
    () => retryHostedTiming(reportsBetweenPieces),
    60_000,
  );

  test.each(["hash", "copy"])(
    "a stop in pass %s: nothing left behind, the versions as they were",
    (pass) => {
      const p = prefix(`stop-${pass}`);
      const job = staging(p);
      for (let i = 0; i < 2000 && job.phase !== pass; i++) expect(job.next()).toBeUndefined();
      for (let i = 0; i < 20; i++) expect(job.next()).toBeUndefined();
      expect(job.phase).toBe(pass);
      // Pass 1 writes nothing; pass 2 writes into the folder beside.
      expect(existsSync(join(p, "staged", ".staging-9.0.0"))).toBe(pass === "copy");
      expect(job.abort("the hub is stopping")).toMatchObject({ kind: "failed", reason: "io" });
      expect(readdirSync(join(p, "staged")).toSorted()).toEqual(["0.0.9", "0.1.0"]);
      expect(job.next()).toMatchObject({ kind: "failed" });
    },
  );

  test("a cancel or a restore half-way (the core no longer wants it): nothing left behind", () => {
    const p = prefix("cancel");
    let wanted = true;
    const job = staging(p, () => wanted);
    for (let i = 0; i < 2000 && job.phase !== "copy"; i++) job.next();
    for (let i = 0; i < 20; i++) job.next();
    wanted = false;
    expect(job.next()).toMatchObject({ kind: "failed", message: "staging was cancelled" });
    expect(readdirSync(join(p, "staged")).toSorted()).toEqual(["0.0.9", "0.1.0"]);
  });
});

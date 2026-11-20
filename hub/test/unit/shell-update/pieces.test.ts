/**
 * Staging in pieces (the reviewer's decision of step 1, wave 2), on a release of realistic size (a
 * 112 MB program, as section 3 has it for Linux arm64). The pieces run on the staging worker's
 * thread (`shell/update/stage-job.ts`, the product owner's ruling of 2026-11-20), never on the
 * loop's, so what keeps a door report's wait short is the loop never waiting for the worker
 * (`stage-job.test.ts`; the opt-in timing test below). Each piece's work is still bounded: what it
 * reads and makes (at most `STAGING_PIECE_BYTES` ‡ of the release, at most
 * `STAGING_FILES_PER_PIECE` ‡ files), and its processor time, since the worker looks for a cancel
 * or a stop only between pieces. The result is byte for byte the version's folder, and a stop or a
 * cancel half-way, in either pass, leaves nothing behind.
 *
 * The ordinary run asserts those per piece, `Staging` called directly on the test's thread: the
 * bytes and files exactly, and the thread's processor time within a bound generous enough for a
 * loaded machine (`LOADED_BOUND_MS`), which catches a piece doing far more work than its bytes. It
 * asserts no wall time: a piece that waits (on Windows one file create or close can wait for
 * hundreds of milliseconds) waits on the worker, not on the loop. The tests after it stage with
 * one piece made to misbehave and show what fails, and that a wait does not.
 *
 * The opt-in timing test (`HSN_TIMING=1`, run alone) stages through the worker as the loop drives
 * it, with door reports arriving on a timer all the while, and asserts section 3's 20 ms ‡ for the
 * loop's turns and a report's wait.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { Result } from "neverthrow";
import { releaseOf } from "../../../packaging/shared/make-release.ts";
import { installPaths } from "../../../launcher/src/layout.ts";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import {
  STAGING_FILES_PER_PIECE,
  STAGING_PIECE_BYTES,
  Staging,
  type StageInputs,
} from "../../../src/shell/update/stage.ts";
import { StagingJob } from "../../../src/shell/update/stage-job.ts";
import { retryHostedTiming, timePiece, type TimingMiss } from "../../world/hosted-timing.ts";

/** Section 3's limit for one of the loop's turns ‡: asserted only by the opt-in timing test. */
const TURN_BOUND_MS = 20;
/** A bound for a loaded machine (the whole suite at once): a piece working far more than its bytes. */
const LOADED_BOUND_MS = 250;
const TIMING = process.env.HSN_TIMING === "1";
const fixturePlatform = process.platform === "win32" ? "windows-x64" : "darwin-arm64";
const programPath = process.platform === "win32" ? "bin/hsn-hub.exe" : "bin/hsn-hub";
const SEED = new Uint8Array(32).fill(7);
const folders: string[] = [];
let root: string;
let upload: string;
let source: string;

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

function inputs(p: string, wanted: () => boolean = () => true): StageInputs {
  return {
    path: upload,
    prefix: p,
    runningVersion: "0.1.0",
    platform: fixturePlatform,
    keys: [TEST_PUBLISHER_KEY],
    wanted,
  };
}

function staging(p: string, wanted: () => boolean = () => true): Staging {
  return new Staging(inputs(p, wanted));
}

/** The version's folder byte for byte the release's files (a sample of them). */
function byteForByte(p: string): void {
  for (const path of [programPath, "web/f0.js", "web/f199.js", "drizzle/0000.sql"])
    expect(
      Buffer.from(readFileSync(join(p, "staged", "9.0.0", path))).equals(
        readFileSync(join(source, path)),
      ),
    ).toBe(true);
}

/** What a test makes one piece do beyond its real work, inside the piece. */
type Misbehaviour = (piece: {
  readonly index: number;
  readonly phase: Staging["phase"];
  readonly job: Staging;
  readonly folder: string;
}) => void;

/** Spends at least `ms` of this thread's processor time. */
function spin(ms: number): void {
  const start = process.threadCpuUsage();
  for (;;) {
    const used = process.threadCpuUsage(start);
    if ((used.user + used.system) / 1000 >= ms) return;
  }
}

describe("staging a 112 MB program in pieces", () => {
  /** Stages a fresh release, a piece after another, checking each piece's work. */
  function boundedPieces(name: string, misbehave?: Misbehaviour): void {
    const p = prefix(name);
    const job = staging(p);
    const folder = join(p, "staged", ".staging-9.0.0");
    let read = 0;
    let longest = { phase: job.phase, cpuMs: 0, wallMs: 0, read: 0 };
    let pieces = 0;
    let madeBefore = 0;
    let outcome;
    for (;;) {
      const phase = job.phase;
      const index = pieces;
      const { value, wallMs, cpuMs } = timePiece(() => {
        const ended = job.next();
        misbehave?.({ index, phase, job, folder });
        return ended;
      }, true);
      outcome = value;
      if (cpuMs > longest.cpuMs) longest = { phase, cpuMs, wallMs, read };
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
    byteForByte(p);
    expect(longest.cpuMs, `the piece that worked longest: ${JSON.stringify(longest)}`).toBeLessThan(
      LOADED_BOUND_MS,
    );
    rmSync(p, { recursive: true, force: true });
  }

  test("each piece reads at most its bytes, makes at most its files and works within its bound; both passes in pieces; byte for byte", () => {
    boundedPieces("bytes");
  }, 60_000);

  /** The ordinary run with one piece misbehaving: what it fails on, or nothing. */
  function misbehaving(name: string, misbehave: Misbehaviour): string | undefined {
    const ran = Result.fromThrowable(
      () => {
        boundedPieces(name, misbehave);
      },
      (thrown) => String(thrown),
    )();
    return ran.isErr() ? ran.error : undefined;
  }

  test("a piece that spends more processor time than the bound fails", () => {
    const failure = misbehaving("cpu", ({ index }) => {
      if (index === 10) spin(LOADED_BOUND_MS + 50);
    });
    expect(failure).toMatch(
      /the piece that worked longest: \{"phase":"hash","cpuMs":(?:2[5-9]\d|[3-9]\d\d)/u,
    );
  }, 60_000);

  test("a piece that waits (as a slow file call does) works no longer: it passes", () => {
    expect(
      misbehaving("waits", ({ index }) => {
        if (index === 10) Bun.sleepSync(LOADED_BOUND_MS + 150);
      }),
    ).toBeUndefined();
  }, 60_000);

  test("a piece that reads more than its bytes fails", () => {
    expect(
      misbehaving("bytes-over", ({ index, job }) => {
        if (index === 10) job.next();
      }),
    ).toContain(`Expected: <= ${STAGING_PIECE_BYTES}\nReceived: ${2 * STAGING_PIECE_BYTES}`);
  }, 60_000);

  test("a piece that makes more than its files fails", () => {
    let extra = false;
    expect(
      misbehaving("files-over", ({ phase, folder }) => {
        if (phase !== "copy" || extra) return;
        extra = true;
        for (let i = 0; i < STAGING_FILES_PER_PIECE + 4; i++)
          writeFileSync(join(folder, `extra-${i}`), "");
      }),
    ).toContain(`Expected: <= ${STAGING_FILES_PER_PIECE + 3}`);
  }, 60_000);

  /**
   * Stages through the worker as the loop drives it, with door reports due every 10 ms by the
   * clock: a turn is a timer firing, each the loop's call into the job; a report waits for the
   * thread as long as the loop holds it.
   */
  async function reportsWhileStaging(attempt: number) {
    const p = prefix(`loop-${attempt}`);
    const turns: number[] = [];
    const misses: TimingMiss[] = [];
    const latencies: number[] = [];
    let woken = Promise.withResolvers<undefined>();
    const job = new StagingJob(inputs(p), {
      wake: () => {
        woken.resolve(undefined);
      },
    });
    const start = performance.now();
    let nextReport = start;
    let outcome: FileOutcome | undefined;
    const turn = (): void => {
      const now = performance.now();
      for (; nextReport <= now; nextReport += 10) latencies.push(now - nextReport);
      const { value, wallMs, cpuMs } = timePiece(() => job.next());
      outcome = value;
      turns.push(wallMs);
      if (wallMs >= TURN_BOUND_MS)
        misses.push({ label: "turn", wallMs, cpuMs, limitMs: TURN_BOUND_MS });
    };
    while (outcome === undefined) {
      await Promise.race([
        woken.promise,
        Bun.sleep(Math.max(1, Math.ceil(nextReport - performance.now()))),
      ]);
      woken = Promise.withResolvers<undefined>();
      turn();
    }
    expect(outcome).toEqual({ kind: "updateStaged", version: "9.0.0" });
    const took = performance.now() - start;
    console.log(
      `staging on its worker: ${took.toFixed(0)} ms, ${turns.length} turns, longest turn ${Math.max(...turns).toFixed(2)} ms; ` +
        `door reports ${latencies.length}, longest wait ${Math.max(...latencies).toFixed(2)} ms`,
    );
    expect(latencies.length).toBeGreaterThan(10);
    byteForByte(p);
    expect(readdirSync(join(p, "staged", "9.0.0", "web"))).toHaveLength(200);
    expect(readdirSync(join(p, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
    return {
      misses,
      /** A turn within the limit, and a report waits at most a turn and the timer's own lateness. */
      assertTiming: () => {
        expect(Math.max(...turns)).toBeLessThan(TURN_BOUND_MS);
        expect(Math.max(...latencies)).toBeLessThan(TURN_BOUND_MS + 20);
      },
    };
  }

  test.if(TIMING)(
    "timing, opt-in (HSN_TIMING=1, alone): staged on its worker, no turn of the loop past 20 ms ‡, door reports taken within a turn; byte for byte",
    () => retryHostedTiming(reportsWhileStaging),
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

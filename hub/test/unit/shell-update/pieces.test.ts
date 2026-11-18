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
import { releaseOf } from "../../../packaging/shared/make-release.ts";
import { installPaths } from "../../../launcher/src/layout.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import {
  STAGING_FILES_PER_PIECE,
  STAGING_PIECE_BYTES,
  Staging,
} from "../../../src/shell/update/stage.ts";

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

describe("staging a 112 MB program in pieces", () => {
  test("each piece reads at most its bytes and makes at most its files; both passes in pieces; byte for byte", () => {
    const p = prefix("bytes");
    const job = staging(p);
    let read = 0;
    let longest: {
      phase: Staging["phase"];
      ms: number;
      bytes: number;
      read: number;
      cpuMs?: number;
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
      const cpuStart = process.platform === "win32" ? process.threadCpuUsage() : undefined;
      const s = performance.now();
      outcome = job.next();
      const ms = performance.now() - s;
      if (ms > longest.ms) {
        const cpu = cpuStart === undefined ? undefined : process.threadCpuUsage(cpuStart);
        longest = {
          phase,
          ms,
          bytes: job.bytesRead - read,
          read,
          ...(cpu === undefined ? {} : { cpuMs: (cpu.user + cpu.system) / 1000 }),
        };
      }
      pieces += 1;
      expect(job.bytesRead - read).toBeLessThanOrEqual(STAGING_PIECE_BYTES);
      read = job.bytesRead;
      if (phase === "copy" && job.phase === "copy") {
        const made = readdirSync(join(p, "staged", ".staging-9.0.0"), { recursive: true }).length;
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
    expect(longest.ms, `longest piece: ${JSON.stringify(longest)}`).toBeLessThan(LOADED_BOUND_MS);
    for (const path of [programPath, "web/f0.js", "web/f199.js", "drizzle/0000.sql"])
      expect(
        Buffer.from(readFileSync(join(p, "staged", "9.0.0", path))).equals(
          readFileSync(join(source, path)),
        ),
      ).toBe(true);
  }, 60_000);

  test.if(TIMING)(
    "timing, opt-in (HSN_TIMING=1, alone): no piece past 20 ms ‡; door reports are taken within a piece and a turn; byte for byte",
    async () => {
      const p = prefix("loop");
      const job = staging(p);
      const latencies: number[] = [];
      // Door reports, one every 10 ms from the start, by the clock: one that arrives while a piece
      // runs waits for it, which is what is measured (a timer firing late would hide it).
      const start = performance.now();
      let nextReport = start;
      const pieces: number[] = [];
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
        const s = performance.now();
        outcome = job.next();
        const took = performance.now() - s;
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
      expect(longest).toBeLessThan(PIECE_BOUND_MS);
      expect(latencies.length).toBeGreaterThan(10);
      // A report waits at most one piece and the turn around it (the timer's own lateness aside).
      expect(Math.max(...latencies)).toBeLessThan(PIECE_BOUND_MS + 20);

      // Byte for byte the version's folder.
      for (const path of [programPath, "web/f0.js", "web/f199.js", "drizzle/0000.sql"])
        expect(
          Buffer.from(readFileSync(join(p, "staged", "9.0.0", path))).equals(
            readFileSync(join(source, path)),
          ),
        ).toBe(true);
      expect(readdirSync(join(p, "staged", "9.0.0", "web"))).toHaveLength(200);
      expect(readdirSync(join(p, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
    },
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

/**
 * The work of each piece of a backup, a configuration export and a history export (m2-design.md
 * section 3, "The loop's time while the hub listens": pieces of about 256 KB ‡, 20 ms ‡ a turn),
 * on a configuration far larger than a home's (A9's loop test found long turns there):
 *
 * - a backup's `seal` piece seals and writes at most `SEAL_PIECE_BYTES` of plaintext, and syncs
 *   it with the piece, so the last `sync` has no whole file to flush;
 * - an export's `send` piece sends at most a seal piece's chunks;
 * - a history export's piece writes at most `HISTORY_PIECE_BYTES` of lines (and the one line that
 *   crosses it), whatever a row's size.
 *
 * The ordinary run asserts that work. Wall time depends on the machine, so the 20 ms ‡ is asserted
 * only with `HSN_TIMING=1`, run alone, and only for the pieces bounded by bytes; the first piece,
 * which reads the whole configuration at once (SPEC-QUESTION in A8's report), is measured and
 * printed, not asserted.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CHUNK_BYTES } from "@hsn/protocol/app";
import { ok } from "neverthrow";
import { connId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import type { Clock } from "../../../src/ports/clock.ts";
import { ExportPieces } from "../../../src/shell/backup/export-pieces.ts";
import { HISTORY_PIECE_BYTES, HistoryExport } from "../../../src/shell/backup/history-export.ts";
import { SEAL_PIECE_BYTES } from "../../../src/shell/backup/sealing.ts";
import { BackupPieces, type ExportChunk } from "../../../src/shell/backup/write.ts";
import { type OpenedStore, openStore } from "../../../src/shell/storage/store.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
const TIMING = process.env.HSN_TIMING === "1";
const PIECE_LIMIT_MS = 20;
const KEY = new Uint8Array(32).fill(0x31);
/**
 * A sealed piece: its plaintext and the one chunk the sealer may hold over from the piece before
 * (it seals a chunk once the next byte comes, or at the end), a tag per 64 KiB chunk, the header.
 */
const SEALED_PIECE_MAX = SEAL_PIECE_BYTES + 65_536 + (SEAL_PIECE_BYTES / 65_536 + 2) * 16 + 64;
const folders: string[] = [];
const stores: OpenedStore[] = [];
afterEach(() => {
  for (const opened of stores.splice(0)) opened.db.close(true);
});

afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

class FixedClock implements Clock {
  now(): Now {
    return { mono: mono(1), wall: Date.UTC(2026, 10, 16), wallTrusted: true };
  }
}

/** A hub with `people` people of 1 KB names: a configuration of about `people` KB. */
function hub(people: number): { store: OpenedStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "hsn-pieces-"));
  folders.push(root);
  const store = openStore({
    dataDir: join(root, "data"),
    migrationsFolder: MIGRATIONS,
    clock: new FixedClock(),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  const db = store.db;
  db.run(
    "INSERT INTO hub_keys (signing_private, signing_public, identity, app_static_public) VALUES (?, ?, ?, ?)",
    [new Uint8Array(8), new Uint8Array(64), new Uint8Array(8), new Uint8Array(32).fill(1)],
  );
  const insert = db.query(
    "INSERT INTO people (id, name, created_ms, removed_ms, revision) VALUES (?, ?, 0, NULL, 0)",
  );
  const name = "x".repeat(1000);
  for (let i = 1; i <= people; i++) {
    if (i % 5000 === 1) db.run("BEGIN");
    insert.run(i, `${name}${String(i)}`);
    if (i % 5000 === 0) db.run("COMMIT");
  }
  if (db.inTransaction) db.run("COMMIT");
  stores.push(store);
  return { store, root };
}

const deps = { nowMs: () => Date.UTC(2026, 10, 16), salt: () => ok(new Uint8Array(8)) };

/** Each piece's phase and time, until the job ends. */
function pieces(job: { next(): unknown; readonly phase: string }): {
  readonly outcome: unknown;
  readonly times: Map<string, number[]>;
} {
  const times = new Map<string, number[]>();
  for (;;) {
    const phase = job.phase;
    const start = performance.now();
    const outcome = job.next();
    times.set(phase, [...(times.get(phase) ?? []), performance.now() - start]);
    if (outcome !== undefined) return { outcome, times };
  }
}

function longest(times: Map<string, number[]>, phases: readonly string[]): number {
  return Math.max(0, ...phases.flatMap((p) => times.get(p) ?? []));
}

describe("a piece's work does not grow with the data", () => {
  const { store, root } = hub(8_000);
  const folder = join(root, "backups");
  mkdirSync(folder);

  test("a backup: each seal piece writes at most a piece's sealed bytes; the last sync has none left", () => {
    const job = new BackupPieces(store.db, { folder, keep: 20, key: KEY, epoch: 1 }, deps);
    const { outcome, times } = pieces(job);
    expect(outcome).toMatchObject({ kind: "backupWritten" });
    expect(job.sealedPieces.length).toBeGreaterThan(20);
    for (const bytes of job.sealedPieces) expect(bytes).toBeLessThanOrEqual(SEALED_PIECE_MAX);
    console.log(
      `backup of ${String(Math.round((outcome as { bytes: number }).bytes / 1e6))} MB: first piece ${longest(times, ["start"]).toFixed(1)} ms, seal ≤ ${longest(times, ["seal"]).toFixed(1)} ms, sync ${longest(times, ["sync"]).toFixed(1)} ms`,
    );
    if (TIMING)
      expect(longest(times, ["seal", "sync", "place", "prune"])).toBeLessThan(PIECE_LIMIT_MS);
  });

  test("a configuration export: each send piece sends at most a seal piece's chunks", () => {
    const sent: ExportChunk[][] = [];
    let current: ExportChunk[] = [];
    const job = new ExportPieces(
      store.db,
      7,
      { conn: connId(4), key: KEY, epoch: 1 },
      {
        send: (_c, chunk) => {
          current.push(chunk);
          return ok(undefined);
        },
      },
      deps,
    );
    const times = new Map<string, number[]>();
    let outcome: unknown;
    for (;;) {
      const phase = job.phase;
      current = [];
      const start = performance.now();
      outcome = job.next();
      times.set(phase, [...(times.get(phase) ?? []), performance.now() - start]);
      sent.push(current);
      if (outcome !== undefined) break;
    }
    expect(outcome).toMatchObject({ kind: "exportSent" });
    // A piece's sealed bytes, with what an earlier piece left short of a whole chunk.
    for (const chunks of sent)
      expect(chunks.length).toBeLessThanOrEqual(Math.ceil(SEALED_PIECE_MAX / FILE_CHUNK_BYTES) + 1);
    console.log(
      `configuration export: first piece ${longest(times, ["start"]).toFixed(1)} ms, send ≤ ${longest(times, ["send"]).toFixed(1)} ms`,
    );
    if (TIMING) expect(longest(times, ["send"])).toBeLessThan(PIECE_LIMIT_MS);
  });

  test("a history export: at most a piece's bytes of lines, however large a row", () => {
    // Rows of 20 KB: a page of 500 is 10 MB, which no piece may write at once.
    const insert = store.db.query(
      "INSERT INTO hub_events (seq, at_ms, clock_ok, level, origin, code, message, detail) VALUES (?, ?, 1, 'info', 'test', 'big', ?, NULL)",
    );
    const message = "m".repeat(20_000);
    store.db.run("BEGIN");
    for (let n = 1; n <= 600; n++) insert.run(n, n, message);
    store.db.run("COMMIT");
    const job = new HistoryExport(
      store.db,
      8,
      { conn: connId(4) },
      { send: () => ok(undefined) },
      deps,
    );
    let before = 0;
    let longestPiece = 0;
    for (;;) {
      const start = performance.now();
      const outcome = job.next();
      longestPiece = Math.max(longestPiece, performance.now() - start);
      expect(job.lineBytes - before).toBeLessThanOrEqual(HISTORY_PIECE_BYTES + 21_000);
      before = job.lineBytes;
      if (outcome !== undefined) break;
    }
    expect(job.lines).toBeGreaterThan(600);
    console.log(`history export of 600 rows of 20 KB: longest piece ${longestPiece.toFixed(1)} ms`);
    if (TIMING) expect(longestPiece).toBeLessThan(PIECE_LIMIT_MS);
  });
});

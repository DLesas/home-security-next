/**
 * The size guard (hub-design.md section 6, "The size guard (D112's ceiling)") on a real SQLite
 * file, with its marks, counts and ages made small: a hard stop of 3 MB, trimming from past
 * 2 MB until back under 1.5 MB, 150 rows a table a commit, routine rows protected for an hour
 * and event rows for a day.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type { CommitOutcome } from "../../../src/core/model/events.ts";
import { deviceId, type Seq } from "../../../src/core/model/ids.ts";
import type { HubEventLevel } from "../../../src/core/model/rows.ts";
import {
  DEFAULT_RULES,
  type HubRules,
  type SizeGuardRules,
} from "../../../src/core/model/rules.ts";
import { appendFatal, fatalLogPath } from "../../../src/shell/storage/fatal.ts";
import { PAGE_SIZE } from "../../../src/shell/storage/settings.ts";
import { type OpenedStore } from "../../../src/shell/storage/store.ts";
import { pagesInUseBytes } from "../../../src/shell/storage/size-guard.ts";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  openTestStore,
  record,
  rxRow,
  seqOf,
  tempDir,
  TestClock,
} from "./fixtures.ts";

const MB = 1024 * 1024;
const GUARD: SizeGuardRules = {
  hardStopBytes: 3 * MB,
  startBytes: 2 * MB,
  stopBytes: 1.5 * MB,
  rowsPerCommit: 150,
  routineProtectedMs: HOUR_MS,
  eventProtectedMs: DAY_MS,
  fatalLogMaxBytes: 64 * 1024,
};
const RULES: HubRules = {
  ...DEFAULT_RULES,
  persistence: { ...DEFAULT_RULES.persistence, sizeGuard: GUARD },
};
/** About 2 KB a row, so a megabyte is about 500 rows. */
const BODY = new Uint8Array(1900).fill(0x5a);

let open: { dir: ReturnType<typeof tempDir>; store: OpenedStore } | undefined;
afterEach(() => {
  open?.store.db.close();
  open?.dir.remove();
  open = undefined;
});

/** A store with the small guard, and a way to add rows of each kind at the clock's time. */
function guarded() {
  const dir = tempDir("guard");
  const clock = new TestClock();
  const store = openTestStore(dir.path, clock, { rules: RULES });
  open = { dir, store };
  let n = 0;
  const next = (): Seq => seqOf(store.boot.id, n++);
  const outcomes: CommitOutcome[] = [];
  const rows = {
    routine: (): AuditRecord => ({
      kind: "rx",
      table: "routine",
      row: rxRow(next(), 3, clock.wall, BODY),
    }),
    event: (): AuditRecord => ({
      kind: "rx",
      table: "event",
      row: rxRow(next(), 3, clock.wall, BODY),
    }),
    decision: (): AuditRecord => ({
      kind: "decision",
      row: {
        seq: next(),
        atMs: clock.wall,
        clockOk: true,
        kind: "reply_skipped",
        deviceId: deviceId(3),
        causeSeq: null,
        value: 1,
        detail: BODY,
      },
    }),
    deviceLog: (level: number): AuditRecord => ({
      kind: "deviceLog",
      row: {
        seq: next(),
        atMs: clock.wall,
        clockOk: true,
        deviceId: deviceId(3),
        counter: n,
        madeMs: clock.wall,
        level,
        code: 7,
        text: BODY,
        repeatOf: null,
      },
    }),
    hubEvent: (level: HubEventLevel): AuditRecord => ({
      kind: "hubEvent",
      row: {
        seq: next(),
        atMs: clock.wall,
        clockOk: true,
        level,
        origin: "test",
        code: "test",
        message: "x".repeat(1900),
        detail: null,
      },
    }),
    command: (): AuditRecord => ({
      kind: "command",
      row: {
        seq: next(),
        atMs: clock.wall,
        clockOk: true,
        actor: "dimi",
        kind: "status",
        args: "x".repeat(1900),
        outcome: "ok",
        detail: null,
      },
    }),
  };
  /** Stages `records` and makes one routine commit: its outcome, or the error. */
  const commit = (records: readonly AuditRecord[]) => {
    store.writer.stage(records.map((r) => record("routine", r)));
    const flushed = store.writer.flush("due");
    for (let o = store.writer.takeOutcome(); o !== undefined; o = store.writer.takeOutcome())
      outcomes.push(o);
    return flushed;
  };
  const count = (table: string, where = "") =>
    store.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}" ${where}`).get()?.n ??
    0;
  const fileBytes = () =>
    (store.db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0) *
    PAGE_SIZE;
  const inUse = () => pagesInUseBytes(store.db, PAGE_SIZE);
  return { store, clock, rows, commit, count, fileBytes, inUse, outcomes };
}

const times = <T>(k: number, make: () => T): T[] => Array.from({ length: k }, make);

describe("the size guard (section 6)", () => {
  test("the hard stop: under an inflow faster than trimming, the file never passes it", () => {
    const g = guarded();
    const refusals: string[] = [];
    let peak = 0;
    for (let round = 0; round < 120; round++) {
      g.clock.advanceMs(10 * MINUTE_MS);
      // 200 rows a commit against trimming's 150 from each table.
      const flushed = g.commit(times(200, g.rows.routine));
      if (flushed.isErr()) refusals.push(flushed.error.message);
      peak = Math.max(peak, g.fileBytes());
      expect(g.fileBytes()).toBeLessThanOrEqual(GUARD.hardStopBytes);
    }
    expect(peak).toBeGreaterThan(GUARD.startBytes);
    expect(g.store.writer.trimming || g.inUse() < GUARD.stopBytes).toBe(true);
    // The inflow reached the hard stop: SQLite refused to grow the file, each refusal a full
    // database (nothing else failed), and every one told to the core.
    expect(refusals.length).toBeGreaterThan(0);
    for (const message of refusals) expect(message).toContain("database or disk is full");
    expect(g.outcomes.filter((o) => o.kind === "failed").length).toBeGreaterThan(0);
    const kinds = new Set(g.outcomes.map((o) => o.kind));
    expect(kinds.has("trimmed")).toBe(true);
  });

  test("a refused commit at the hard stop says the database is full, and recovers once trimming frees pages", () => {
    const g = guarded();
    // Fill to the hard stop with rows that are still protected.
    for (let round = 0; round < 40; round++) {
      g.clock.advanceMs(MINUTE_MS);
      if (g.commit(times(100, g.rows.routine)).isErr()) break;
    }
    const refused = g.commit(times(100, g.rows.routine));
    expect(refused.isErr()).toBe(true);
    const failure = g.outcomes.findLast((o) => o.kind === "failed");
    expect(failure?.kind === "failed" ? failure.message : "").toContain("the database is full");
    expect(g.store.writer.trimming).toBe(true);
    // Everything is inside the routine protected age: trimming cannot help yet.
    g.clock.advanceMs(10 * MINUTE_MS);
    expect(g.store.writer.flush("due").isErr()).toBe(true);
    // Once the rows are past their protected age, the retry trims first and commits.
    g.clock.advanceMs(2 * HOUR_MS);
    const retried = g.store.writer.flush("due");
    expect(retried.isOk()).toBe(true);
    const after: CommitOutcome[] = [];
    for (let o = g.store.writer.takeOutcome(); o !== undefined; o = g.store.writer.takeOutcome())
      after.push(o);
    expect(after.map((o) => o.kind)).toContain("recovered");
    expect(after.map((o) => o.kind)).toContain("trimmed");
  });

  test("routine rows go before any event row; then events, oldest first", () => {
    const g = guarded();
    for (let round = 0; round < 6; round++) {
      g.clock.advanceMs(10 * MINUTE_MS);
      g.commit([...times(60, g.rows.routine), ...times(60, g.rows.event)])._unsafeUnwrap();
    }
    // Two days later: all of it is past both protected ages; fill past the upper mark.
    g.clock.advanceMs(2 * DAY_MS);
    let eventsBefore = g.count("rx_event");
    for (let round = 0; round < 80 && g.outcomes.every((o) => o.kind !== "trimEnded"); round++) {
      const oldRoutine = g.count("rx_routine", `WHERE at_ms < ${g.clock.wall - HOUR_MS}`);
      g.clock.advanceMs(MINUTE_MS);
      g.commit(times(40, g.rows.routine))._unsafeUnwrap();
      const events = g.count("rx_event");
      // An event row goes only in a commit that began with no routine row left to trim.
      if (events < eventsBefore) expect(oldRoutine).toBeLessThanOrEqual(GUARD.rowsPerCommit);
      eventsBefore = events;
    }
    const trimmed = g.outcomes.flatMap((o) => (o.kind === "trimmed" ? [o.report] : []));
    expect(trimmed.length).toBeGreaterThan(0);
    const firstEvents = trimmed.findIndex((r) => r.eventRows > 0);
    if (firstEvents > 0) {
      expect(trimmed.slice(0, firstEvents).every((r) => r.routineRows > 0)).toBe(true);
    }
  });

  test("nothing inside the protected ages, no command and no warning or worse is ever deleted", () => {
    const g = guarded();
    const kept = () => ({
      commands: g.count("commands"),
      warnings: g.count("device_log", "WHERE level >= 2"),
      serious: g.count("hub_events", "WHERE level IN ('warning', 'critical')"),
    });
    // Old rows of every kind, then a day and a half later more of them, and recent ones.
    g.clock.advanceMs(MINUTE_MS);
    g.commit([
      ...times(100, g.rows.event),
      ...times(100, g.rows.decision),
      ...times(50, () => g.rows.deviceLog(0)),
      ...times(50, () => g.rows.deviceLog(2)),
      ...times(50, () => g.rows.hubEvent("info")),
      ...times(50, () => g.rows.hubEvent("warning")),
      ...times(50, () => g.rows.hubEvent("critical")),
      ...times(50, g.rows.command),
    ])._unsafeUnwrap();
    g.clock.advanceMs(1.5 * DAY_MS);
    const recentFrom = g.clock.wall;
    g.commit([...times(150, g.rows.event), ...times(100, g.rows.routine)])._unsafeUnwrap();
    const before = kept();
    for (let round = 0; round < 60; round++) {
      g.clock.advanceMs(MINUTE_MS);
      const flushed = g.commit(times(80, g.rows.routine));
      if (flushed.isErr()) break;
    }
    expect(g.outcomes.some((o) => o.kind === "trimmed" && o.report.eventRows > 0)).toBe(true);
    expect(kept()).toEqual(before);
    // The event rows of the last day and the routine rows of the last hour are all there.
    expect(g.count("rx_event", `WHERE at_ms >= ${recentFrom}`)).toBe(150);
    const lastHour = g.clock.wall - HOUR_MS;
    const recentRoutine = g.count("rx_routine", `WHERE at_ms >= ${lastHour}`);
    expect(recentRoutine).toBeGreaterThan(0);
    expect(g.count("device_log", "WHERE level < 2")).toBeLessThan(50);
  });

  test("a commit written now never trims: a door report's commit never pays for it", () => {
    const g = guarded();
    for (let round = 0; round < 30 && !g.store.writer.trimming; round++) {
      g.clock.advanceMs(30 * MINUTE_MS);
      g.commit(times(100, g.rows.routine))._unsafeUnwrap();
    }
    expect(g.store.writer.trimming).toBe(true);
    const before = g.count("rx_routine");
    const older = g.count("rx_routine", `WHERE at_ms < ${g.clock.wall - HOUR_MS}`);
    expect(older).toBeGreaterThan(0);
    g.store.writer.stage([record("now", g.rows.event())]);
    g.store.writer.flush("now")._unsafeUnwrap();
    expect(g.count("rx_routine")).toBe(before);
    for (let o = g.store.writer.takeOutcome(); o !== undefined; o = g.store.writer.takeOutcome())
      expect(o.kind).not.toBe("trimmed");
  });

  test("when everything left is protected, the core hears it once, before commits fail", () => {
    const g = guarded();
    // All inside the routine protected age (an hour): past the upper mark in minutes.
    for (let round = 0; round < 40; round++) {
      g.clock.advanceMs(MINUTE_MS);
      if (g.commit(times(100, g.rows.routine)).isErr()) break;
    }
    const kinds = g.outcomes.map((o) => o.kind);
    expect(kinds.filter((k) => k === "trimExhausted")).toHaveLength(1);
    const exhausted = kinds.indexOf("trimExhausted");
    const firstFailure = kinds.indexOf("failed");
    expect(exhausted).toBeGreaterThanOrEqual(0);
    if (firstFailure >= 0) expect(exhausted).toBeLessThan(firstFailure);
    expect(kinds).not.toContain("trimmed");
  });

  test("trimming causes no commit of its own", () => {
    const g = guarded();
    for (let round = 0; round < 30 && !g.store.writer.trimming; round++) {
      g.clock.advanceMs(30 * MINUTE_MS);
      g.commit(times(100, g.rows.routine))._unsafeUnwrap();
    }
    expect(g.store.writer.trimming).toBe(true);
    const commits = g.store.writer.stats.commits;
    // Nothing staged: no routine flush is due, and none commits, trimming or not.
    for (let round = 0; round < 20; round++) {
      g.clock.advanceMs(10 * MINUTE_MS);
      expect(g.store.writer.flushIfDue(g.clock.mono)._unsafeUnwrap()).toBeUndefined();
    }
    expect(g.store.writer.stats.commits).toBe(commits);
    expect(g.store.writer.trimming).toBe(true);
  });

  test("hysteresis: started past the upper mark, it goes on until under the lower one, and does not flap", () => {
    const g = guarded();
    const flips: { readonly on: boolean; readonly inUse: number }[] = [];
    let trimming = false;
    for (let round = 0; round < 200; round++) {
      g.clock.advanceMs(20 * MINUTE_MS);
      g.commit(times(round < 60 ? 40 : 10, g.rows.routine))._unsafeUnwrap();
      if (g.store.writer.trimming !== trimming) {
        trimming = g.store.writer.trimming;
        flips.push({ on: trimming, inUse: g.inUse() });
      }
    }
    expect(flips.length).toBeGreaterThanOrEqual(2);
    for (const flip of flips) {
      if (flip.on) expect(flip.inUse).toBeGreaterThan(GUARD.startBytes);
      else expect(flip.inUse).toBeLessThan(GUARD.stopBytes);
    }
    // Starts and ends alternate, each only across its own mark: never a start-stop around one.
    flips.forEach((flip, i) => {
      expect(flip.on).toBe(i % 2 === 0);
    });
    expect(g.outcomes.filter((o) => o.kind === "trimEnded")).toHaveLength(
      flips.filter((f) => !f.on).length,
    );
  });
});

describe("the other shares (section 6)", () => {
  test("fatal.log is cut back to its newest half when it passes its limit", () => {
    const dir = tempDir("fatal");
    for (let i = 0; i < 400; i++) {
      appendFatal(
        dir.path,
        {
          kind: "refused",
          boot: null,
          atMs: 0,
          mono: 0,
          origin: "test",
          message: `entry ${i} ${"y".repeat(300)}`,
        },
        GUARD.fatalLogMaxBytes,
      )._unsafeUnwrap();
      expect(statSync(fatalLogPath(dir.path)).size).toBeLessThanOrEqual(
        GUARD.fatalLogMaxBytes + 400,
      );
    }
    const lines = readFileSync(fatalLogPath(dir.path), "utf8").trim().split("\n");
    expect(lines.at(-1)).toContain("entry 399");
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    dir.remove();
  });
});

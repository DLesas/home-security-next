/**
 * The writer on a real SQLite file (hub-design.md sections 4 and 5): each flush rule, the size
 * limits, the folding of upserts by row, a failed commit and its retries and cap, the commit
 * mark in every commit, the clean-stop mark, the checkpoints it runs itself, and the prepared
 * statements of the hot path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deviceId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { monoAfterMs } from "../../../src/core/model/time.ts";
import type { OpenedStore } from "../../../src/shell/storage/store.ts";
import { PAGE_SIZE } from "../../../src/shell/storage/settings.ts";
import {
  CHECKPOINT_FRAMES,
  FAILING_BATCH_CAP,
  RETRY_DELAYS_MS,
  SqliteWriter,
} from "../../../src/shell/storage/writer.ts";
import {
  BOOT,
  deviceRow,
  deviceStateRow,
  HOUR_MS,
  hubEventRecord,
  MINUTE_MS,
  openTestStore,
  record,
  rxRecord,
  rxRow,
  SECOND_MS,
  sensorConfigRow,
  seqOf,
  tempDir,
  TestClock,
  write,
} from "./fixtures.ts";

let dir: ReturnType<typeof tempDir>;
let clock: TestClock;
let store: OpenedStore;

beforeEach(() => {
  dir = tempDir("writer");
  clock = new TestClock();
  store = openTestStore(dir.path, clock);
});
afterEach(() => {
  store.db.close(true);
  dir.remove();
});

function count(table: string): number {
  return store.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()?.n ?? 0;
}

function mark(): {
  boot: number;
  last_seen_mono: number;
  last_seen_ms: number;
  clock_ok: number;
} | null {
  return store.db
    .query<{ boot: number; last_seen_mono: number; last_seen_ms: number; clock_ok: number }, []>(
      `SELECT boot, last_seen_mono, last_seen_ms, clock_ok FROM device_state WHERE device_id = 0`,
    )
    .get();
}

describe("when the writer flushes (section 5)", () => {
  test("at once for anything staged now, with everything else staged and the commit mark", () => {
    const { writer } = store;
    writer.stage([record("routine", rxRecord(seqOf(1, 0), 3, clock.wall))]);
    expect(writer.dueReason(clock.mono)).toBeUndefined();
    writer.stage([write("now", { table: "devices", op: "upsert", row: deviceRow(3) })]);
    expect(writer.dueReason(clock.mono)).toBe("now");
    expect(writer.due(clock.mono)).toBe(clock.mono);
    const commit = writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(commit).toMatchObject({ committed: true, reason: "now", items: 2 });
    expect(count("devices")).toBe(1);
    expect(count("rx_routine")).toBe(1);
    expect(mark()).toEqual({
      boot: BOOT,
      last_seen_mono: clock.mono,
      last_seen_ms: clock.wall,
      clock_ok: 1,
    });
    expect(writer.due(clock.mono)).toBeUndefined();
  });

  test("five minutes after the first routine item entered an empty batch, not later ones", () => {
    const { writer } = store;
    const first = clock.mono;
    writer.stage([record("routine", rxRecord(seqOf(1, 0), 3, clock.wall))]);
    expect(writer.due(clock.mono)).toBe(monoAfterMs(first, 5 * MINUTE_MS));
    clock.advanceMs(4 * MINUTE_MS);
    writer.stage([record("routine", rxRecord(seqOf(1, 1), 3, clock.wall))]);
    expect(writer.due(clock.mono)).toBe(monoAfterMs(first, 5 * MINUTE_MS));
    clock.advanceMs(MINUTE_MS - 1);
    expect(writer.flushIfDue(clock.mono)._unsafeUnwrap()).toBeUndefined();
    clock.advanceMs(1);
    expect(writer.flushIfDue(clock.mono)._unsafeUnwrap()).toMatchObject({
      reason: "due",
      items: 2,
    });
    expect(writer.due(clock.mono)).toBeUndefined();
  });

  test("at 2,000 items ‡", () => {
    const { writer } = store;
    const { flushItems } = DEFAULT_RULES.persistence;
    for (let n = 0; n < flushItems - 1; n++)
      writer.stage([record("routine", rxRecord(seqOf(1, n), 3, clock.wall))]);
    expect(writer.dueReason(clock.mono)).toBeUndefined();
    writer.stage([record("routine", rxRecord(seqOf(1, flushItems), 3, clock.wall))]);
    expect(writer.dueReason(clock.mono)).toBe("size");
    expect(writer.flushIfDue(clock.mono)._unsafeUnwrap()).toMatchObject({
      reason: "size",
      items: flushItems,
    });
  });

  test("at 512 KB ‡", () => {
    const { writer } = store;
    const big = (n: number) =>
      record("routine", {
        kind: "rx",
        table: "event",
        row: { ...rxRow(seqOf(1, n), 3, clock.wall), body: new Uint8Array(64 * 1024) },
      } as const);
    for (let n = 0; n < 7; n++) writer.stage([big(n)]);
    expect(writer.dueReason(clock.mono)).toBeUndefined();
    writer.stage([big(7)]);
    expect(writer.dueReason(clock.mono)).toBe("size");
  });

  test("every second while a countdown or the alarm runs, with only the commit mark", () => {
    const { writer } = store;
    writer.stage([write("now", { table: "devices", op: "upsert", row: deviceRow(3) })]);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    writer.setCadence(1_000);
    expect(writer.due(clock.mono)).toBe(monoAfterMs(clock.mono, SECOND_MS));
    clock.advanceMs(SECOND_MS);
    expect(writer.flushIfDue(clock.mono)._unsafeUnwrap()).toMatchObject({
      committed: true,
      reason: "cadence",
      items: 0,
    });
    expect(mark()?.last_seen_mono).toBe(clock.mono);
    writer.setCadence(300_000);
    clock.advanceMs(10 * SECOND_MS);
    expect(writer.due(clock.mono)).toBeUndefined();
    expect(writer.stats.commitsByReason.cadence).toBe(1);
  });

  test("with nothing staged and nothing running, nothing is written", () => {
    const { writer } = store;
    clock.advanceMs(HOUR_MS);
    expect(writer.due(clock.mono)).toBeUndefined();
    expect(writer.flush("due")._unsafeUnwrap()).toMatchObject({ committed: false });
    expect(writer.flush("log")._unsafeUnwrap()).toMatchObject({ committed: false });
    expect(writer.stats.commits).toBe(0);
    expect(mark()).toBeNull();
  });

  test("retention's deletes wait for the next commit and never start the five minutes (section 6)", () => {
    const { writer } = store;
    writer.stage([
      write("routine", { table: "rx_routine", op: "prune", beforeMs: clock.wall, limit: 10 }),
    ]);
    expect(writer.due(clock.mono)).toBeUndefined();
    writer.stage([record("routine", rxRecord(seqOf(1, 0), 3, clock.wall))]);
    expect(writer.due(clock.mono)).toBe(monoAfterMs(clock.mono, 5 * MINUTE_MS));
  });

  test("at a clean stop, with everything staged and the clean-stop mark in this boot's row", () => {
    const { writer } = store;
    const boot = {
      id: BOOT,
      startedMs: clock.wall,
      startedTrusted: true,
      previousExit: "clean",
      cause: null,
      cleanStopMs: null,
      trustedAtMono: null,
      clockStepMs: null,
    } as const;
    writer.stage([write("now", { table: "boots", op: "upsert", row: boot })]);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    clock.advanceMs(MINUTE_MS);
    writer.stage([record("routine", rxRecord(seqOf(1, 0), 3, clock.wall))]);
    expect(writer.stop()._unsafeUnwrap()).toMatchObject({
      committed: true,
      reason: "stop",
      items: 1,
    });
    expect(store.db.query("SELECT clean_stop_ms FROM boots WHERE id = 1").get()).toEqual({
      clean_stop_ms: clock.wall,
    });
    expect(count("rx_routine")).toBe(1);
  });
});

describe("staging (section 5, 'Staged items')", () => {
  test("a row updated many times is written once, with its last value", () => {
    const { writer } = store;
    for (let n = 0; n < 10; n++) {
      clock.advanceMs(30 * SECOND_MS);
      writer.stage([
        write("routine", {
          table: "device_state",
          op: "upsert",
          row: deviceStateRow(3, clock.mono, n),
        }),
      ]);
    }
    expect(writer.staged).toBe(1);
    expect(writer.flush("due")._unsafeUnwrap().items).toBe(1);
    const row = store.reader
      .snapshot()
      ._unsafeUnwrap()
      .deviceState.find((r) => r.deviceId === deviceId(3));
    expect(row?.reading).toEqual(new Uint8Array([9, 0x40, 0x10]));
  });

  test("records are kept in order and every one is written", () => {
    const { writer } = store;
    for (let n = 0; n < 10; n++)
      writer.stage([record("routine", rxRecord(seqOf(1, n), 3, clock.wall))]);
    expect(writer.staged).toBe(10);
    writer.flush("due")._unsafeUnwrap();
    expect(
      store.db
        .query<{ seq: number }, []>("SELECT seq FROM rx_routine ORDER BY rowid")
        .all()
        .map((r) => r.seq),
    ).toEqual(Array.from({ length: 10 }, (_, n) => seqOf(1, n)));
  });

  test("the last write of a row wins, wherever its earlier writes were", () => {
    const { writer } = store;
    const key = { deviceId: deviceId(3) };
    writer.stage([
      write("now", { table: "sensor_config", op: "upsert", row: sensorConfigRow(3, 7) }),
    ]);
    writer.stage([write("now", { table: "sensor_config", op: "delete", key })]);
    writer.stage([
      write("now", { table: "sensor_config", op: "upsert", row: sensorConfigRow(3, 9) }),
    ]);
    writer.stage([
      write("now", { table: "countdowns", op: "delete", key: { sensorId: deviceId(4) } }),
    ]);
    expect(writer.staged).toBe(2);
    writer.flush("now")._unsafeUnwrap();
    expect(
      store.reader
        .snapshot()
        ._unsafeUnwrap()
        .sensorConfig.map((r) => r.version),
    ).toEqual([9]);
  });

  test("a routine write folded into a now write of the same row stays now", () => {
    const { writer } = store;
    writer.stage([
      write("now", { table: "device_state", op: "upsert", row: deviceStateRow(3, clock.mono, 1) }),
    ]);
    writer.stage([
      write("routine", {
        table: "device_state",
        op: "upsert",
        row: deviceStateRow(3, clock.mono, 2),
      }),
    ]);
    expect(writer.dueReason(clock.mono)).toBe("now");
  });

  test("a minute's rejection count is upserted by source and reason, once", () => {
    const { writer } = store;
    const minute = Math.floor(clock.wall / MINUTE_MS);
    for (let count = 1; count <= 5; count++) {
      writer.stage([
        record("routine", {
          kind: "reject",
          row: {
            minute,
            via: "device:2",
            reason: "badTag",
            count,
            address: 7,
            sample: new Uint8Array(16),
          },
        }),
      ]);
    }
    expect(writer.staged).toBe(1);
    writer.flush("due")._unsafeUnwrap();
    writer.stage([
      record("routine", {
        kind: "reject",
        row: {
          minute,
          via: "device:2",
          reason: "badTag",
          count: 6,
          address: 7,
          sample: new Uint8Array(16),
        },
      }),
    ]);
    writer.flush("due")._unsafeUnwrap();
    expect(store.db.query("SELECT count FROM rejects").all()).toEqual([{ count: 6 }]);
  });
});

describe("a failed flush (section 5)", () => {
  function breakTheDisk(): void {
    const pages =
      store.db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
    store.db.run(`PRAGMA max_page_count = ${pages}`);
  }
  function repairTheDisk(): void {
    store.db.run("PRAGMA max_page_count = 1073741823");
  }
  const bigRecord = (n: number) =>
    record("now", {
      kind: "rx",
      table: "event",
      row: { ...rxRow(seqOf(1, n), 3, 0), body: new Uint8Array(8192) },
    } as const);

  test("keeps the batch, writes nothing, tells the core, retries after 1, 2, 4, then every 10 s ‡", () => {
    const { writer } = store;
    const failures: string[] = [];
    breakTheDisk();
    writer.stage([
      write("now", { table: "devices", op: "upsert", row: deviceRow(3) }),
      bigRecord(0),
    ]);
    const failed = writer.flushIfDue(clock.mono);
    expect(failed._unsafeUnwrapErr()).toMatchObject({
      kind: "storage",
      detail: { code: "SQLITE_FULL" },
    });
    failures.push(failed._unsafeUnwrapErr().message);
    expect(writer.staged).toBe(2);
    expect(count("devices")).toBe(0);
    expect(mark()).toBeNull();
    expect(writer.takeOutcome()).toMatchObject({ kind: "failed" });
    expect(writer.takeOutcome()).toBeUndefined();
    const gaps: number[] = [];
    let last = clock.mono;
    for (let attempt = 0; attempt < 5; attempt++) {
      const due = writer.due(clock.mono);
      expect(due).toBeDefined();
      if (due === undefined) return;
      gaps.push((due - last) / 1000);
      clock.advanceMs((due - clock.mono) / 1000 - 1);
      expect(writer.flushIfDue(clock.mono)._unsafeUnwrap()).toBeUndefined();
      clock.advanceMs(1);
      last = clock.mono;
      expect(writer.flushIfDue(clock.mono).isErr()).toBe(true);
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000, 10_000, 10_000]);
    expect(RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 10_000]);
    repairTheDisk();
    const due = writer.due(clock.mono) ?? clock.mono;
    clock.advanceMs((due - clock.mono) / 1000);
    expect(writer.flushIfDue(clock.mono)._unsafeUnwrap()).toMatchObject({
      committed: true,
      items: 2,
    });
    expect(writer.takeOutcome()).toEqual({ kind: "recovered" });
    // A full disk is the size guard's hard stop: trimming began, and ends at once here, the
    // pages in use being far under its lower mark (section 6).
    expect(writer.takeOutcome()).toMatchObject({ kind: "trimEnded" });
    expect(count("devices")).toBe(1);
    expect(count("rx_event")).toBe(1);
    expect(writer.stats.failures).toBe(6);
  });

  test("past 10,000 items it drops its oldest records, routine first, never a write, and says how many", () => {
    const { writer } = store;
    breakTheDisk();
    expect(FAILING_BATCH_CAP).toBe(10_000);
    // The oldest item is a routine write: a write is never dropped, however old.
    writer.stage([
      write("routine", {
        table: "device_state",
        op: "upsert",
        row: deviceStateRow(4, clock.mono, 7),
      }),
      bigRecord(0),
      write("now", { table: "devices", op: "upsert", row: deviceRow(3) }),
    ]);
    expect(writer.flushIfDue(clock.mono).isErr()).toBe(true);
    writer.takeOutcome();
    for (let n = 1; n < FAILING_BATCH_CAP; n++)
      writer.stage([record("routine", rxRecord(seqOf(1, n), 3, clock.wall))]);
    expect(writer.staged).toBe(FAILING_BATCH_CAP);
    expect(writer.stats.droppedRecords).toBe(2);
    clock.advanceMs(10 * SECOND_MS);
    expect(writer.flushIfDue(clock.mono).isErr()).toBe(true);
    const outcome = writer.takeOutcome();
    expect(outcome?.kind === "failed" && outcome.message).toContain("2 records dropped");
    repairTheDisk();
    clock.advanceMs(10 * SECOND_MS);
    expect(writer.flushIfDue(clock.mono).isOk()).toBe(true);
    expect(count("devices")).toBe(1);
    expect(count("rx_event")).toBe(1);
    expect(
      store.db.query("SELECT count(*) AS n FROM device_state WHERE device_id = 4").get(),
    ).toEqual({ n: 1 });
    expect(store.db.query("SELECT min(seq) AS first FROM rx_routine").get()).toEqual({
      first: seqOf(1, 3),
    });
  });

  test("a failure is reported at once, for fatal.log", () => {
    const failures: string[] = [];
    breakTheDisk();
    const writer = new SqliteWriter({
      db: store.db,
      path: store.path,
      pageSize: PAGE_SIZE,
      statements: store.statements,
      clock,
      boot: BOOT,
      rules: DEFAULT_RULES.persistence,
      durable: new Map(),
      onFailed: (error) => failures.push(error.message),
    });
    writer.stage([bigRecord(0)]);
    expect(writer.flushIfDue(clock.mono).isErr()).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("full");
  });
});

describe("checkpoints the writer runs itself (section 5, `wal_autocheckpoint`)", () => {
  function walFramesNow(): number {
    return store.db.query<{ log: number }, []>("PRAGMA wal_checkpoint(PASSIVE)").get()?.log ?? -1;
  }

  test("once the WAL holds 1,000 pages ‡, after a routine commit", () => {
    const { writer } = store;
    const body = new Uint8Array(3000);
    let n = 0;
    // Section 5: 1,000 pages ‡, written from the design.
    const pages = 1_000;
    expect(CHECKPOINT_FRAMES).toBe(pages);
    // Bounded: each commit adds at least a frame, so 2,000 commits pass 1,000 pages or fail.
    for (let commits = 0; writer.stats.walFrames < pages; commits++) {
      expect(commits).toBeLessThan(2 * pages);
      writer.stage([
        record("routine", {
          kind: "rx",
          table: "event",
          row: { ...rxRow(seqOf(1, n++), 3, clock.wall), body },
        }),
      ]);
      writer.flush("due")._unsafeUnwrap();
      if (writer.stats.walFrames < pages) expect(writer.stats.checkpoints).toBe(0);
    }
    expect(writer.stats.checkpoints).toBe(1);
    expect(writer.stats.checkpointedFrames).toBe(writer.stats.walFrames);
  });

  test("never right after a now commit, whose sends wait: after them, in `maintain`", () => {
    const { writer } = store;
    writer.stage([record("routine", rxRecord(seqOf(1, 0), 3, clock.wall))]);
    writer.flush("due")._unsafeUnwrap();
    clock.advanceMs(HOUR_MS);
    writer.stage([write("now", { table: "devices", op: "upsert", row: deviceRow(3) })]);
    writer.flushIfDue(clock.mono)._unsafeUnwrap();
    expect(writer.stats.checkpoints).toBe(0);
    expect(writer.maintain().isOk()).toBe(true);
    expect(writer.stats.checkpoints).toBe(1);
    expect(walFramesNow()).toBeGreaterThanOrEqual(0);
  });

  test("an hour ‡ after the last, with something committed since", () => {
    const { writer } = store;
    writer.stage([record("routine", rxRecord(seqOf(1, 0), 3, clock.wall))]);
    writer.flush("due")._unsafeUnwrap();
    expect(writer.stats.checkpoints).toBe(0);
    clock.advanceMs(HOUR_MS);
    writer.stage([record("routine", rxRecord(seqOf(1, 1), 3, clock.wall))]);
    writer.flush("due")._unsafeUnwrap();
    expect(writer.stats.checkpoints).toBe(1);
    expect(writer.stats.checkpointedFrames).toBe(writer.stats.walFrames);
  });

  test("the frames counted per commit are the WAL's frames", () => {
    const { writer } = store;
    for (let n = 0; n < 50; n++) {
      writer.stage([record("now", rxRecord(seqOf(1, n), 3, clock.wall, "event"))]);
      writer.flushIfDue(clock.mono)._unsafeUnwrap();
      writer.maintain()._unsafeUnwrap();
    }
    const counted = writer.stats.walFrames;
    writer.checkpointNow()._unsafeUnwrap();
    expect(writer.stats.checkpointedFrames).toBe(counted);
    expect(writer.stats.walFramesUnknown).toBe(0);
  });
});

describe("prepared statements (section 5)", () => {
  test("the hot path prepares nothing new", () => {
    const { writer, db } = store;
    let prepared = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      prepared++;
      return prepare(sql);
    };
    for (let n = 0; n < 20; n++) {
      writer.stage([
        record("routine", rxRecord(seqOf(1, n), 3, clock.wall)),
        record("now", hubEventRecord(seqOf(1, 100 + n), clock.wall, "warning")),
        write("routine", {
          table: "device_state",
          op: "upsert",
          row: deviceStateRow(3, clock.mono, n),
        }),
      ]);
      writer.flushIfDue(clock.mono)._unsafeUnwrap();
    }
    expect(prepared).toBe(0);
    expect(count("hub_events")).toBe(20);
  });
});

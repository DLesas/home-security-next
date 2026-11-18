/**
 * M2's two audit tables are pruned by retention on the real store (m2-design.md section 4):
 * `notifications` older than the event retention (1 year by default) and `notification_reads` older
 * than the routine retention (30 days), each in retention's batches; younger rows stay.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { retentionRound } from "../../../src/core/audit/retention.ts";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import { clientId, seq } from "../../../src/core/model/ids.ts";
import type { OpenedStore } from "../../../src/shell/storage/store.ts";
import {
  DAY_MS,
  openTestStore,
  record,
  seqOf,
  tempDir,
  TestClock,
  WALL_AT_START_MS,
  write,
} from "./fixtures.ts";

let dir: ReturnType<typeof tempDir>;
let store: OpenedStore;

beforeEach(() => {
  dir = tempDir("notification-retention");
  store = openTestStore(dir.path, new TestClock());
});
afterEach(() => {
  store.db.close(true);
  dir.remove();
});

const NOW = WALL_AT_START_MS + 400 * DAY_MS;

function notification(n: number, ageDays: number): AuditRecord {
  return {
    kind: "notification",
    row: {
      seq: seqOf(1, n),
      atMs: NOW - ageDays * DAY_MS,
      clockOk: true,
      kind: "battery_low",
      category: "batteryLow",
      critical: false,
      deviceId: null,
      causeSeq: null,
      recipients: new Uint8Array([1, 0, 0, 0]),
      detail: null,
    },
  };
}

function read(n: number, ageDays: number): AuditRecord {
  return {
    kind: "notificationRead",
    row: {
      seq: seqOf(1, n),
      atMs: NOW - ageDays * DAY_MS,
      clockOk: true,
      notificationSeq: seq(seqOf(1, 1)),
      clientId: clientId(7),
    },
  };
}

const count = (table: string): number =>
  store.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()?.n ?? 0;

describe("retention of notifications and their reads (section 4)", () => {
  test("a year for notifications, 30 days for reads, younger ones kept", () => {
    store.writer.stage([
      record("now", notification(1, 400)),
      record("now", notification(2, 366)),
      record("now", notification(3, 364)),
      record("now", read(4, 45)),
      record("now", read(5, 31)),
      record("now", read(6, 29)),
    ]);
    store.writer.flush("now")._unsafeUnwrap();
    expect([count("notifications"), count("notification_reads")]).toEqual([3, 3]);
    const ops = retentionRound({ routineDays: 30, eventDays: 365 }, NOW, 2000);
    store.writer.stage(ops.map((op) => write("routine", op)));
    store.writer.flush("due")._unsafeUnwrap();
    expect([count("notifications"), count("notification_reads")]).toEqual([1, 1]);
  });
});

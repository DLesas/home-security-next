/**
 * The relay module at a start (docs/m4-design.md section 4): its tables rebuilt, each outbox row
 * joined with its notification; rows that cannot be pushed any more deleted, and those whose
 * notification is gone recorded as dropped; ids above every stored row's.
 */
import { describe, expect, test } from "bun:test";
import { outboxId, seq, RECORDS_PER_BOOT } from "../../../src/core/model/ids.ts";
import type { NotificationRow, PushOutboxRow } from "../../../src/core/model/rows.ts";
import {
  ANNA_PHONE,
  BEN_PHONE,
  BEN_PHONE2,
  bootedView,
  DAY_US,
  hubEvents,
  LOCAL_URL,
  outboxDeletes,
  pushes,
  relaySnapshot,
  Runner,
  S1,
  targetRow,
  WALL0,
} from "./support.ts";

function notification(n: number, overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    seq: seq(RECORDS_PER_BOOT + n),
    atMs: WALL0,
    clockOk: true,
    kind: "countdown_started",
    category: "countdown",
    critical: true,
    deviceId: S1,
    causeSeq: null,
    recipients: new Uint8Array(),
    detail: null,
    ...overrides,
  };
}

function row(id: number, n: number, client = ANNA_PHONE, createdMs = WALL0): PushOutboxRow {
  return {
    id: outboxId(id),
    notificationSeq: seq(RECORDS_PER_BOOT + n),
    clientId: client,
    createdMs,
    attempts: 1,
    armed: 0,
    facts: null,
  };
}

function bootWith(
  rows: readonly PushOutboxRow[],
  notifications: readonly NotificationRow[],
  advanceUs = 0,
) {
  const snapshot = relaySnapshot(
    [ANNA_PHONE, BEN_PHONE, BEN_PHONE2],
    { url: LOCAL_URL, revision: 2 },
    {
      pushOutbox: rows,
      pushTargets: [
        targetRow(ANNA_PHONE),
        targetRow(BEN_PHONE, { invalidMs: WALL0 }),
        targetRow(BEN_PHONE2),
      ],
    },
    notifications,
  );
  const runner = new Runner(bootedView(snapshot));
  runner.advance(advanceUs);
  return { runner, booted: runner.boot(snapshot) };
}

describe("at a start", () => {
  test("each row with its notification and a phone to push to is kept, as written, waiting", () => {
    const { runner, booted } = bootWith(
      [row(7, 1), row(9, 2, BEN_PHONE2)],
      [
        notification(1),
        notification(2, { critical: false, category: "batteryLow", kind: "battery_low" }),
      ],
    );
    expect(
      [...runner.slice.outbox.values()].map((p) => [p.row, p.inFlight, p.notice.kind]),
    ).toEqual([
      [row(7, 1), false, "countdown_started"],
      [row(9, 2, BEN_PHONE2), false, "battery_low"],
    ]);
    expect(runner.slice.nextId).toBe(10);
    expect(booted.effects.filter((e) => e.kind === "relayConnect")).toEqual([
      { kind: "relayConnect", url: LOCAL_URL },
    ]);
    expect(pushes(booted.out)).toEqual([]);
    expect(runner.slice.settings).toEqual({ url: LOCAL_URL, revision: 2 });
    // The link up sends them, the first attempt after the restart counted on top.
    const up = runner.up();
    expect(pushes(up.out).map((p) => p.id)).toEqual([outboxId(7), outboxId(9)]);
  });

  test("a row whose phone's target is invalid is deleted, unrecorded", () => {
    const { runner, booted } = bootWith([row(3, 1, BEN_PHONE)], [notification(1)]);
    expect(runner.slice.outbox.size).toBe(0);
    expect(outboxDeletes(booted.out)).toEqual([outboxId(3)]);
    expect(hubEvents(booted.out)).toEqual([]);
  });

  test("a row whose notification is not in the snapshot: dropped, `missing` under 7 days ‡, `age` at 7 days", () => {
    const { runner, booted } = bootWith(
      [row(1, 1), row(2, 5, ANNA_PHONE, WALL0), row(3, 6, ANNA_PHONE, WALL0 + 1)],
      [notification(1)],
      7 * DAY_US,
    );
    // Row 1 has its notification but is itself 7 days old: dropped at the start too, not left
    // for a deadline already due.
    expect([...runner.slice.outbox.keys()]).toEqual([]);
    expect(outboxDeletes(booted.out)).toEqual([outboxId(2), outboxId(3), outboxId(1)]);
    expect(hubEvents(booted.out).map((e) => e.detail)).toEqual([
      { reason: "age", rows: 1 },
      { reason: "missing", rows: 1 },
      { reason: "age", rows: 1 },
    ]);
    expect(runner.timerAt("outboxExpiry")).toBeUndefined();
  });

  test("a row 1 ms short of 7 days is kept, its expiry 1 ms later", () => {
    const { runner } = bootWith([row(1, 1, ANNA_PHONE, WALL0 + 1)], [notification(1)], 7 * DAY_US);
    expect([...runner.slice.outbox.keys()]).toEqual([outboxId(1)]);
    expect(runner.timerAt("outboxExpiry")).toBe(runner.now.mono + 1000);
  });

  test("a row's armed and facts are read back; facts of a form not ours are none", () => {
    const facts = JSON.stringify({
      seq: RECORDS_PER_BOOT + 40,
      kind: "countdown_started",
      value: 30,
    });
    const { runner } = bootWith(
      [
        { ...row(1, 1), armed: 1, facts },
        { ...row(2, 2), armed: 0, facts: '{"seq":1,"kind":"other","value":3}' },
        { ...row(3, 3), facts: "{not json" },
      ],
      [notification(1), notification(2), notification(3)],
    );
    const restored = [...runner.slice.outbox.values()];
    expect(restored.map((p) => [p.row.armed, p.cause])).toEqual([
      [1, { seq: seq(RECORDS_PER_BOOT + 40), kind: "countdown_started", value: 30, at: null }],
      [0, undefined],
      [0, undefined],
    ]);
    const up = runner.up();
    const [first, second] = pushes(up.out);
    expect([first?.content.armed, first?.content.detail]).toEqual([true, { seconds: 30 }]);
    expect([second?.content.armed, second?.content.detail]).toEqual([false, undefined]);
  });

  test("an alarm's event time is read back: the push after the start says when the countdown ended, late", () => {
    const endedAtMs = WALL0 - 5 * 3_600_000;
    const facts = JSON.stringify({
      seq: RECORDS_PER_BOOT + 40,
      kind: "alarm",
      value: null,
      at: endedAtMs,
    });
    const { runner } = bootWith(
      [{ ...row(1, 1), facts }],
      [notification(1, { kind: "alarm", category: "alarm" })],
    );
    expect(runner.slice.outbox.get(outboxId(1))?.cause).toEqual({
      seq: seq(RECORDS_PER_BOOT + 40),
      kind: "alarm",
      value: null,
      at: endedAtMs,
    });
    const [push] = pushes(runner.up().out);
    expect(push?.content.detail).toEqual({ endedAtMs });
    expect(push?.content.delayed).toBe(true);
  });

  test("a notification of a category this version does not know is not pushed", () => {
    const { runner } = bootWith([row(1, 1)], [notification(1, { category: "notACategory" })]);
    expect(runner.slice.outbox.size).toBe(0);
  });

  test("an empty outbox starts its ids at 1, with no expiry timer", () => {
    const { runner } = bootWith([], []);
    expect(runner.slice.nextId).toBe(1);
    expect(runner.timerAt("outboxExpiry")).toBeUndefined();
    expect(runner.timerAt("unreachable")).toBeDefined();
  });
});

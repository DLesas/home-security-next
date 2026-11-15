/**
 * The untrusted clock and missed entries (m2-design.md section 7, "Schedules"; D116; HD 5, "The
 * clock"), the clock stepping while the hub runs, and held-back disarms (D117).
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { downtime } from "../../../src/core/clock/view.ts";
import type { Context } from "../../../src/core/model/handler.ts";
import { seq } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import { ScheduleAction } from "../../../src/core/model/rows.ts";
import { handleSchedules } from "../../../src/core/schedules/handle.ts";
import { scheduleObjects } from "../../../src/core/schedules/view.ts";
import {
  DAY,
  day,
  decisions,
  HOUR,
  Hub,
  idOf,
  MINUTE,
  missedOf,
  OTHER_SENSOR,
  scheduleWrites,
  scheduleRow,
  SENSOR,
  START,
  ranOf,
  u32s,
  utc,
} from "./support.ts";

/** 22:00 BST on 1 July 2026. */
const TEN_PM = utc(2026, 7, 1, 21);

describe("an untrusted clock (section 7; HD 5)", () => {
  test("no entry runs and there is no next time; one warning, schedules_waiting_for_clock", () => {
    const hub = new Hub();
    hub.trusted = false;
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    expect(hub.state.schedules.timers).toEqual([]);
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBeNull();
    hub.advanceTo(TEN_PM + HOUR);
    hub.advance(DAY);
    expect(hub.requests).toEqual([]);
    const warned = decisions(hub.all, "schedules_waiting_for_clock");
    expect(warned.map((d) => d.value)).toEqual([0]);
  });

  test("with no entry enabled, nothing to warn of", () => {
    const hub = new Hub();
    hub.trusted = false;
    hub.boot({ schedules: [scheduleRow({ id: 1, enabled: false })] });
    hub.advance(HOUR);
    expect(decisions(hub.all, "schedules_waiting_for_clock")).toEqual([]);
  });

  test("when the clock is trusted, what fell due meanwhile is missed, never run late", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.advance(HOUR); // this run is trusted from its start until 14:00 BST
    hub.trusted = false;
    hub.tick();
    expect(hub.state.schedules.timers).toEqual([]);
    // Three evenings pass on an untrusted clock.
    hub.advanceTo(utc(2026, 7, 4, 12));
    expect(hub.requests).toEqual([]);
    hub.trusted = true;
    const effects = hub.tick();
    expect(hub.requests).toEqual([]);
    const missed = decisions(effects, "schedule_missed");
    expect(missed.length).toBe(1);
    expect(missed[0]).toMatchObject({ value: 1, deviceId: null });
    expect(missedOf(missed[0] ?? ({} as never))).toEqual({
      why: 1, // clock not set
      count: 3,
      firstMs: TEN_PM,
      lastMs: TEN_PM + 2 * DAY,
    });
    const [object] = scheduleObjects(hub.state);
    // The row keeps the last miss, its reason and the count since the last run, written now.
    expect(object?.missed).toEqual({ dueMs: TEN_PM + 2 * DAY, why: "clockNotSet", count: 3 });
    const rows = scheduleWrites(effects).flatMap((w) =>
      w.op.table === "schedules" && w.op.op === "upsert"
        ? [
            {
              durability: w.durability,
              missedDueMs: w.op.row.missedDueMs,
              missedWhy: w.op.row.missedWhy,
              missedCount: w.op.row.missedCount,
            },
          ]
        : [],
    );
    expect(rows).toEqual([
      { durability: "now", missedDueMs: TEN_PM + 2 * DAY, missedWhy: 1, missedCount: 3 },
    ]);
    expect(object?.nextMs).toBe(TEN_PM + 3 * DAY);
    // It shows until the entry next runs, which it does on time.
    hub.runUntil(TEN_PM + 3 * DAY);
    expect(hub.requests.length).toBe(1);
    expect(scheduleObjects(hub.state)[0]?.missed).toBeNull();
  });

  test("an entry due in the very step the trust is lost is missed, not lost", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.monoUs += (TEN_PM - hub.wall) * 1000;
    hub.wall = TEN_PM;
    hub.trusted = false;
    hub.tick();
    expect(hub.requests).toEqual([]);
    hub.advance(HOUR);
    hub.trusted = true;
    const missed = decisions(hub.tick(), "schedule_missed");
    expect(missed.map((d) => missedOf(d))).toEqual([
      { why: 1, count: 1, firstMs: TEN_PM, lastMs: TEN_PM },
    ]);
  });

  test("an entry made while the clock is untrusted gets the warning, if not yet given", () => {
    const hub = new Hub();
    hub.trusted = false;
    hub.boot({ mark: { wallMs: START - HOUR, clockOk: true } });
    expect(decisions(hub.all, "schedules_waiting_for_clock")).toEqual([]);
    hub.op({
      op: "schedule.create",
      body: {
        name: "Night",
        action: "switchMode",
        target: { mode: 3 },
        at: "22:00",
        days: "everyDay",
        enabled: true,
      },
    });
    expect(decisions(hub.all, "schedules_waiting_for_clock").length).toBe(1);
  });
});

describe("the hub off (D116)", () => {
  test("a start with a trusted clock: every occurrence since the last commit is missed, one decision", () => {
    // The last commit was at 12:00 BST on 1 July; the hub is back at 12:00 BST on 4 July.
    const hub = new Hub(utc(2026, 7, 4, 11));
    const effects = hub.boot({
      schedules: [
        scheduleRow({ id: 1 }),
        scheduleRow({
          id: 2,
          action: ScheduleAction.Disarm,
          modeId: null,
          sensorId: SENSOR,
          localTime: 7 * 60,
        }),
      ],
      mark: { wallMs: utc(2026, 7, 1, 11), clockOk: true },
    });
    expect(hub.requests).toEqual([]);
    const missed = decisions(effects, "schedule_missed");
    expect(missed.map((d) => [d.value, d.deviceId, missedOf(d)])).toEqual([
      [1, null, { why: 0, count: 3, firstMs: TEN_PM, lastMs: TEN_PM + 2 * DAY }],
      [2, SENSOR, { why: 0, count: 3, firstMs: utc(2026, 7, 2, 6), lastMs: utc(2026, 7, 4, 6) }],
    ]);
    expect(scheduleObjects(hub.state).map((o) => o.missed?.why)).toEqual(["hubOff", "hubOff"]);
    expect(scheduleObjects(hub.state).map((o) => o.nextMs)).toEqual([
      utc(2026, 7, 4, 21),
      utc(2026, 7, 5, 6),
    ]);
  });

  test("a start on an untrusted clock, trusted later: hub off before the start, clock not set after", () => {
    const hub = new Hub(utc(2026, 7, 2, 23)); // 00:00 BST on 3 July
    hub.trusted = false;
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: utc(2026, 7, 1, 11), clockOk: true },
    });
    expect(decisions(hub.all, "schedules_waiting_for_clock").map((d) => d.value)).toEqual([0]);
    hub.advanceTo(utc(2026, 7, 3, 23));
    hub.trusted = true;
    const missed = decisions(hub.tick(), "schedule_missed");
    expect(missed.map((d) => missedOf(d))).toEqual([
      { why: 0, count: 2, firstMs: TEN_PM, lastMs: TEN_PM + DAY },
      { why: 1, count: 1, firstMs: TEN_PM + 2 * DAY, lastMs: TEN_PM + 2 * DAY },
    ]);
    expect(hub.requests).toEqual([]);
  });

  test("the last commit's clock untrusted and the downtime unknown: only this start's time is judged, and the warning says so", () => {
    const hub = new Hub(utc(2026, 7, 3, 12));
    hub.trusted = false;
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: utc(2026, 7, 1, 11), clockOk: false },
    });
    expect(decisions(hub.all, "schedules_waiting_for_clock").map((d) => d.value)).toEqual([1]);
    hub.advanceTo(utc(2026, 7, 4, 12));
    hub.trusted = true;
    const missed = decisions(hub.tick(), "schedule_missed");
    expect(missed.map((d) => missedOf(d))).toEqual([
      { why: 1, count: 1, firstMs: utc(2026, 7, 3, 21), lastMs: utc(2026, 7, 3, 21) },
    ]);
    expect(downtime(hub.state).kind).toBe("unknown");
  });

  test("a downtime known later judges what fell due while the hub was off", () => {
    const hub = new Hub(utc(2026, 7, 3, 12));
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: utc(2026, 7, 1, 11), clockOk: false },
    });
    expect(decisions(hub.all, "schedule_missed")).toEqual([]);
    // The clock module says so when a gateway's uptime tells it (HD 5, way 2): handed straight
    // to the handler here.
    let n = 100;
    const ctx: Context = {
      now: hub.now,
      view: hub.state,
      deps: hub.deps,
      entropy: { take: () => ok(new Uint8Array()) },
      records: { take: () => ok(seq(n++)) },
      event: "tick",
    };
    const handled = handleSchedules(
      hub.state.schedules,
      { kind: "downtimeKnown", downtimeMs: 2 * DAY, source: "gatewayUptime" },
      ctx,
    )._unsafeUnwrap();
    const missed = handled.out.flatMap((m) =>
      m.kind === "auditRecord" && m.record.kind === "decision" ? [m.record.row] : [],
    );
    expect(missed.map((d) => [d.kind, missedOf(d)])).toEqual([
      ["schedule_missed", { why: 0, count: 2, firstMs: TEN_PM, lastMs: TEN_PM + DAY }],
    ]);
    expect(handled.slice.unjudgedBeforeMs).toBeUndefined();
  });
});

describe("a skipped date (section 7)", () => {
  test("Apia, 30 December 2011: across the hub being off, no miss for the date that did not happen", () => {
    // Off from 12:00 on 29 December (-10:00) to 12:00 on 1 January (+14:00), every day at 10:00.
    const hub = new Hub(utc(2011, 12, 31, 22));
    const effects = hub.boot({
      schedules: [scheduleRow({ id: 1, localTime: 10 * 60 })],
      zone: "Pacific/Apia",
      mark: { wallMs: utc(2011, 12, 29, 22), clockOk: true },
    });
    expect(decisions(effects, "schedule_missed").map((d) => missedOf(d))).toEqual([
      { why: 0, count: 2, firstMs: utc(2011, 12, 30, 20), lastMs: utc(2011, 12, 31, 20) },
    ]);
  });
});

describe("a miss survives a restart (section 4, schedules.missed_*)", () => {
  test("kept in the row, shown after the restart, cleared in the row when the entry next runs", () => {
    const first = new Hub(utc(2026, 7, 3, 11));
    const effects = first.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: utc(2026, 7, 1, 11), clockOk: true },
    });
    const written = scheduleWrites(effects).flatMap((w) =>
      w.op.table === "schedules" && w.op.op === "upsert" ? [w.op.row] : [],
    );
    expect(written.length).toBe(1);
    // The hub stops at once and starts again an hour later, from what was committed.
    const second = new Hub(utc(2026, 7, 3, 12));
    second.boot({ schedules: written, mark: { wallMs: utc(2026, 7, 3, 11), clockOk: true } }, 3);
    expect(decisions(second.all, "schedule_missed")).toEqual([]);
    expect(scheduleObjects(second.state)[0]?.missed).toEqual({
      dueMs: TEN_PM + DAY,
      why: "hubOff",
      count: 2,
    });
    const ran = second.runUntil(utc(2026, 7, 3, 21));
    expect(second.requests.length).toBe(1);
    expect(scheduleObjects(second.state)[0]?.missed).toBeNull();
    const cleared = scheduleWrites(ran).flatMap((w) =>
      w.op.table === "schedules" && w.op.op === "upsert" ? [w.op.row] : [],
    );
    expect(cleared.at(-1)).toMatchObject({ missedDueMs: null, missedWhy: null, missedCount: 0 });
  });
});

describe("misses since the last run, and once per local date (D87, D116)", () => {
  test("two gaps with no run between: the last miss is kept, and the count adds up", () => {
    const hub = new Hub(utc(2026, 7, 3, 11));
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    // Missed 1 and 2 July (hub off). Then the clock is untrusted over 3 and 4 July.
    hub.advance(HOUR);
    hub.trusted = false;
    hub.tick();
    hub.advanceTo(utc(2026, 7, 5, 12));
    hub.trusted = true;
    hub.tick();
    expect(decisions(hub.all, "schedule_missed").map((d) => missedOf(d).count)).toEqual([2, 2]);
    expect(scheduleObjects(hub.state)[0]?.missed).toEqual({
      dueMs: TEN_PM + 3 * DAY,
      why: "clockNotSet",
      count: 4,
    });
  });

  test("a disabled entry is not missed either: no decision, no row written", () => {
    const hub = new Hub(utc(2026, 7, 4, 11));
    const effects = hub.boot({
      schedules: [scheduleRow({ id: 1, enabled: false })],
      mark: { wallMs: utc(2026, 7, 1, 11), clockOk: true },
    });
    expect(decisions(effects, "schedule_missed")).toEqual([]);
    expect(scheduleWrites(effects)).toEqual([]);
    expect(scheduleObjects(hub.state)[0]?.missed).toBeNull();
  });

  test("across a restart, an occurrence that ran on its date is neither run again nor missed", () => {
    // It ran at 22:00; the clock then stepped back and the last commit stamped 21:30. The hub
    // starts again at 23:00: the gap (21:30, 23:00] holds 22:00 of the date it ran on.
    const hub = new Hub(TEN_PM + HOUR);
    const effects = hub.boot({
      schedules: [scheduleRow({ id: 1, lastRunMs: TEN_PM, lastRunLocalDate: day(2026, 7, 1) })],
      mark: { wallMs: TEN_PM - 30 * MINUTE, clockOk: true },
    });
    expect(decisions(effects, "schedule_missed")).toEqual([]);
    hub.runUntil(TEN_PM + 2 * HOUR);
    expect(hub.requests).toEqual([]);
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBe(TEN_PM + DAY);
  });

  test("the clock stepping back over the run, then forwards over it again: one run, no miss", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.runUntil(TEN_PM + 30 * MINUTE);
    expect(hub.requests.length).toBe(1);
    hub.wall -= 2 * HOUR; // 20:30 BST again
    hub.tick();
    hub.advance(10 * MINUTE);
    hub.wall += 3 * HOUR; // jumps over 22:00 of the date it already ran on
    hub.tick();
    hub.advance(HOUR);
    expect(hub.requests.length).toBe(1);
    expect(decisions(hub.all, "schedule_missed")).toEqual([]);
  });
});

describe("the clock stepping while the hub runs", () => {
  test("forwards over an entry's time: missed, not run late; the next one runs on time", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.advanceTo(TEN_PM - 30 * MINUTE);
    hub.wall += 2 * HOUR; // the clock is corrected: it is really 23:30
    const missed = decisions(hub.tick(), "schedule_missed");
    expect(missed.map((d) => missedOf(d))).toEqual([
      { why: 2 /* clock stepped */, count: 1, firstMs: TEN_PM, lastMs: TEN_PM },
    ]);
    expect(scheduleObjects(hub.state)[0]?.missed).toEqual({
      dueMs: TEN_PM,
      why: "clockStepped",
      count: 1,
    });
    hub.advance(HOUR);
    expect(hub.requests).toEqual([]);
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBe(TEN_PM + DAY);
    hub.runUntil(TEN_PM + DAY);
    expect(hub.requests.length).toBe(1);
  });

  test("forwards, in the step its time was reached by the time that passed: it runs", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.advanceTo(TEN_PM - MINUTE);
    hub.monoUs += MINUTE * 1000; // the entry's timer is due ...
    hub.wall += MINUTE + 3 * HOUR; // ... and the clock also stepped three hours
    const effects = hub.tick();
    expect(hub.requests.length).toBe(1);
    expect(decisions(effects, "schedule_missed")).toEqual([]);
    hub.advance(DAY - 3 * HOUR);
    expect(hub.requests.length).toBe(2);
  });

  test("a slewed clock (seconds off) moves the timer, and nothing is missed", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.advanceTo(TEN_PM - HOUR);
    hub.wall += 20_000; // 20 s ahead
    hub.tick();
    hub.runUntil(TEN_PM);
    expect(hub.requests.length).toBe(1);
    expect(decisions(hub.all, "schedule_ran")[0]?.atMs).toBe(TEN_PM);
    expect(decisions(hub.all, "schedule_missed")).toEqual([]);
  });

  test("backwards after an entry ran: it does not run again the same local date", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.runUntil(TEN_PM + 30 * MINUTE);
    expect(hub.requests.length).toBe(1);
    hub.wall -= 2 * HOUR; // 20:30 again
    hub.tick();
    hub.runUntil(TEN_PM + HOUR);
    expect(hub.requests.length).toBe(1);
    hub.runUntil(TEN_PM + DAY);
    expect(hub.requests.length).toBe(2);
  });

  test("backwards before an entry's time: it runs when the wall clock reaches it, not earlier", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.advanceTo(TEN_PM - 10 * MINUTE);
    hub.wall -= HOUR; // 20:50
    hub.tick();
    hub.monoUs += 15 * MINUTE * 1000; // when the old timer would have fired
    hub.wall += 15 * MINUTE;
    hub.tick();
    expect(hub.requests).toEqual([]);
    hub.runUntil(TEN_PM);
    expect(hub.requests.length).toBe(1);
    expect(decisions(hub.all, "schedule_ran")[0]?.atMs).toBe(TEN_PM);
  });

  test("a clock seconds ahead across an entry's time is no step: it runs, seconds late, not missed", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.advanceTo(TEN_PM - 10_000);
    hub.wall += 20_000; // corrected by 20 s, past 22:00
    hub.tick();
    hub.runUntil(TEN_PM + MINUTE);
    expect(hub.requests.length).toBe(1);
    expect(decisions(hub.all, "schedule_missed")).toEqual([]);
  });

  test("backwards by days: the next time is found again from the new reading", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: utc(2026, 6, 1), clockOk: true },
    });
    hub.advanceTo(TEN_PM - 2 * HOUR);
    hub.wall -= 2 * DAY; // 20:00 on 29 June
    hub.tick();
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBe(TEN_PM - 2 * DAY);
    hub.runUntil(TEN_PM - 2 * DAY - 1);
    expect(hub.requests).toEqual([]);
    hub.runUntil(TEN_PM - 2 * DAY);
    expect(hub.requests.length).toBe(1);
    // Records keep the highest wall time seen (HD 6), so the run's own time is in its row.
    expect(hub.state.schedules.entries.get(idOf(1))?.row.lastRunMs).toBe(TEN_PM - 2 * DAY);
  });

  test("backwards past the last commit: untrusted (HD 5), so schedules wait", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - MINUTE, clockOk: true },
    });
    hub.wall -= DAY;
    hub.tick();
    expect(hub.state.schedules.timers).toEqual([]);
    expect(decisions(hub.all, "schedules_waiting_for_clock").length).toBe(1);
  });
});

describe("a scheduled disarm during a countdown or an alarm holds back (D117)", () => {
  function disarmAtTen(): Hub {
    const hub = new Hub();
    hub.boot({
      schedules: [
        scheduleRow({ id: 1, action: ScheduleAction.Disarm, modeId: null, sensorId: SENSOR }),
      ],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    return hub;
  }

  test("the reply's heldBack is named in schedule_held_back, caused by the run's schedule_ran", () => {
    const hub = disarmAtTen();
    hub.responder = () => ({
      ok: true,
      body: { disarmed: [], heldBack: [SENSOR], alarmEnded: false },
    });
    const effects = hub.runUntil(TEN_PM);
    const [ran] = decisions(effects, "schedule_ran");
    const held = decisions(effects, "schedule_held_back");
    expect(held.map((d) => [d.value, d.deviceId, u32s(d.detail), d.causeSeq])).toEqual([
      [1, SENSOR, [SENSOR], ran?.seq ?? null],
    ]);
    // In the step of the run, written now with it.
    const step = hub.steps.find((s) => decisions(s, "schedule_held_back").length > 0) ?? [];
    expect(decisions(step, "schedule_ran").length).toBe(1);
  });

  test("a disarm whose reply holds nothing back records no schedule_held_back", () => {
    const hub = disarmAtTen();
    hub.responder = () => ({
      ok: true,
      body: { disarmed: [SENSOR], heldBack: [], alarmEnded: false },
    });
    const effects = hub.runUntil(TEN_PM);
    expect(decisions(effects, "schedule_ran").length).toBe(1);
    expect(decisions(effects, "schedule_held_back")).toEqual([]);
  });

  test("a scheduled arm runs as usual: what it found low is in schedule_ran, nothing held back", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [
        scheduleRow({ id: 1, action: ScheduleAction.Arm, modeId: null, sensorId: OTHER_SENSOR }),
      ],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.responder = () => ({
      ok: true,
      body: { armed: [OTHER_SENSOR], disarmed: [], waiting: [], lowBattery: [OTHER_SENSOR] },
    });
    const effects = hub.runUntil(TEN_PM);
    const [ran] = decisions(effects, "schedule_ran");
    expect(ranOf(ran ?? ({} as never))).toMatchObject({
      armed: [OTHER_SENSOR],
      low: [OTHER_SENSOR],
    });
    expect(decisions(effects, "schedule_held_back")).toEqual([]);
  });

  test("an answer naming another run's record is not this run's: it is closed as unanswered", () => {
    const hub = disarmAtTen();
    hub.answerTo = (asked) =>
      asked.kind === "schedule" ? { ...asked, record: seq(asked.record + 1) } : asked;
    hub.responder = () => ({
      ok: true,
      body: { disarmed: [], heldBack: [SENSOR], alarmEnded: false },
    });
    hub.runUntil(TEN_PM);
    expect(decisions(hub.all, "schedule_ran")).toEqual([]);
    expect(hub.state.schedules.inFlight.size).toBe(1);
    hub.advance(1);
    const [ran] = decisions(hub.all, "schedule_ran");
    expect(ranOf(ran ?? ({} as never)).outcome).toBe(2); // no answer
    expect(decisions(hub.all, "schedule_held_back")).toEqual([]);
    expect(hub.state.schedules.inFlight.size).toBe(0);
  });

  test("with two runs in flight, an answer naming the other schedule finishes neither", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [
        scheduleRow({ id: 1, action: ScheduleAction.Disarm, modeId: null, sensorId: SENSOR }),
        scheduleRow({ id: 2, action: ScheduleAction.Disarm, modeId: null, sensorId: OTHER_SENSOR }),
      ],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    // Each answer keeps its run's record but names the other schedule.
    hub.answerTo = (asked) =>
      asked.kind === "schedule"
        ? { ...asked, schedule: idOf(asked.schedule === idOf(1) ? 2 : 1) }
        : asked;
    hub.runUntil(TEN_PM);
    expect(hub.requests.length).toBe(2);
    expect(decisions(hub.all, "schedule_ran")).toEqual([]);
    expect(hub.state.schedules.inFlight.size).toBe(2);
    hub.advance(1);
    const ran = decisions(hub.all, "schedule_ran");
    expect(ran.map((d) => [d.value, ranOf(d).outcome])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("the core's timers run on the monotonic clock", () => {
  test("the entry's deadline is a Mono: its distance from now as the wall clock measures it", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    expect(hub.state.schedules.timers.map((t) => t.at)).toEqual([
      mono(hub.monoUs + (TEN_PM - START) * 1000),
    ]);
  });
});

/**
 * Schedule entries, their next times and running them (m2-design.md section 7, "Schedules";
 * D87, HB13, HB31): an entry is one action at one local time; it runs at that time, once and
 * never twice, its last run written in the same step as the arming its request causes.
 */
import { describe, expect, test } from "bun:test";
import type { ScheduleObject } from "@hsn/protocol/app";
import { ScheduleAction } from "../../../src/core/model/rows.ts";
import { scheduleObjects, schedulesNaming, timeZone } from "../../../src/core/schedules/view.ts";
import { groupId, modeId, scheduleId, seq } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  appError,
  body,
  DAY,
  day,
  decisions,
  HOUR,
  Hub,
  MINUTE,
  OTHER_SENSOR,
  ranOf,
  scheduleRow,
  scheduleWrites,
  SENSOR,
  START,
  utc,
} from "./support.ts";

/** 22:00 BST on 1 July 2026. */
const TEN_PM = utc(2026, 7, 1, 21);

function booted(...rows: Parameters<typeof scheduleRow>[0][]): Hub {
  const hub = new Hub();
  hub.boot({ schedules: rows.map(scheduleRow), mark: { wallMs: START - MINUTE, clockOk: true } });
  return hub;
}

describe("making entries (section 6: schedule.create, .update, .delete)", () => {
  test("create stores the entry now and answers it with its next time in the hub's zone", () => {
    const hub = booted();
    const reply = hub.op({
      op: "schedule.create",
      body: {
        name: "Night",
        action: "switchMode",
        target: { mode: 3 },
        at: "22:00",
        days: ["fri", "mon"],
        enabled: true,
      },
    });
    const object = body(reply) as ScheduleObject;
    // 1 July 2026 is a Wednesday: the next Friday is the 3rd, 22:00 BST.
    expect(object).toEqual({
      id: 1,
      name: "Night",
      action: "switchMode",
      target: { mode: 3 },
      at: "22:00",
      days: ["mon", "fri"],
      enabled: true,
      nextMs: utc(2026, 7, 3, 21),
      missed: null,
      revision: 1,
    });
    const writes = scheduleWrites(hub.steps.at(-1) ?? []);
    expect(writes.map((w) => [w.durability, w.op.table, w.op.op])).toEqual([
      ["now", "schedules", "upsert"],
    ]);
    // Its timer is a monotonic deadline: as far ahead as the wall time is.
    expect(hub.state.schedules.timers.map((t) => [t.at, t.key])).toEqual([
      [
        mono(hub.monoUs + (utc(2026, 7, 3, 21) - hub.wall) * 1000),
        { module: "schedules", kind: "entryDue", schedule: scheduleId(1) },
      ],
    ]);
  });

  test("every day is answered as everyDay; a date as a date", () => {
    const hub = booted();
    const daily = body(
      hub.op({
        op: "schedule.create",
        body: {
          name: "Daily",
          action: "arm",
          target: { sensor: SENSOR },
          at: "07:05",
          days: ["sun", "sat", "fri", "thu", "wed", "tue", "mon"],
          enabled: true,
        },
      }),
    ) as ScheduleObject;
    expect(daily.days).toBe("everyDay");
    expect(daily.nextMs).toBe(utc(2026, 7, 2, 6, 5));
    const once = body(
      hub.op({
        op: "schedule.create",
        body: {
          name: "Once",
          action: "disarm",
          target: { group: 4 },
          at: "09:00",
          days: { date: "2028-02-29" },
          enabled: true,
        },
      }),
    ) as ScheduleObject;
    expect(once.days).toEqual({ date: "2028-02-29" });
    expect(once.nextMs).toBe(utc(2028, 2, 29, 9));
  });

  test("a target that does not fit the action, or names no sensor, is refused", () => {
    const hub = booted();
    const fields = { name: "x", at: "22:00", days: "everyDay", enabled: true } as const;
    expect(
      appError(
        hub.op({ op: "schedule.create", body: { ...fields, action: "arm", target: { mode: 3 } } }),
      ),
    ).toEqual({ code: "invalid", detail: { field: "target", reason: "format" } });
    expect(
      appError(
        hub.op({
          op: "schedule.create",
          body: { ...fields, action: "switchMode", target: { group: 1 } },
        }),
      ),
    ).toEqual({ code: "invalid", detail: { field: "target", reason: "format" } });
    expect(
      appError(
        hub.op({
          op: "schedule.create",
          body: { ...fields, action: "arm", target: { sensor: 99 } },
        }),
      ),
    ).toEqual({ code: "invalid", detail: { field: "target.sensor", reason: "unknownReference" } });
    expect(
      appError(
        hub.op({
          op: "schedule.create",
          body: { ...fields, action: "switchMode", target: { mode: 9 } },
        }),
      ),
    ).toEqual({ code: "invalid", detail: { field: "target.mode", reason: "unknownReference" } });
    expect(
      appError(
        hub.op({
          op: "schedule.create",
          body: { ...fields, action: "disarm", target: { group: 9 } },
        }),
      ),
    ).toEqual({ code: "invalid", detail: { field: "target.group", reason: "unknownReference" } });
    expect(scheduleObjects(hub.state)).toEqual([]);
    // Mode 3 and group 4 exist: both are taken.
    expect(
      hub.op({
        op: "schedule.create",
        body: { ...fields, action: "switchMode", target: { mode: 3 } },
      }).ok,
    ).toBe(true);
    expect(
      hub.op({ op: "schedule.create", body: { ...fields, action: "arm", target: { group: 4 } } })
        .ok,
    ).toBe(true);
  });

  test("update needs the current revision: else conflict, with the entry as it is", () => {
    const hub = booted({ id: 4, revision: 2 });
    const fields = {
      schedule: 4,
      name: "Later",
      action: "switchMode",
      target: { mode: 3 },
      at: "23:00",
      days: "everyDay",
      enabled: true,
    } as const;
    const stale = appError(hub.op({ op: "schedule.update", body: { ...fields, ifRevision: 1 } }));
    expect(stale).toMatchObject({
      code: "conflict",
      detail: { revision: 2, object: { id: 4, at: "22:00" } },
    });
    expect(
      appError(
        hub.op({
          op: "schedule.update",
          body: { ...fields, action: "arm", target: { group: 9 }, ifRevision: 2 },
        }),
      ),
    ).toEqual({ code: "invalid", detail: { field: "target.group", reason: "unknownReference" } });
    const updated = body(
      hub.op({ op: "schedule.update", body: { ...fields, ifRevision: 2 } }),
    ) as ScheduleObject;
    expect(updated).toMatchObject({ id: 4, at: "23:00", revision: 3, nextMs: utc(2026, 7, 1, 22) });
    expect(
      appError(hub.op({ op: "schedule.update", body: { ...fields, schedule: 5, ifRevision: 0 } })),
    ).toEqual({ code: "notFound", detail: { what: "schedule", id: 5 } });
  });

  test("delete removes the row and its timer", () => {
    const hub = booted({ id: 4 });
    expect(hub.state.schedules.timers.length).toBe(1);
    expect(body(hub.op({ op: "schedule.delete", body: { schedule: 4, ifRevision: 1 } }))).toEqual(
      {},
    );
    expect(scheduleWrites(hub.steps.at(-1) ?? []).map((w) => [w.op.table, w.op.op])).toEqual([
      ["schedules", "delete"],
    ]);
    expect(hub.state.schedules.timers).toEqual([]);
    hub.advanceTo(TEN_PM + MINUTE);
    expect(hub.requests).toEqual([]);
  });

  test("schedulesNaming lists the entries that name a mode, group or sensor", () => {
    const hub = booted(
      { id: 1, modeId: modeId(3) },
      { id: 2, action: ScheduleAction.Arm, modeId: null, groupId: groupId(5) },
      { id: 3, action: ScheduleAction.Disarm, modeId: null, sensorId: SENSOR },
    );
    expect(schedulesNaming(hub.state, { mode: modeId(3) })).toEqual([scheduleId(1)]);
    expect(schedulesNaming(hub.state, { group: groupId(5) })).toEqual([scheduleId(2)]);
    expect(schedulesNaming(hub.state, { sensor: SENSOR })).toEqual([scheduleId(3)]);
    expect(schedulesNaming(hub.state, { sensor: OTHER_SENSOR })).toEqual([]);
  });
});

describe("running (section 7, Running)", () => {
  test("at its time, the action goes to layout as the schedule, answered to the schedule's run", () => {
    const hub = booted({ id: 1, name: "Night" });
    hub.advanceTo(TEN_PM - 1);
    expect(hub.requests).toEqual([]);
    hub.runUntil(TEN_PM + 1);
    const record = hub.requests[0]?.record ?? seq(0);
    expect(hub.requests.map((r) => [r.op, r.actor, r.answerTo])).toEqual([
      [
        { op: "mode.switch", body: { mode: 3 } },
        { kind: "schedule", schedule: scheduleId(1), name: "schedule Night" },
        { kind: "schedule", schedule: scheduleId(1), record },
      ],
    ]);
  });

  test("the last run is written in the step of the arming, and schedule_ran is the cause it names", () => {
    const hub = booted({ id: 1 });
    hub.responder = () => ({
      ok: true,
      body: { armed: [SENSOR], disarmed: [OTHER_SENSOR], waiting: [9], lowBattery: [SENSOR] },
    });
    const effects = hub.runUntil(TEN_PM);
    const step = hub.steps.find((s) => decisions(s, "schedule_ran").length > 0) ?? [];
    const writes = scheduleWrites(step);
    expect(writes.map((w) => w.durability)).toEqual(["now"]);
    const row = writes[0]?.op;
    expect(row?.op === "upsert" && row.table === "schedules" ? row.row : undefined).toMatchObject({
      id: 1,
      lastRunMs: TEN_PM,
      lastRunLocalDate: day(2026, 7, 1),
    });
    const [ran] = decisions(effects, "schedule_ran");
    expect(ran).toMatchObject({ value: 1, deviceId: null, causeSeq: null });
    expect(ran?.seq).toBe(hub.requests[0]?.record as never);
    expect(ranOf(ran ?? ({} as never))).toEqual({
      action: 0,
      outcome: 0,
      armed: [SENSOR],
      disarmed: [OTHER_SENSOR],
      waiting: [9],
      low: [SENSOR],
      error: "",
    });
    // The decision and the row are "now": the step forces one commit holding both (HD 4).
    expect(step.some((e) => e.kind === "record" && e.durability === "now")).toBe(true);
  });

  test("once, never twice: more inputs at the same time, then the next day's", () => {
    const hub = booted({ id: 1 });
    hub.runUntil(TEN_PM);
    hub.tick();
    hub.advance(1);
    hub.advance(HOUR);
    expect(hub.requests.length).toBe(1);
    hub.runUntil(TEN_PM + DAY);
    expect(hub.requests.length).toBe(2);
    expect(decisions(hub.all, "schedule_ran").length).toBe(2);
  });

  test("a one-time entry runs on its date and then has no next time", () => {
    const hub = booted({ id: 1, days: 0, date: day(2026, 7, 2), localTime: 8 * 60 });
    hub.runUntil(utc(2026, 7, 2, 7));
    expect(hub.requests.length).toBe(1);
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBeNull();
    hub.runUntil(utc(2026, 7, 10));
    expect(hub.requests.length).toBe(1);
  });

  test("a disabled entry has no next time and never runs", () => {
    const hub = booted({ id: 1, enabled: false });
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBeNull();
    hub.runUntil(TEN_PM + 2 * DAY);
    expect(hub.requests).toEqual([]);
  });

  test("on its weekdays only", () => {
    // Mondays and Fridays at 22:00, from Wednesday 1 July: Fri 3, Mon 6, Fri 10.
    const hub = booted({ id: 1, days: 1 | (1 << 4) });
    hub.runUntil(utc(2026, 7, 11));
    const days = decisions(hub.all, "schedule_ran").map((d) => d.atMs);
    expect(days).toEqual([utc(2026, 7, 3, 21), utc(2026, 7, 6, 21), utc(2026, 7, 10, 21)]);
  });

  test("two entries due in the same minute run in the order of their ids, one request at a time", () => {
    const hub = booted(
      { id: 5, action: ScheduleAction.Arm, modeId: null, sensorId: SENSOR },
      { id: 2, action: ScheduleAction.Disarm, modeId: null, sensorId: OTHER_SENSOR },
    );
    hub.runUntil(TEN_PM);
    expect(hub.requests.map((r) => r.op)).toEqual([
      { op: "disarm", body: { target: { sensor: OTHER_SENSOR } } },
      { op: "arm", body: { target: { sensor: SENSOR } } },
    ]);
    // Both in the one step, each with its own schedule_ran.
    const step = hub.steps.find((s) => decisions(s, "schedule_ran").length > 0) ?? [];
    expect(decisions(step, "schedule_ran").map((d) => [d.value, d.deviceId])).toEqual([
      [2, OTHER_SENSOR],
      [5, SENSOR],
    ]);
  });

  test("a refusal is recorded in schedule_ran, with its code; the run still counts", () => {
    const hub = booted({ id: 1 });
    hub.responder = () => ({
      ok: false,
      error: { code: "notFound", detail: { what: "mode", id: 3 } },
    });
    hub.runUntil(TEN_PM);
    const [ran] = decisions(hub.all, "schedule_ran");
    expect(ranOf(ran ?? ({} as never))).toMatchObject({ outcome: 1, error: "notFound" });
    hub.advance(HOUR);
    expect(hub.requests.length).toBe(1);
  });

  test("a restart after the run's commit does not run it again (its last run's local date)", () => {
    const hub = new Hub(TEN_PM + 10 * MINUTE);
    hub.boot({
      schedules: [scheduleRow({ id: 1, lastRunMs: TEN_PM, lastRunLocalDate: day(2026, 7, 1) })],
      mark: { wallMs: TEN_PM, clockOk: true },
    });
    hub.runUntil(TEN_PM + 20 * MINUTE);
    expect(hub.requests).toEqual([]);
    expect(decisions(hub.all, "schedule_missed")).toEqual([]);
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBe(TEN_PM + DAY);
  });
});

describe("daylight saving, in the hub's zone (HB31)", () => {
  test("London, 29 March 2026: an entry at 01:30 runs at 02:00 BST, the day after at 01:30", () => {
    const hub = new Hub(utc(2026, 3, 28, 12));
    hub.boot({
      schedules: [scheduleRow({ id: 1, localTime: 90 })],
      mark: { wallMs: utc(2026, 3, 28, 11), clockOk: true },
    });
    hub.runUntil(utc(2026, 3, 30, 12));
    expect(decisions(hub.all, "schedule_ran").map((d) => d.atMs)).toEqual([
      utc(2026, 3, 29, 1), // 02:00 BST, the jump
      utc(2026, 3, 30, 0, 30), // 01:30 BST
    ]);
  });

  test("London, 25 October 2026: an entry at 01:30 runs at the first, not again an hour later", () => {
    const hub = new Hub(utc(2026, 10, 24, 12));
    hub.boot({
      schedules: [scheduleRow({ id: 1, localTime: 90 })],
      mark: { wallMs: utc(2026, 10, 24, 11), clockOk: true },
    });
    hub.runUntil(utc(2026, 10, 26, 12));
    expect(decisions(hub.all, "schedule_ran").map((d) => d.atMs)).toEqual([
      utc(2026, 10, 25, 0, 30), // 01:30 BST
      utc(2026, 10, 26, 1, 30), // 01:30 GMT the next day; not 25 October 01:30 GMT
    ]);
  });

  test("a new zone finds every next time again, and is written now", () => {
    const hub = booted({ id: 1 });
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBe(TEN_PM);
    hub.input({ kind: "timeZone", zone: "America/New_York" });
    expect(scheduleObjects(hub.state)[0]?.nextMs).toBe(utc(2026, 7, 2, 2));
    expect(scheduleWrites(hub.steps.at(-1) ?? []).map((w) => [w.durability, w.op])).toEqual([
      ["now", { table: "schedule_state", op: "upsert", row: { timeZone: "America/New_York" } }],
    ]);
    hub.input({ kind: "timeZone", zone: "America/New_York" });
    expect(scheduleWrites(hub.steps.at(-1) ?? [])).toEqual([]);
  });
});

describe("the site's time zone for hub.info (schedules' view, timeZone)", () => {
  test("null before the boot and before any zone; the stored one at boot; the shell's after", () => {
    const fresh = new Hub();
    expect(timeZone(fresh.state)).toBeNull();
    fresh.boot({ zone: null });
    expect(timeZone(fresh.state)).toBeNull();
    fresh.input({ kind: "timeZone", zone: "Europe/Paris" });
    expect(timeZone(fresh.state)).toBe("Europe/Paris");
    const restarted = new Hub();
    restarted.boot({ zone: "Europe/London" });
    expect(timeZone(restarted.state)).toBe("Europe/London");
    restarted.input({ kind: "timeZone", zone: "America/New_York" });
    expect(timeZone(restarted.state)).toBe("America/New_York");
  });
});

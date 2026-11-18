/**
 * No entry's deadline is left at or before a step's time (hub-design.md section 2, "Timers"):
 * the wall clock moving across an entry's time, forwards and backwards, by less than a step
 * (`clockStepMs` ‡) and by more, and across a daylight-saving change. Which is right when the clock
 * moves past an entry's time is m2-design.md section 7, "Schedules" (D87, D116): a correction of
 * seconds is no step, so the entry runs, seconds late, once; a step forwards of more than a minute
 * jumps over it, so it is missed; a step backwards never runs it again on the same local date.
 *
 * The harness runs the real `step` with `checkDeadlines`, so any deadline left behind fails the
 * step it was left in.
 */
import { describe, expect, test } from "bun:test";
import { idOf, decisions, DAY, HOUR, Hub, MINUTE, scheduleRow, START, utc } from "./support.ts";

/** 22:00 BST on 1 July 2026. */
const TEN_PM = utc(2026, 7, 1, 21);

function booted(localTime?: number, wall = START): Hub {
  const hub = new Hub(wall);
  hub.boot({
    schedules: [scheduleRow({ id: 1, ...(localTime === undefined ? {} : { localTime }) })],
    mark: { wallMs: wall - HOUR, clockOk: true },
  });
  return hub;
}

/** Every schedules timer is after the hub's time now. */
function noneLeft(hub: Hub): void {
  const now = hub.now.mono;
  expect(hub.state.schedules.timers.filter((t) => t.at <= now)).toEqual([]);
}

function runs(hub: Hub): readonly number[] {
  return decisions(hub.all, "schedule_ran").map((d) => d.atMs);
}

describe("the clock corrected forwards by seconds across an entry's time (no step)", () => {
  test("it runs in the step that sees the correction, once, seconds late, not missed", () => {
    const hub = booted();
    hub.advanceTo(TEN_PM - 10_000);
    hub.wall += 20_000; // 22:00:10
    const effects = hub.tick();
    expect(hub.requests).toHaveLength(1);
    expect(decisions(effects, "schedule_ran").map((d) => d.atMs)).toEqual([TEN_PM + 10_000]);
    expect(decisions(hub.all, "schedule_missed")).toEqual([]);
    noneLeft(hub);
    expect(hub.state.schedules.entries.get(idOf(1))?.dueMs).toBe(TEN_PM + DAY);
    // Never a second time on that date, and the next day's on time.
    hub.runUntil(TEN_PM + DAY - 1);
    expect(hub.requests).toHaveLength(1);
    hub.runUntil(TEN_PM + DAY);
    expect(runs(hub)).toEqual([TEN_PM + 10_000, TEN_PM + DAY]);
  });

  test("a correction that lands exactly on the entry's time runs it in that step", () => {
    const hub = booted();
    hub.advanceTo(TEN_PM - 10_000);
    hub.wall += 10_000; // 22:00:00.000 on the dot
    hub.tick();
    expect(runs(hub)).toEqual([TEN_PM]);
    noneLeft(hub);
  });

  test("one that stops a millisecond short of it runs it at its timer, a millisecond later", () => {
    const hub = booted();
    hub.advanceTo(TEN_PM - 10_000);
    hub.wall += 10_000 - 1;
    hub.tick();
    expect(hub.requests).toEqual([]);
    noneLeft(hub);
    hub.runUntil(TEN_PM);
    expect(runs(hub)).toEqual([TEN_PM]);
  });

  test("the largest correction that is no step (the step threshold itself) still runs it", () => {
    const hub = booted();
    hub.advanceTo(TEN_PM - 10_000);
    hub.wall += hub.deps.rules.schedules.clockStepMs; // 60 s ‡: no step yet
    hub.tick();
    expect(hub.requests).toHaveLength(1);
    expect(decisions(hub.all, "schedule_missed")).toEqual([]);
    noneLeft(hub);
  });

  test("two corrections in a row, each across another entry's time: each runs once, in the step that sees it", () => {
    const hub = new Hub();
    hub.boot({
      schedules: [scheduleRow({ id: 2 }), scheduleRow({ id: 1, localTime: 22 * 60 + 1 })],
      mark: { wallMs: START - HOUR, clockOk: true },
    });
    hub.advanceTo(TEN_PM - 5_000);
    hub.wall += 20_000; // past 22:00: entry 2
    hub.tick();
    expect(hub.requests.map((r) => r.answerTo)).toMatchObject([{ schedule: 2 }]);
    noneLeft(hub);
    hub.advanceTo(TEN_PM + MINUTE - 5_000);
    hub.wall += 20_000; // past 22:01: entry 1
    hub.tick();
    expect(hub.requests.map((r) => r.answerTo)).toMatchObject([{ schedule: 2 }, { schedule: 1 }]);
    noneLeft(hub);
    hub.runUntil(TEN_PM + HOUR);
    expect(hub.requests).toHaveLength(2);
  });
});

describe("the clock moving backwards across an entry's time", () => {
  test("by seconds after it ran: no second run, no deadline left", () => {
    const hub = booted();
    hub.runUntil(TEN_PM + 5_000);
    expect(hub.requests).toHaveLength(1);
    hub.wall -= 30_000; // 21:59:35
    hub.tick();
    noneLeft(hub);
    hub.runUntil(TEN_PM + HOUR);
    expect(hub.requests).toHaveLength(1);
  });

  test("by seconds before it: it runs when the wall clock reaches it, not at its old deadline", () => {
    const hub = booted();
    hub.advanceTo(TEN_PM - 10_000);
    hub.wall -= 20_000; // 21:59:30
    hub.tick();
    noneLeft(hub);
    hub.advance(10_000); // when the old timer would have fired: 21:59:40 by the wall clock
    expect(hub.requests).toEqual([]);
    hub.runUntil(TEN_PM);
    expect(runs(hub)).toEqual([TEN_PM]);
  });

  test("forwards by seconds across it, then back across it: one run, no miss", () => {
    const hub = booted();
    hub.advanceTo(TEN_PM - 10_000);
    hub.wall += 20_000;
    hub.tick();
    hub.wall -= 40_000; // 21:59:50 again
    hub.tick();
    noneLeft(hub);
    hub.runUntil(TEN_PM + HOUR);
    expect(hub.requests).toHaveLength(1);
    expect(decisions(hub.all, "schedule_missed")).toEqual([]);
  });
});

describe("a step forwards of more than a minute across an entry's time", () => {
  test("it is missed, not run, and no deadline is left behind", () => {
    const hub = booted();
    hub.advanceTo(TEN_PM - 10_000);
    hub.wall += 2 * MINUTE;
    hub.tick();
    expect(hub.requests).toEqual([]);
    expect(decisions(hub.all, "schedule_missed")).toHaveLength(1);
    noneLeft(hub);
  });
});

describe("across a daylight-saving change (HB31), London", () => {
  test("29 March 2026: an entry at 01:30 (skipped, so 02:00 BST); seconds ahead across it, it runs once", () => {
    const jump = utc(2026, 3, 29, 1); // 02:00 BST, the first minute after the jump
    const hub = booted(90, utc(2026, 3, 28, 12));
    hub.advanceTo(jump - 10_000);
    hub.wall += 20_000;
    hub.tick();
    expect(runs(hub)).toEqual([jump + 10_000]);
    noneLeft(hub);
    hub.runUntil(utc(2026, 3, 30, 12));
    expect(runs(hub)).toEqual([jump + 10_000, utc(2026, 3, 30, 0, 30)]);
  });

  test("25 October 2026: an entry at 01:30 (twice, so the first); seconds ahead across it, then back: once", () => {
    const first = utc(2026, 10, 25, 0, 30); // 01:30 BST
    const hub = booted(90, utc(2026, 10, 24, 12));
    hub.advanceTo(first - 10_000);
    hub.wall += 20_000;
    hub.tick();
    hub.wall -= 40_000;
    hub.tick();
    noneLeft(hub);
    // Not again at 01:30 GMT, an hour later; next on 26 October at 01:30 GMT.
    hub.runUntil(utc(2026, 10, 26, 12));
    expect(runs(hub)).toEqual([first + 10_000, utc(2026, 10, 26, 1, 30)]);
  });
});

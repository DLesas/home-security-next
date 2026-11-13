/**
 * Site moves in the World with scripted sensors (hub-design.md section 7, "Changing the site's
 * rate, DR5 to DR2", and section 11; protocol.md §7; D115): a whole move from the fast rate to the
 * medium one with an idle sensor, an armed sensor whose door opens just after the switch, and a
 * sensor out of range through the announcement that is left behind; a move cancelled; and the hub
 * restarting in each stage, from what it had committed.
 */
import { describe, expect, test } from "bun:test";
import { deviceId } from "../../../src/core/model/ids.ts";
import { MoveStage } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { SECOND, snapshotFrom } from "./bench.ts";
import { siteDay, type SiteDay } from "./site-day.ts";

const MIN = 60 * SECOND;

function must(day: SiteDay, at: number): void {
  expect(day.bench.world.advanceTo(mono(at)).isOk()).toBe(true);
}

/** The hub restarts: boot 2 from exactly what was committed (section 5). */
function restart(day: SiteDay): void {
  day.bench.boot(snapshotFrom(day.snapshot, day.bench.world.writer.commits), 2);
}

describe("a whole move from DR5 to DR2", () => {
  const day = siteDay({ count: 3, rate: 5, drifts: [0, 0.01, -0.01] });
  const [front, back, far] = day.sensors;
  // `far` is out of range of the gateway from the start of the move.
  must(day, 10 * MIN);
  day.bench.command({ kind: "arm", sensors: ["sensor-2"], continue: true });
  day.site.unheard.add(2);
  day.bench.command({ kind: "siteChange", rate: 2 });
  must(day, 25 * MIN);

  test("the announcement reaches every sensor in touch, and their packets confirm it", () => {
    expect(front?.next).toEqual({ channel: undefined, rate: 2 });
    expect(back?.next).toEqual({ channel: undefined, rate: 2 });
    expect(far?.next).toBeUndefined();
    expect(
      day.bench
        .decisions("move_confirmed")
        .map((d) => d.deviceId)
        .toSorted(),
    ).toEqual([deviceId(3), deviceId(4)]);
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Announcing);
  });

  test("the sensor out of touch stalls the move: one warning names it, and the hub does not switch by itself", () => {
    expect(day.bench.decisions("move_stalled").map((d) => d.deviceId)).toEqual([deviceId(5)]);
  });

  test("forced, the switch goes: the gateway listens at DR2, the sensor left behind is named", () => {
    day.bench.command({ kind: "siteChangeForce", yes: true });
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Switched);
    expect(day.site.rate).toBe(2);
    expect(day.bench.decisions("move_forced").map((d) => d.deviceId)).toEqual([deviceId(5)]);
  });

  test("a door opening just after the switch: the first try unheard at DR5, the retry at DR2 with bit 7 starts the countdown", () => {
    const switchedAt = day.bench.world.now.mono;
    back?.door(mono(switchedAt + SECOND), true);
    must(day, switchedAt + 20 * SECOND);
    const doors = back?.sent.filter((s) => s.kind === "door") ?? [];
    expect(doors.map((d) => d.dataRate)).toEqual([5, 2]);
    const reply = back?.replies.at(-1);
    expect(reply?.reply).toMatchObject({
      sendDataRate: 2,
      nextSiteChannel: 0xff,
      nextSendDataRate: 0xff,
      flags: { armed: true, countdownStarted: true },
    });
    expect(back?.held.sendRate).toBe(2);
    expect(back?.next).toBeUndefined();
    expect(back?.buzzing).toBe(true);
  });

  test("the idle sensor finds DR5 unanswered and follows on DR2 within two heartbeats", () => {
    must(day, day.bench.world.now.mono + 8 * MIN);
    expect(front?.held.sendRate).toBe(2);
    expect(front?.next).toBeUndefined();
    expect(
      day.bench
        .decisions("device_followed")
        .map((d) => d.deviceId)
        .toSorted(),
    ).toEqual([deviceId(3), deviceId(4)]);
  });

  test("every sensor in touch followed: the move is done; the one left behind raises no silence alert", () => {
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Done);
    expect(day.bench.decisions("move_done").map((d) => d.value)).toEqual([0]);
    must(day, day.bench.world.now.mono + 60 * MIN);
    expect(day.bench.decisions("sensor_silent")).toEqual([]);
    const late = day.site.heard.filter(
      (h) => h.sensor !== 2 && h.transmission.start > day.bench.world.now.mono - 30 * MIN,
    );
    expect(late.length).toBeGreaterThan(10);
    expect(late.every((h) => h.heard && h.transmission.dataRate === 2)).toBe(true);
  });
});

describe("a move cancelled", () => {
  test("every sensor clears its next settings at its next reply; nothing switches", () => {
    // A third sensor out of range keeps the move announcing until the user decides.
    const day = siteDay({ count: 3, rate: 5 });
    const inTouch = day.sensors.slice(0, 2);
    must(day, 10 * MIN);
    day.site.unheard.add(2);
    day.bench.command({ kind: "siteChange", rate: 2 });
    must(day, 20 * MIN);
    expect(inTouch.every((s) => s.next?.rate === 2)).toBe(true);
    day.bench.command({ kind: "siteChangeCancel" });
    expect(day.bench.world.replies.at(-1)?.reply).toEqual({
      ok: true,
      result: { kind: "siteChangeCancel", sensors: 3 },
    });
    must(day, 30 * MIN);
    expect(inTouch.every((s) => s.next === undefined && s.held.sendRate === 5)).toBe(true);
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Cancelled);
    expect(day.site.rate).toBe(5);
    const late = day.site.heard.filter((h) => h.sensor < 2 && h.transmission.start > 25 * MIN);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((h) => h.heard && h.transmission.dataRate === 5)).toBe(true);
  });
});

describe("the hub restarting in each stage of a move", () => {
  test("announcing: it carries on waiting with what it committed, then switches and the move is done", () => {
    const day = siteDay({ count: 2, rate: 5 });
    must(day, 10 * MIN);
    day.bench.command({ kind: "siteChange", rate: 2 });
    must(day, 12 * MIN);
    restart(day);
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Announcing);
    must(day, 40 * MIN);
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Done);
    expect(day.sensors.every((s) => s.held.sendRate === 2 && s.next === undefined)).toBe(true);
  });

  test("switched: the new settings and confirmations survive; the sensors follow and the move is done", () => {
    const day = siteDay({ count: 2, rate: 5 });
    must(day, 10 * MIN);
    day.bench.command({ kind: "siteChange", rate: 2 });
    for (
      let t = 10 * MIN;
      day.bench.world.state.site.row.moveStage === MoveStage.Announcing && t < 40 * MIN;
      t += 10 * SECOND
    ) {
      must(day, t);
    }
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Switched);
    restart(day);
    expect(day.bench.world.state.site.row).toMatchObject({
      moveStage: MoveStage.Switched,
      rateMask: 1 << 2,
    });
    must(day, day.bench.world.now.mono + 15 * MIN);
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Done);
    expect(day.sensors.every((s) => s.held.sendRate === 2)).toBe(true);
  });

  test("done: nothing more; the sensors keep their new rate", () => {
    const day = siteDay({ count: 1, rate: 5 });
    must(day, 10 * MIN);
    day.bench.command({ kind: "siteChange", rate: 2 });
    must(day, 40 * MIN);
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Done);
    const decisions = day.bench.decisions().length;
    restart(day);
    must(day, 60 * MIN);
    expect(day.bench.world.state.site.row.moveStage).toBe(MoveStage.Done);
    expect(
      day.bench
        .decisions()
        .slice(decisions)
        .filter((d) => d.kind.startsWith("move_")),
    ).toEqual([]);
    expect(day.sensors[0]?.misses).toBe(0);
  });
});

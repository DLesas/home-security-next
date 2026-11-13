/**
 * The hub restarting during a countdown and during an alarm (hub-design.md section 5, "How long
 * was the hub down?" and "What the hub does on a start where it cannot know how long it was
 * down"; section 7, "Hub restart"; D80, D113, HB30), with the time off known from the clock and
 * unknown, and a wall clock that steps during a countdown (section 2: deadlines are `Mono`).
 */
import { describe, expect, test } from "bun:test";
import { SirenAction, SirenState } from "@hsn/protocol";
import { ArmState } from "../../../src/core/model/rows.ts";
import { actedCommands, Home, SECOND } from "./harness.ts";

const SOUND = SirenAction.SoundAlarm;

function home(): Home {
  return new Home({
    sensors: [{ name: "front", arm: ArmState.Armed }],
    sirens: [{ name: "hall" }],
  });
}

describe("a restart during a countdown (D80, D113, HB30)", () => {
  test("D80: with the time off known by the clock, the countdown ends when it would have", () => {
    const h = home();
    h.door("front", true);
    h.advance(10_000);
    h.restart(5_000, true);
    expect(h.decisions("alarm")).toEqual([]);
    h.advanceTo(14.9 * SECOND);
    expect(h.decisions("alarm")).toEqual([]);
    h.advanceTo(15.1 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
    h.advance(1_000);
    expect(actedCommands(h, "hall").map((c) => [c.action, c.seconds])).toEqual([[SOUND, 300]]);
  });

  test("D113: with the time off unknown, it resumes with the time it had left, one downtime late, never early", () => {
    const h = home();
    h.door("front", true);
    h.advance(10_000);
    h.restart(5_000, false);
    h.advanceTo(19.9 * SECOND);
    expect(h.decisions("alarm")).toEqual([]);
    h.advanceTo(20.1 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
  });

  test("D113: the moment the time off becomes known, the countdown is judged again", () => {
    const h = home();
    h.door("front", true);
    const wall = h.world.now.wall;
    h.advance(10_000);
    h.restart(5_000, false);
    h.advance(8_000);
    // The network sets the clock: 10 + 5 + 8 s after the door report.
    h.trustWall(wall + 23_000);
    h.advance(100);
    h.advanceTo(14.9 * SECOND);
    expect(h.decisions("alarm")).toEqual([]);
    h.advanceTo(15.1 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
  });

  test("D80 D106: a countdown that ran out while the hub was down sounds the sirens for what is left", () => {
    const h = home();
    h.door("front", true);
    h.advance(10_000);
    h.restart(60_000, true);
    h.advance(3_000);
    // It ended 40 s ago: the sirens sound to 300 s after its end.
    expect(h.decisions("late_report_sirens").map((d) => d.value)).toEqual([260]);
    expect(actedCommands(h, "hall").map((c) => [c.action, c.seconds])).toEqual([[SOUND, 260]]);
  });

  test("D106: one whose stop also passed while the hub was down is recorded only", () => {
    const h = home();
    h.door("front", true);
    h.advance(10_000);
    h.restart(400_000, true);
    h.advance(1_000);
    expect(h.decisions("late_report_notification")).toHaveLength(1);
    expect(actedCommands(h, "hall")).toEqual([]);
  });
});

describe("a restart during an alarm (D80, D113)", () => {
  function sounding(): Home {
    const h = home();
    h.door("front", true);
    h.advance(100_000);
    expect(h.scripted("hall").output).toBe(SirenState.SoundingAlarm);
    return h;
  }

  test("D80: a siren still sounding is asked to report and adopted, not commanded again (known)", () => {
    const h = sounding();
    h.restart(20_000, true);
    h.advance(2_000);
    expect(actedCommands(h, "hall")).toEqual([]);
    expect(h.decisions("siren_adopted")).toHaveLength(1);
    expect(h.decisions("alarm")).toEqual([]);
    expect(h.scripted("hall").output).toBe(SirenState.SoundingAlarm);
  });

  test("D113: a siren still sounding is believed with the time off unknown, its time left adopted", () => {
    const h = sounding();
    h.restart(20_000, false);
    h.advance(2_000);
    expect(actedCommands(h, "hall")).toEqual([]);
    const adopted = h.decisions("siren_adopted");
    expect(adopted.map((d) => d.value)).toEqual([210]);
    // The alarm ends when the siren's own time does: 330 s on its clock, 210 s after the start.
    h.advanceTo(213 * SECOND);
    expect(h.decisions("alarm_ended")).toHaveLength(1);
  });

  test("D80: a siren that lost power is sounded for what is left when the time off is known", () => {
    const h = sounding();
    h.scripted("hall").restart("powerOn", h.now);
    h.restart(20_000, true);
    h.advance(2_000);
    expect(actedCommands(h, "hall").map((c) => [c.action, c.seconds])).toEqual([[SOUND, 210]]);
    expect(h.decisions("alarm_may_be_cut_short")).toEqual([]);
  });

  test("D113: with the time off unknown it is not commanded and the alarm may be cut short; known later, it sounds", () => {
    const h = sounding();
    const wall = h.world.now.wall;
    h.scripted("hall").restart("powerOn", h.now);
    h.restart(20_000, false);
    h.advance(2_000);
    expect(actedCommands(h, "hall")).toEqual([]);
    expect(h.decisions("alarm_may_be_cut_short").map((d) => d.durability)).toEqual(["now"]);
    h.trustWall(wall + 20_000 + 10_000);
    h.advance(8_000);
    expect(actedCommands(h, "hall").map((c) => c.action)).toEqual([SOUND]);
    // 330 − (100 + 20 + 10) = 200 s, less the second the clock was trusted before the next step.
    expect(actedCommands(h, "hall")[0]?.seconds).toBeGreaterThanOrEqual(199);
  });

  test("HB30: no alarm is cancelled by the restart, and none that ended is sounded again", () => {
    const h = sounding();
    h.advance(240_000);
    expect(h.decisions("alarm_ended")).toHaveLength(1);
    h.restart(5_000, true);
    h.advance(60_000);
    expect(actedCommands(h, "hall")).toEqual([]);
    expect(h.decisions("alarm")).toEqual([]);
  });
});

describe("a wall clock that steps during a countdown (section 2, section 5 'The clock')", () => {
  test("forward or back, the countdown ends at its monotonic deadline", () => {
    for (const step of [3_600_000, -3_600_000]) {
      const h = home();
      const t0 = h.now;
      const wall = h.world.now.wall;
      h.door("front", true);
      h.advance(10_000);
      h.world.setWall(wall + 10_000 + step, true);
      h.advanceTo(t0 + 29.9 * SECOND);
      expect(h.decisions("alarm")).toEqual([]);
      h.advanceTo(t0 + 30.1 * SECOND);
      expect(h.decisions("alarm")).toHaveLength(1);
    }
  });
});

/**
 * The alarm's rules in the World (hub-design.md sections 7 and 8; D24, D86, D95, D106, D114,
 * AL3, AL11): a disarm inside the countdown, thirty doors within a second, a partial disarm, a
 * second door during an alarm, and a late report in each range.
 */
import { describe, expect, test } from "bun:test";
import { SirenAction, SirenState } from "@hsn/protocol";
import { ArmState } from "../../../src/core/model/rows.ts";
import { actedCommands, Home, SECOND } from "./harness.ts";

const SOUND = SirenAction.SoundAlarm;

describe("a disarm inside the countdown (AL3, D24)", () => {
  test("cancels it with the notice's binding, and no siren sounds", () => {
    const h = new Home({
      sensors: [{ name: "front", arm: ArmState.Armed }],
      sirens: [{ name: "hall" }],
    });
    h.door("front", true);
    h.advance(5_000);
    h.door("front", true, { newEvent: false }); // a retry of the same opening
    h.advance(7_000);
    expect(h.command({ kind: "disarm", sensors: ["front"] })).toMatchObject({
      ok: true,
      result: { disarmed: ["front"], countdownsCancelled: ["front"], alarmEnded: false },
    });
    const cancelled = h.messagesOf("countdownCancelled").map((m) => m.message.newestCounter);
    // Bound to the newest report of the opening (§4): the retry's counter.
    expect(cancelled).toEqual([66]);
    h.advance(60_000);
    expect(h.decisions("alarm")).toEqual([]);
    expect(actedCommands(h, "hall")).toEqual([]);
    expect(
      h.world.writer.commits.some((c) =>
        c.items.some(
          (i) => i.kind === "write" && i.op.table === "countdowns" && i.op.op === "delete",
        ),
      ),
    ).toBe(true);
  });

  test("AL3: closing the door does not cancel the countdown, nor does a second opening restart it (D86)", () => {
    const h = new Home({
      sensors: [{ name: "front", arm: ArmState.Armed }],
      sirens: [{ name: "hall" }],
    });
    const t0 = h.now;
    h.door("front", true);
    h.advance(10_000);
    h.door("front", false);
    h.advance(10_000);
    h.door("front", true);
    expect(h.decisions("countdown_continued").map((d) => d.value)).toEqual([10]);
    h.advanceTo(t0 + 30.5 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
  });
});

describe("thirty doors within a second (D95, D114)", () => {
  test("give one command per siren, and every door its own countdown and trigger", () => {
    const sensors = Array.from({ length: 30 }, (_, i) => ({
      name: `door${i}`,
      arm: ArmState.Armed,
    }));
    const h = new Home({ sensors, sirens: [{ name: "hall" }, { name: "porch" }] });
    for (let i = 0; i < 30; i++) {
      h.door(`door${i}`, true);
      h.advance(30);
    }
    expect(h.decisions("countdown_started")).toHaveLength(30);
    h.advance(40_000);
    expect(h.decisions("alarm")).toHaveLength(1);
    expect(h.decisions("alarm_trigger_added")).toHaveLength(29);
    for (const siren of ["hall", "porch"]) {
      expect(actedCommands(h, siren).map((c) => c.action)).toEqual([SOUND]);
    }
    const intents = h.messagesOf("sirenIntent");
    expect(intents).toHaveLength(2);
  });
});

describe("a partial disarm (D95, AL11)", () => {
  test("leaves the sirens sounding to their stop; disarming the last trigger ends the alarm", () => {
    const h = new Home({
      sensors: [
        { name: "front", arm: ArmState.Armed },
        { name: "back", arm: ArmState.Armed },
      ],
      sirens: [{ name: "hall" }],
    });
    h.door("front", true);
    h.door("back", true);
    h.advance(35_000);
    expect(h.command({ kind: "disarm", sensors: ["front"] })).toMatchObject({
      ok: true,
      result: { disarmed: ["front"], alarmEnded: false },
    });
    h.advance(5_000);
    expect(h.scripted("hall").output).toBe(SirenState.SoundingAlarm);
    expect(actedCommands(h, "hall").map((c) => c.action)).toEqual([SOUND]);
    expect(h.command({ kind: "disarm", sensors: ["back"] })).toMatchObject({
      ok: true,
      result: { alarmEnded: true },
    });
    h.advance(2_000);
    expect(actedCommands(h, "hall").map((c) => c.action)).toEqual([SOUND, SirenAction.Off]);
  });
});

describe("a second door during an alarm (D114)", () => {
  test("gets its own countdown, and its trigger does not extend a siren's time", () => {
    const h = new Home({
      sensors: [
        { name: "front", arm: ArmState.Armed },
        { name: "back", arm: ArmState.Armed },
      ],
      sirens: [{ name: "hall" }],
    });
    const t0 = h.now;
    h.door("front", true);
    h.advance(100_000);
    h.door("back", true);
    expect(h.decisions("countdown_started")).toHaveLength(2);
    h.advanceTo(t0 + 131 * SECOND);
    expect(h.decisions("alarm_trigger_added")).toHaveLength(1);
    expect(actedCommands(h, "hall")).toHaveLength(1);
    // The siren stops at 30 + 300 s, counted from its first command (section 13, answer 5).
    h.advanceTo(t0 + 331 * SECOND);
    expect(h.scripted("hall").output).toBe(SirenState.Off);
    expect(h.decisions("alarm_ended")).toHaveLength(1);
  });
});

describe("late door reports (D106, section 7)", () => {
  const armed = () =>
    new Home({ sensors: [{ name: "front", arm: ArmState.Armed }], sirens: [{ name: "hall" }] });

  test("D106: within the countdown, it runs with what is left", () => {
    const h = armed();
    const t0 = h.now;
    h.door("front", true, { ageS: 20 });
    expect(h.decisions("countdown_started").map((d) => d.value)).toEqual([10]);
    h.advanceTo(t0 + 9.9 * SECOND);
    expect(h.decisions("alarm")).toEqual([]);
    h.advanceTo(t0 + 10.1 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
  });

  test("D106: after the countdown, the sirens sound for what is left of their stop", () => {
    const h = armed();
    h.door("front", true, { ageS: 100 });
    expect(h.decisions("late_report_sirens").map((d) => d.value)).toEqual([230]);
    h.advance(1_000);
    expect(actedCommands(h, "hall").map((c) => [c.action, c.seconds])).toEqual([[SOUND, 230]]);
  });

  test("D106: after even the stop, a notification only, with the opening's wall time", () => {
    const h = armed();
    const wall = h.world.now.wall;
    h.door("front", true, { ageS: 400 });
    const notified = h.decisions("late_report_notification");
    expect(notified.map((d) => d.value)).toEqual([Math.floor((wall - 400_000) / 1000)]);
    h.advance(5_000);
    expect(actedCommands(h, "hall")).toEqual([]);
    expect(h.decisions("alarm")).toEqual([]);
  });

  test("AL2b: any report while disarmed is recorded only", () => {
    const h = new Home({ sensors: [{ name: "front" }], sirens: [{ name: "hall" }] });
    h.door("front", true, { ageS: 100 });
    expect(h.decisions("report_while_disarmed")).toHaveLength(1);
    h.advance(60_000);
    expect(actedCommands(h, "hall")).toEqual([]);
  });
});

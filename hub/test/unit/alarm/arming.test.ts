/**
 * The alarm module's rules at their boundaries (hub-design.md section 8, "Arming and the
 * countdown"; section 5, what is written now and before what; D7, D9, D40, D50, D67, D74, D86,
 * D95, D106, D114, AL2a, AL2b, AL3, AL3b, AL4, AL7, AL8, AL9, AL11, HB11, HB12), each through the
 * real core with the harness's stand-ins.
 */
import { describe, expect, test } from "bun:test";
import { replyArming, sirenShould } from "../../../src/core/alarm/view.ts";
import { ArmState } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { actedCommands, Home, SECOND } from "../../scenarios/alarm/harness.ts";

function home(arm: ArmState = ArmState.Armed, countdownS = 30): Home {
  return new Home({
    sensors: [
      { name: "front", arm, countdownS },
      { name: "back", arm },
    ],
    sirens: [{ name: "hall" }],
  });
}

function armOf(h: Home, name: string): ArmState | undefined {
  return h.world.state.alarm.sensors.get(h.sensor(name))?.arm;
}

describe("arming (D50, D74, AL7, AL8, AL3b)", () => {
  test("D50 AL7: an open door stops the arm and is named; nothing is armed", () => {
    const h = home(ArmState.Disarmed);
    h.door("front", true);
    expect(h.command({ kind: "arm", sensors: "all", continue: false })).toEqual({
      ok: false,
      error: { code: "doorsOpen", message: expect.any(String) as string, names: ["front"] },
    });
    expect(armOf(h, "back")).toBe(ArmState.Disarmed);
  });

  test("D50 AL7: with --continue, the open door waits for it to close; the rest arm now", () => {
    const h = home(ArmState.Disarmed);
    h.door("front", true);
    expect(h.command({ kind: "arm", sensors: "all", continue: true })).toMatchObject({
      ok: true,
      result: { kind: "arm", armed: ["back"], waitsForDoorToClose: ["front"] },
    });
    expect(armOf(h, "front")).toBe(ArmState.WaitsForCloseAfterArming);
    // A waiting sensor is told "not armed", so it never buzzes for a door the hub ignores.
    expect(replyArming(h.world.state, h.sensor("front"), h.now).armed).toBe(false);
    h.door("front", false);
    expect(armOf(h, "front")).toBe(ArmState.Armed);
    expect(replyArming(h.world.state, h.sensor("front"), h.now).armed).toBe(true);
  });

  test("AL8: every arm and disarm is recorded with its actor; armed state is written now before the answer", () => {
    const h = home(ArmState.Disarmed);
    const commitsBefore = h.world.writer.commits.length;
    h.command({ kind: "arm", sensors: ["front"], continue: false }, "bob");
    const armed = h.decisions("armed");
    expect(armed.map((d) => new TextDecoder().decode(d.detail ?? new Uint8Array()))).toEqual([
      "bob",
    ]);
    const commit = h.world.writer.commits.slice(commitsBefore);
    expect(
      commit.some((c) =>
        c.items.some(
          (i) => i.kind === "write" && i.durability === "now" && i.op.table === "sensor_config",
        ),
      ),
    ).toBe(true);
    h.command({ kind: "disarm", sensors: ["front"] }, "carl");
    expect(
      h.decisions("disarmed").map((d) => new TextDecoder().decode(d.detail ?? new Uint8Array())),
    ).toEqual(["carl"]);
  });

  test("D74: arming adds to what is armed; AL3b: arming starts no countdown", () => {
    const h = home(ArmState.Disarmed);
    h.command({ kind: "arm", sensors: ["front"], continue: false });
    h.command({ kind: "arm", sensors: ["back"], continue: false });
    expect([armOf(h, "front"), armOf(h, "back")]).toEqual([ArmState.Armed, ArmState.Armed]);
    expect(h.world.state.alarm.countdowns.size).toBe(0);
  });

  test("an unknown sensor is refused and changes nothing", () => {
    const h = home(ArmState.Disarmed);
    const reply = h.command({ kind: "disarm", sensors: ["hall"] });
    expect(reply).toMatchObject({ ok: false, error: { code: "unknownDevice" } });
  });
});

describe("the door-open report (D86, D106, D114, AL2b, AL3, AL4)", () => {
  test("D114: an opening more than 2 s ‡ before arming means open at arming; 2 s exactly does not", () => {
    for (const [ageS, expected] of [
      [3, ArmState.Armed],
      [4, ArmState.WaitsForCloseAfterArming],
    ] as const) {
      const h = home(ArmState.Disarmed);
      h.command({ kind: "arm", sensors: ["front"], continue: false });
      h.advance(1_000);
      h.door("front", true, { ageS });
      expect(armOf(h, "front")).toBe(expected);
      expect(h.decisions("countdown_started")).toHaveLength(expected === ArmState.Armed ? 1 : 0);
    }
  });

  test("D86: a countdown of zero sounds the sirens at once, with no countdown", () => {
    const h = home(ArmState.Armed, 0);
    h.door("front", true);
    expect(h.decisions("countdown_started")).toEqual([]);
    expect(h.decisions("alarm")).toHaveLength(1);
    h.advance(500);
    expect(actedCommands(h, "hall").map((c) => c.seconds)).toEqual([300]);
  });

  test("D106: the three ranges at their edges", () => {
    const cases = [
      [29, "countdown_started", 1],
      [30, "late_report_sirens", 300],
      [329, "late_report_sirens", 1],
      [330, "late_report_notification", undefined],
    ] as const;
    for (const [ageS, kind, value] of cases) {
      const h = home();
      h.door("front", true, { ageS });
      const made = h.decisions(kind);
      expect(made).toHaveLength(1);
      if (value !== undefined) expect(made[0]?.value).toBe(value);
    }
  });

  test("AL3: a countdown per sensor, each to its own end", () => {
    const h = home();
    const t0 = h.now;
    h.door("front", true);
    h.advance(10_000);
    h.door("back", true);
    expect(h.world.state.alarm.countdowns.size).toBe(2);
    h.advanceTo(t0 + 30.5 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
    h.advanceTo(t0 + 40.5 * SECOND);
    expect(h.decisions("alarm_trigger_added")).toHaveLength(1);
  });

  test("AL2b: an opening while waiting is recorded only", () => {
    const h = home(ArmState.WaitsForCloseAfterAlarm);
    h.door("front", true);
    expect(h.decisions("report_while_disarmed")).toHaveLength(1);
    expect(h.decisions("countdown_started")).toEqual([]);
  });

  test("section 5: every decision of a door report is written now", () => {
    const h = home();
    h.door("front", true);
    const ofFront = h.decisions().filter((d) => d.deviceId === h.sensor("front"));
    expect(ofFront.map((d) => [d.kind, d.durability])).toEqual([["countdown_started", "now"]]);
  });

  test("D112: the commit cadence is one second while a countdown runs, five minutes after", () => {
    const h = home();
    h.door("front", true);
    const cadences = () =>
      h.world.effects.flatMap((e) => (e.kind === "cadence" ? [e.everyMs] : []));
    expect(cadences()).toEqual([1_000]);
    h.command({ kind: "disarm", sensors: "all" });
    expect(cadences()).toEqual([1_000, 300_000]);
  });
});

describe("a heartbeat never starts a countdown or sounds a siren (D114)", () => {
  test("D114: an open door in a heartbeat while armed is a warning, once, and nothing more", () => {
    const h = home();
    h.door("front", false);
    h.heartbeat("front", true);
    h.heartbeat("front", true);
    h.advance(60_000);
    expect(h.decisions("door_state_unexpected").map((d) => d.durability)).toEqual(["now"]);
    expect(h.decisions("countdown_started")).toEqual([]);
    expect(actedCommands(h, "hall")).toEqual([]);
  });

  test("D114: a change count ahead of the reports is door_changes_missed; a waiting sensor stays waiting", () => {
    const h = home(ArmState.Disarmed);
    h.door("front", true);
    h.command({ kind: "arm", sensors: ["front"], continue: true });
    h.heartbeat("front", false, 3);
    expect(h.decisions("door_changes_missed").map((d) => d.value)).toEqual([2]);
    expect(armOf(h, "front")).toBe(ArmState.WaitsForCloseAfterArming);
  });

  test("D9: a cover changed report never starts a countdown, even showing the door open", () => {
    const h = home();
    h.cover("front", true, true);
    h.advance(60_000);
    expect(h.decisions("countdown_started")).toEqual([]);
  });
});

describe("the alarm (D67, D74, D95, AL2a, AL9, AL11, HB11, HB12)", () => {
  test("AL2a D74: every sensor sounds every siren", () => {
    const h = new Home({
      sensors: [{ name: "front", arm: ArmState.Armed }],
      sirens: [{ name: "hall" }, { name: "porch" }],
    });
    h.door("front", true);
    h.advance(31_000);
    expect(h.messagesOf("sirenIntent").map((m) => m.message.siren)).toEqual([
      h.sirenDevice("hall"),
      h.sirenDevice("porch"),
    ]);
  });

  test("HB11: a disarmed sensor's opening never sounds a siren", () => {
    const h = home(ArmState.Disarmed);
    h.door("front", true);
    h.advance(400_000);
    expect(h.messagesOf("sirenIntent")).toEqual([]);
  });

  test("AL11: disarming a sensor that is no trigger does not end the alarm", () => {
    const h = home();
    h.door("front", true);
    h.advance(31_000);
    expect(h.command({ kind: "disarm", sensors: ["back"] })).toMatchObject({
      result: { alarmEnded: false },
    });
    expect(sirenShould(h.world.state, h.sirenDevice("hall"), h.now).kind).toBe("sound");
  });

  test("HB12 AL9: no cooldown: a door that closed after an alarm ended by itself arms again and sounds again", () => {
    const h = home();
    h.door("front", true);
    h.advance(331_000);
    expect(armOf(h, "front")).toBe(ArmState.WaitsForCloseAfterAlarm);
    h.door("front", false);
    expect(armOf(h, "front")).toBe(ArmState.Armed);
    h.door("front", true);
    h.advance(31_000);
    expect(h.decisions("alarm")).toHaveLength(2);
  });

  test("D67: a trigger whose door last reported closed stays armed when the alarm ends by itself", () => {
    const h = home();
    h.door("front", true);
    h.door("front", false);
    h.advance(331_000);
    expect(armOf(h, "front")).toBe(ArmState.Armed);
  });

  test("a siren test is what it should do until its end, then simply off (D65, SR9)", () => {
    const h = home(ArmState.Disarmed);
    expect(h.command({ kind: "sirenTest", name: "hall", seconds: 5 })).toMatchObject({
      ok: true,
      result: { seconds: 5 },
    });
    const siren = h.sirenDevice("hall");
    expect(sirenShould(h.world.state, siren, h.now).kind).toBe("test");
    expect(sirenShould(h.world.state, siren, mono(h.now + 5 * SECOND)).kind).toBe("off");
    h.advance(10_000);
    expect(actedCommands(h, "hall").map((c) => c.action)).toEqual([2]);
  });

  test("section 8: a siren's time is capped by its longest sound; the alarm ends when every siren's time has passed", () => {
    const h = new Home({
      sensors: [{ name: "front", arm: ArmState.Armed }],
      sirens: [{ name: "hall", maxSoundS: 60 }],
    });
    const t0 = h.now;
    h.door("front", true);
    h.advanceTo(t0 + 89 * SECOND);
    expect(h.decisions("alarm_ended")).toEqual([]);
    h.advanceTo(t0 + 91 * SECOND);
    expect(h.decisions("alarm_ended")).toHaveLength(1);
  });

  test("section 5: the alarm, its triggers and sirens are written now", () => {
    const h = home();
    h.door("front", true);
    h.advance(31_000);
    const tables = ["alarm", "alarm_triggers", "alarm_sirens"];
    const writes = h.world.effects.flatMap((e) =>
      e.kind === "write" && tables.includes(e.op.table) ? [e.durability] : [],
    );
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.every((d) => d === "now")).toBe(true);
  });

  test("D67: a trigger reopened during the alarm waits when it ends by itself; its countdown then sounds nothing", () => {
    const h = home();
    const t0 = h.now;
    h.door("front", true);
    h.advanceTo(t0 + 40 * SECOND);
    h.door("front", false);
    h.advanceTo(t0 + 310 * SECOND);
    h.door("front", true);
    h.advanceTo(t0 + 331 * SECOND);
    expect(armOf(h, "front")).toBe(ArmState.WaitsForCloseAfterAlarm);
    h.advanceTo(t0 + 400 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
    expect(actedCommands(h, "hall")).toHaveLength(1);
  });
});

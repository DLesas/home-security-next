/**
 * Sirens by group (m2-design.md section 7, "Which sirens a trigger sounds"; AL2a, AL6, AL11, D41,
 * D74, D95, D114), in the World with two scripted sirens on both paths: a trigger sounds the
 * sirens of every group its sensor is in, every siren for a sensor in no group; a second trigger
 * adds its groups' sirens not yet sounding and extends none; the automatic stop is unchanged.
 */
import { describe, expect, test } from "bun:test";
import { SirenAction, SirenState } from "@hsn/protocol";
import { sirenShould } from "../../../src/core/alarm/view.ts";
import { triggerSirens } from "../../../src/core/layout/view.ts";
import { groupId } from "../../../src/core/model/ids.ts";
import { ArmState } from "../../../src/core/model/rows.ts";
import { actedCommands, type GroupSpec, Home, SECOND } from "./harness.ts";

const DOWNSTAIRS = 1;
const UPSTAIRS = 2;

/** front downstairs (hall), bed upstairs (landing), back in both, garage in none. */
function home(groups?: readonly GroupSpec[]): Home {
  return new Home({
    sensors: [
      { name: "front", arm: ArmState.Armed },
      { name: "bed", arm: ArmState.Armed },
      { name: "back", arm: ArmState.Armed },
      { name: "garage", arm: ArmState.Armed },
    ],
    sirens: [{ name: "hall" }, { name: "landing" }],
    layout: {
      groups: groups ?? [
        { id: DOWNSTAIRS, name: "Downstairs", sensors: ["front", "back"], sirens: ["hall"] },
        { id: UPSTAIRS, name: "Upstairs", sensors: ["bed", "back"], sirens: ["landing"] },
      ],
    },
  });
}

const sounded = (h: Home, siren: string) =>
  actedCommands(h, siren).filter((c) => c.action === SirenAction.SoundAlarm);

/** Opens `sensor`'s door and lets its 30 s countdown run out. */
function trigger(h: Home, sensor: string): void {
  h.door(sensor, true);
  h.advance(31_000);
}

describe("which sirens a trigger sounds (AL2a, D41, D74)", () => {
  test("a sensor in one group sounds that group's sirens only", () => {
    const h = home();
    trigger(h, "front");
    expect(h.decisions("alarm")).toHaveLength(1);
    expect(sounded(h, "hall").map((c) => c.seconds)).toEqual([300]);
    expect(sounded(h, "landing")).toEqual([]);
    expect(h.scripted("landing").output).not.toBe(SirenState.SoundingAlarm);
    expect(sirenShould(h.world.state, h.sirenDevice("landing"), h.now)).toEqual({ kind: "off" });
    expect([...(h.world.state.alarm.alarm?.sirens.keys() ?? [])]).toEqual([h.sirenDevice("hall")]);
  });

  test("a sensor in no group sounds every siren", () => {
    const h = home();
    trigger(h, "garage");
    for (const siren of ["hall", "landing"]) {
      expect([siren, sounded(h, siren).map((c) => c.seconds)]).toEqual([siren, [300]]);
    }
  });

  test("a sensor in several groups sounds the sirens of all of them", () => {
    const h = home();
    trigger(h, "back");
    expect(sounded(h, "hall")).toHaveLength(1);
    expect(sounded(h, "landing")).toHaveLength(1);
  });

  test("a group of every siren (the default) sounds every siren, also beside a listed one", () => {
    const h = home([
      { id: DOWNSTAIRS, name: "Downstairs", sensors: ["front"], sirens: ["hall"] },
      { id: UPSTAIRS, name: "Everywhere", sensors: ["front"] },
    ]);
    trigger(h, "front");
    expect(sounded(h, "hall")).toHaveLength(1);
    expect(sounded(h, "landing")).toHaveLength(1);
  });
});

describe("a group's choice of sirens (AL2a)", () => {
  test("a group of every siren sounds every siren whatever list it keeps; a listed one only its list", () => {
    const h = home();
    const hall = h.sirenDevice("hall");
    const front = h.sensor("front");
    const withGroup = (allSirens: boolean) => ({
      ...h.world.state,
      layout: {
        ...h.world.state.layout,
        groups: new Map([
          [
            groupId(DOWNSTAIRS),
            {
              id: groupId(DOWNSTAIRS),
              name: "D",
              allSirens,
              sensors: [front],
              sirens: [hall],
              revision: 0,
            },
          ],
        ]),
      },
    });
    expect(triggerSirens(withGroup(true), front)).toBe("all");
    expect(triggerSirens(withGroup(false), front)).toEqual([hall]);
  });
});

describe("a second trigger (D95, D114)", () => {
  test("adds the sirens of its groups not yet sounding, and does not extend those already sounding", () => {
    const h = home();
    h.door("front", true);
    h.advance(10_000);
    h.door("bed", true);
    h.advance(21_000);
    const hallUntil = h.world.state.alarm.alarm?.sirens.get(h.sirenDevice("hall"))?.until;
    expect(sounded(h, "landing")).toEqual([]);
    h.advance(10_000);
    expect(h.decisions("alarm_trigger_added")).toHaveLength(1);
    expect(sounded(h, "landing").map((c) => c.seconds)).toEqual([300]);
    expect(sounded(h, "hall")).toHaveLength(1);
    expect(h.world.state.alarm.alarm?.sirens.get(h.sirenDevice("hall"))?.until).toBe(hallUntil);
  });

  test("a second trigger whose sirens all sound already commands nothing", () => {
    const h = home([
      { id: DOWNSTAIRS, name: "Downstairs", sensors: ["front", "back"], sirens: ["hall"] },
    ]);
    trigger(h, "front");
    const intents = h.messagesOf("sirenIntent").length;
    trigger(h, "back");
    expect(h.decisions("alarm_trigger_added")).toHaveLength(1);
    expect(h.messagesOf("sirenIntent")).toHaveLength(intents);
    expect(sounded(h, "hall")).toHaveLength(1);
    expect(sounded(h, "landing")).toEqual([]);
  });
});

describe("the automatic stop and the disarm, with groups (AL6, AL11, D67, D95)", () => {
  test("the alarm of a group's siren ends by itself at the automatic stop; the trigger waits for its door", () => {
    const h = home();
    const t0 = h.now;
    trigger(h, "front");
    h.advanceTo(t0 + 329 * SECOND);
    expect(h.world.state.alarm.alarm).toBeDefined();
    h.advanceTo(t0 + 331 * SECOND);
    expect(h.world.state.alarm.alarm).toBeUndefined();
    expect(h.decisions("alarm_ended").map((d) => d.value)).toEqual([0]);
    expect(h.world.state.alarm.sensors.get(h.sensor("front"))?.arm).toBe(
      ArmState.WaitsForCloseAfterAlarm,
    );
    expect(sounded(h, "landing")).toEqual([]);
  });

  test("a disarm of every trigger commands the group's sirens off", () => {
    const h = home();
    trigger(h, "front");
    h.command({ kind: "disarm", sensors: ["front"] });
    expect(h.world.state.alarm.alarm).toBeUndefined();
    const offs = h.messagesOf("sirenIntent").filter((m) => m.message.should.kind === "off");
    expect(offs.map((m) => m.message.siren)).toEqual([h.sirenDevice("hall")]);
  });
});

describe("a removed siren (section 7)", () => {
  test("removing a group's last listed siren returns it to every siren, a new revision", () => {
    const h = home();
    h.inject({ kind: "deviceRemoved", device: h.sirenDevice("hall") });
    const group = h.world.state.layout.groups.get(groupId(DOWNSTAIRS));
    expect(group?.allSirens).toBe(true);
    expect(group?.sirens).toEqual([]);
    expect(group?.revision).toBe(1);
    trigger(h, "front");
    expect(sounded(h, "landing")).toHaveLength(1);
  });

  test("a group whose list was stored empty sounds every siren: none sounds nothing", () => {
    const h = home([{ id: DOWNSTAIRS, name: "Downstairs", sensors: ["front"], sirens: [] }]);
    trigger(h, "front");
    expect(sounded(h, "hall")).toHaveLength(1);
    expect(sounded(h, "landing")).toHaveLength(1);
  });
});

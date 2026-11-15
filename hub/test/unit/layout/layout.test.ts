/**
 * The layout module and the arming it resolves (m2-design.md sections 1, 4 and 7, "Modes, groups
 * and arming"; D50, D74, D90, D95, D109, D114, D117, AL1, AL7, AL11, AL12, HB5a), through the real
 * core: layout, alarm and, where named, control are real; the other modules are the alarm
 * harness's stand-ins. A person's and a schedule's requests enter as app and schedules will send
 * them (`Home.request`).
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { Role } from "@hsn/protocol";
import { handleAlarm } from "../../../src/core/alarm/handle.ts";
import type { Context } from "../../../src/core/model/handler.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { armState } from "../../../src/core/alarm/view.ts";
import type { ArmingOp } from "../../../src/core/layout/resolve.ts";
import { currentMode, sensorsChanged, triggerSirens } from "../../../src/core/layout/view.ts";
import { loadLayout, migrationModeState, sensorList } from "../../../src/core/layout/handle.ts";
import {
  AWAY_MODE,
  clientId,
  connId,
  type DeviceId,
  deviceId,
  DISARMED_MODE,
  groupId,
  modeId,
  seq,
} from "../../../src/core/model/ids.ts";
import { ArmState, ModeFixed } from "../../../src/core/model/rows.ts";
import { ANNA, type HomeOptions, Home, NIGHT, SECOND } from "../../scenarios/alarm/harness.ts";
import { emptySnapshot } from "../../world/world.ts";

const NIGHT_MODE = 3;
const DOWNSTAIRS = 1;
const UPSTAIRS = 2;

/** Front and back downstairs, bed upstairs, garage in no group; a Night mode of downstairs. */
function home(options: Partial<HomeOptions> = {}): Home {
  return new Home({
    sensors: [
      { name: "front", arm: ArmState.Disarmed },
      { name: "back", arm: ArmState.Disarmed },
      { name: "bed", arm: ArmState.Disarmed },
      { name: "garage", arm: ArmState.Disarmed },
    ],
    sirens: [{ name: "hall" }],
    layout: {
      groups: [
        { id: DOWNSTAIRS, name: "Downstairs", sensors: ["front", "back"] },
        { id: UPSTAIRS, name: "Upstairs", sensors: ["bed", "back"] },
      ],
      modes: [{ id: NIGHT_MODE, name: "Night", groups: [DOWNSTAIRS] }],
      modeState: { currentModeId: DISARMED_MODE, modeModified: false },
    },
    ...options,
  });
}

function arms(h: Home, ...names: readonly string[]): (ArmState | undefined)[] {
  return names.map((name) => armState(h.world.state, h.sensor(name)));
}

const switchTo = (
  mode: number,
  confirm?: { openDoors: boolean; lowBattery: boolean },
): ArmingOp => ({
  op: "mode.switch",
  body: confirm === undefined ? { mode } : { mode, confirm },
});

/** The `mode_state` rows written, each with its durability. */
function modeStateWrites(h: Home) {
  return h.world.effects.flatMap((e) =>
    e.kind === "write" && e.op.op === "upsert" && e.op.table === "mode_state"
      ? [{ durability: e.durability, row: e.op.row }]
      : [],
  );
}

const ids = (h: Home, ...names: readonly string[]): DeviceId[] => names.map((n) => h.sensor(n));

describe("groups and modes as stored, the fixed modes and the migration's mode (section 4, D90)", () => {
  test("a snapshot without migration 2's rows still has Away and Disarmed", () => {
    const slice = loadLayout(emptySnapshot());
    expect([...slice.modes.values()].map((m) => [m.id, m.name, m.fixed])).toEqual([
      [AWAY_MODE, "Away", ModeFixed.Away],
      [DISARMED_MODE, "Disarmed", ModeFixed.Disarmed],
    ]);
  });

  test.each([
    ["no sensor armed: Disarmed", [ArmState.Disarmed, ArmState.Disarmed], DISARMED_MODE, false],
    [
      "every sensor armed, a waiting one too: Away",
      [ArmState.Armed, ArmState.WaitsForCloseAfterArming],
      AWAY_MODE,
      false,
    ],
    ["some armed: no mode, changed", [ArmState.Armed, ArmState.Disarmed], null, true],
  ] as const)("without a stored row, as the migration gives it: %s", (_, states, mode, changed) => {
    const h = new Home({
      sensors: states.map((arm, i) => ({ name: `s${i}`, arm })),
      sirens: [{ name: "hall" }],
    });
    expect(currentMode(h.world.state)).toEqual({ mode, modified: changed });
  });

  test("an empty site starts Disarmed: nothing protects the house (section 11, question 13)", () => {
    expect(migrationModeState(emptySnapshot())).toEqual({
      currentModeId: DISARMED_MODE,
      modeModified: false,
    });
  });

  test("the stored row is what the hub reads, not the sensors' states", () => {
    const h = home({
      layout: { modeState: { currentModeId: modeId(NIGHT_MODE), modeModified: true } },
    });
    expect(currentMode(h.world.state)).toEqual({ mode: modeId(NIGHT_MODE), modified: true });
  });

  test("groups keep their members and sirens; modes their groups", () => {
    const h = home();
    const slice = h.world.state.layout;
    expect(slice.groups.get(groupId(DOWNSTAIRS))?.sensors).toEqual(ids(h, "front", "back"));
    expect(slice.groups.get(groupId(DOWNSTAIRS))?.allSirens).toBe(true);
    expect(slice.modes.get(modeId(NIGHT_MODE))?.groups).toEqual([groupId(DOWNSTAIRS)]);
  });
});

describe("a switch to a mode (section 7, D74, D90)", () => {
  test("Away arms every sensor, ungrouped ones too, records the switch before the sensors and sets the mode now", () => {
    const h = home();
    const writesBefore = modeStateWrites(h).length;
    const decisionsBefore = h.decisions().length;
    const reply = h.request(switchTo(AWAY_MODE));
    expect(reply).toEqual({
      ok: true,
      body: {
        armed: ids(h, "front", "back", "bed", "garage"),
        disarmed: [],
        waiting: [],
        lowBattery: [],
        heldBack: [],
      },
    });
    expect(arms(h, "front", "back", "bed", "garage")).toEqual([
      ArmState.Armed,
      ArmState.Armed,
      ArmState.Armed,
      ArmState.Armed,
    ]);
    const kinds = h
      .decisions()
      .slice(decisionsBefore)
      .map((d) => d.kind);
    expect(kinds).toEqual(["mode_switched", "armed", "armed", "armed", "armed"]);
    const switched = h.decisions("mode_switched")[0];
    expect(switched?.value).toBe(AWAY_MODE);
    expect(new TextDecoder().decode(switched?.detail ?? new Uint8Array())).toBe("Anna (client 7)");
    expect(modeStateWrites(h).slice(writesBefore)).toEqual([
      { durability: "now", row: { currentModeId: AWAY_MODE, modeModified: false } },
    ]);
    expect(currentMode(h.world.state)).toEqual({ mode: AWAY_MODE, modified: false });
  });

  test("a mode arms exactly its sensors and disarms the rest; a sensor already as it wants is untouched", () => {
    const h = home();
    h.request({ op: "arm", body: { target: { sensor: h.sensor("front") } } });
    h.request({ op: "arm", body: { target: { sensor: h.sensor("bed") } } });
    const changedBefore = h.messagesOf("armedChanged").length;
    const reply = h.request(switchTo(NIGHT_MODE));
    expect(reply).toEqual({
      ok: true,
      body: {
        armed: ids(h, "back"),
        disarmed: ids(h, "bed"),
        waiting: [],
        lowBattery: [],
        heldBack: [],
      },
    });
    expect(arms(h, "front", "back", "bed", "garage")).toEqual([
      ArmState.Armed,
      ArmState.Armed,
      ArmState.Disarmed,
      ArmState.Disarmed,
    ]);
    // front was armed already: no new state, so no new settings version (HD 8).
    expect(
      h
        .messagesOf("armedChanged")
        .slice(changedBefore)
        .map((m) => m.message.sensor),
    ).toEqual(ids(h, "back", "bed"));
    expect(currentMode(h.world.state)).toEqual({ mode: modeId(NIGHT_MODE), modified: false });
  });

  test("Disarmed disarms everything; a switch to the current mode still clears 'changed'", () => {
    const h = home();
    h.request(switchTo(AWAY_MODE));
    h.request({ op: "disarm", body: { target: { sensor: h.sensor("garage") } } });
    expect(currentMode(h.world.state)).toEqual({ mode: AWAY_MODE, modified: true });
    h.request(switchTo(AWAY_MODE));
    expect(currentMode(h.world.state)).toEqual({ mode: AWAY_MODE, modified: false });
    // Once more, nothing to change: recorded, but the row is as it is and is not written.
    const writes = modeStateWrites(h).length;
    h.request(switchTo(AWAY_MODE));
    expect(modeStateWrites(h)).toHaveLength(writes);
    expect(h.decisions("mode_switched")).toHaveLength(3);
    h.request(switchTo(DISARMED_MODE));
    expect(arms(h, "front", "back", "bed", "garage")).toEqual([
      ArmState.Disarmed,
      ArmState.Disarmed,
      ArmState.Disarmed,
      ArmState.Disarmed,
    ]);
    expect(currentMode(h.world.state).mode).toBe(DISARMED_MODE);
  });

  test("a mode that does not exist is notFound and changes nothing", () => {
    const h = home();
    expect(h.request(switchTo(9))).toEqual({
      ok: false,
      error: { code: "notFound", detail: { what: "mode", id: 9 } },
    });
    expect(h.decisions("mode_switched")).toEqual([]);
  });
});

describe("arming a group or a sensor adds; disarming a group is per sensor (section 7, D74)", () => {
  test("a group's arm adds to what is armed and marks the mode changed, written now", () => {
    const h = home();
    h.request(switchTo(NIGHT_MODE));
    const writesBefore = modeStateWrites(h).length;
    expect(h.request({ op: "arm", body: { target: { group: UPSTAIRS } } })).toEqual({
      ok: true,
      body: { armed: ids(h, "bed"), disarmed: [], waiting: [], lowBattery: [] },
    });
    expect(arms(h, "front", "back", "bed", "garage")).toEqual([
      ArmState.Armed,
      ArmState.Armed,
      ArmState.Armed,
      ArmState.Disarmed,
    ]);
    expect(currentMode(h.world.state)).toEqual({ mode: modeId(NIGHT_MODE), modified: true });
    expect(modeStateWrites(h).slice(writesBefore)).toEqual([
      { durability: "now", row: { currentModeId: modeId(NIGHT_MODE), modeModified: true } },
    ]);
    expect(h.decisions("mode_switched")).toHaveLength(1);
  });

  test("an arm that changes nothing leaves the mode as it was", () => {
    const h = home();
    h.request(switchTo(AWAY_MODE));
    h.request({ op: "arm", body: { target: { group: DOWNSTAIRS } } });
    expect(currentMode(h.world.state)).toEqual({ mode: AWAY_MODE, modified: false });
  });

  test("disarming a group disarms a sensor another armed group also holds", () => {
    const h = home();
    h.request({ op: "arm", body: { target: { group: DOWNSTAIRS } } });
    h.request({ op: "arm", body: { target: { group: UPSTAIRS } } });
    const reply = h.request({ op: "disarm", body: { target: { group: UPSTAIRS } } });
    expect(reply).toEqual({
      ok: true,
      body: { disarmed: ids(h, "back", "bed"), heldBack: [], alarmEnded: false },
    });
    expect(arms(h, "front", "back", "bed")).toEqual([
      ArmState.Armed,
      ArmState.Disarmed,
      ArmState.Disarmed,
    ]);
  });

  test("a group or a sensor that does not exist is notFound", () => {
    const h = home();
    expect(h.request({ op: "arm", body: { target: { group: 9 } } })).toEqual({
      ok: false,
      error: { code: "notFound", detail: { what: "group", id: 9 } },
    });
    const siren = h.sirenDevice("hall");
    expect(h.request({ op: "disarm", body: { target: { sensor: siren } } })).toEqual({
      ok: false,
      error: { code: "notFound", detail: { what: "device", id: siren } },
    });
    expect(h.request({ op: "arm", body: { target: { sensor: siren } } })).toMatchObject({
      ok: false,
      error: { code: "notFound" },
    });
    // Layout refuses them itself: nothing reaches the alarm.
    expect(h.messagesOf("armSensors")).toEqual([]);
    expect(h.messagesOf("disarmSensors")).toEqual([]);
    // And the alarm refuses an id that is no sensor of its own, should one reach it.
    h.inject({
      kind: "armSensors",
      sensors: [siren],
      mode: undefined,
      confirm: undefined,
      actor: ANNA,
      answerTo: { kind: "app", conn: connId(1), client: clientId(7), id: 99, seq: undefined },
      record: seq(0),
    });
    expect(h.messagesOf("opAnswer").at(-1)?.message.outcome).toEqual({
      ok: false,
      error: { code: "notFound", detail: { what: "device", id: siren } },
    });
    expect(armState(h.world.state, siren)).toBeUndefined();
  });

  test("M1a's hsn arm <sensor> marks the mode changed; a refused one does not", () => {
    const h = home();
    h.door("front", true);
    h.command({ kind: "arm", sensors: ["front"], continue: false });
    expect(currentMode(h.world.state)).toEqual({ mode: DISARMED_MODE, modified: false });
    h.command({ kind: "arm", sensors: ["bed"], continue: false });
    expect(currentMode(h.world.state)).toEqual({ mode: DISARMED_MODE, modified: true });
  });
});

describe("confirmation: open doors and low batteries (D50, D109, AL7, AL12)", () => {
  test("an open door is named and nothing changes, the switch not recorded; confirmed, it waits and the rest arm", () => {
    const h = home();
    h.door("back", true);
    const writesBefore = modeStateWrites(h).length;
    expect(h.request(switchTo(NIGHT_MODE))).toEqual({
      ok: false,
      error: {
        code: "needsConfirmation",
        detail: { openDoors: ids(h, "back"), lowBattery: [] },
      },
    });
    expect(arms(h, "front", "back")).toEqual([ArmState.Disarmed, ArmState.Disarmed]);
    expect(h.decisions("mode_switched")).toEqual([]);
    expect(modeStateWrites(h).slice(writesBefore)).toEqual([]);
    expect(currentMode(h.world.state)).toEqual({ mode: DISARMED_MODE, modified: false });

    const reply = h.request(switchTo(NIGHT_MODE, { openDoors: true, lowBattery: false }));
    expect(reply).toEqual({
      ok: true,
      body: {
        armed: ids(h, "front"),
        disarmed: [],
        waiting: ids(h, "back"),
        lowBattery: [],
        heldBack: [],
      },
    });
    expect(arms(h, "front", "back")).toEqual([ArmState.Armed, ArmState.WaitsForCloseAfterArming]);
    h.door("back", false);
    expect(arms(h, "back")).toEqual([ArmState.Armed]);
  });

  test("a battery at 10% or below asks (3,500 mV); just above it does not (3,510 mV)", () => {
    for (const [code, asks] of [
      [100, true],
      [101, false],
    ] as const) {
      const h = home();
      h.setBattery("front", code);
      h.heartbeat("front", false);
      const reply = h.request({ op: "arm", body: { target: { group: DOWNSTAIRS } } });
      expect([code, reply?.ok]).toEqual([code, !asks]);
      if (asks) {
        expect(reply).toEqual({
          ok: false,
          error: {
            code: "needsConfirmation",
            detail: { openDoors: [], lowBattery: ids(h, "front") },
          },
        });
        expect(arms(h, "front", "back")).toEqual([ArmState.Disarmed, ArmState.Disarmed]);
        h.request({
          op: "arm",
          body: { target: { group: DOWNSTAIRS }, confirm: { openDoors: false, lowBattery: true } },
        });
        expect(arms(h, "front", "back")).toEqual([ArmState.Armed, ArmState.Armed]);
      }
    }
  });

  test("confirming one kind does not confirm the other", () => {
    const h = home();
    h.door("back", true);
    h.setBattery("front", 50);
    h.heartbeat("front", false);
    const reply = h.request(switchTo(NIGHT_MODE, { openDoors: true, lowBattery: false }));
    expect(reply).toMatchObject({ ok: false, error: { code: "needsConfirmation" } });
    expect(arms(h, "front", "back")).toEqual([ArmState.Disarmed, ArmState.Disarmed]);
  });

  test("only sensors the request would arm are asked about: an armed low battery is not", () => {
    const h = home();
    h.request(switchTo(AWAY_MODE));
    h.setBattery("front", 50);
    h.heartbeat("front", false);
    expect(h.request(switchTo(NIGHT_MODE))?.ok).toBe(true);
  });

  test("a schedule never asks: the open door waits, the low battery is armed, and the answer names both", () => {
    const h = home();
    h.door("back", true);
    h.setBattery("front", 50);
    h.heartbeat("front", false);
    // Answered to the schedule, which records its run from it (section 7, "Schedules").
    expect(h.request(switchTo(NIGHT_MODE), NIGHT)).toEqual({
      ok: true,
      body: {
        armed: ids(h, "front"),
        disarmed: [],
        waiting: ids(h, "back"),
        lowBattery: ids(h, "front"),
        heldBack: [],
      },
    });
    expect(arms(h, "front", "back")).toEqual([ArmState.Armed, ArmState.WaitsForCloseAfterArming]);
    expect(currentMode(h.world.state)).toEqual({ mode: modeId(NIGHT_MODE), modified: false });
    expect(new TextDecoder().decode(h.decisions("armed")[0]?.detail ?? new Uint8Array())).toBe(
      "schedule Night",
    );
  });
});

describe("arming during a countdown or an alarm (section 7, 'Awkward cases'; D24, D95, D117)", () => {
  function armedHome(): Home {
    const h = home();
    h.request(switchTo(AWAY_MODE));
    return h;
  }

  test("a switch that disarms the counting sensor cancels its countdown; one that keeps it armed leaves it", () => {
    const h = armedHome();
    h.advance(10_000);
    h.door("front", true);
    h.door("bed", true);
    expect(h.world.state.alarm.countdowns.size).toBe(2);
    h.request(switchTo(NIGHT_MODE));
    expect([...h.world.state.alarm.countdowns.keys()]).toEqual(ids(h, "front"));
    expect(h.messagesOf("countdownCancelled").map((m) => m.message.sensor)).toEqual(ids(h, "bed"));
  });

  test("Disarmed during an alarm disarms every trigger and ends it, the sirens commanded off", () => {
    const h = armedHome();
    h.advance(10_000);
    h.door("front", true);
    h.advance(31_000);
    expect(h.world.state.alarm.alarm).toBeDefined();
    h.request(switchTo(DISARMED_MODE));
    expect(h.world.state.alarm.alarm).toBeUndefined();
    expect(h.decisions("alarm_ended").map((d) => d.value)).toEqual([1]);
    const offs = h.messagesOf("sirenIntent").filter((m) => m.message.should.kind === "off");
    expect(offs).toHaveLength(1);
  });

  test("a person's disarm that leaves a trigger armed: the alarm continues and the answer names it (D95)", () => {
    const h = armedHome();
    h.advance(10_000);
    h.door("garage", true);
    h.advance(31_000);
    const reply = h.request({ op: "disarm", body: { target: { group: DOWNSTAIRS } } });
    expect(reply).toEqual({
      ok: true,
      body: {
        disarmed: ids(h, "front", "back"),
        heldBack: [],
        alarmEnded: false,
        alarmContinues: { triggers: ids(h, "garage") },
      },
    });
    expect(h.world.state.alarm.alarm).toBeDefined();
  });

  test("a schedule's disarm leaves the triggers and counting sensors armed and the sirens on (D117)", () => {
    const h = armedHome();
    h.advance(10_000);
    h.door("front", true);
    h.advance(31_000);
    h.door("back", true);
    expect(h.world.state.alarm.alarm?.triggers.has(h.sensor("front"))).toBe(true);
    expect(h.world.state.alarm.countdowns.has(h.sensor("back"))).toBe(true);
    h.request({ op: "disarm", body: { target: { group: UPSTAIRS } } }, NIGHT);
    expect(h.request({ op: "disarm", body: { target: { group: DOWNSTAIRS } } }, NIGHT)).toEqual({
      ok: true,
      body: {
        disarmed: [],
        heldBack: ids(h, "front", "back"),
        alarmEnded: false,
        alarmContinues: { triggers: ids(h, "front") },
      },
    });
    expect(arms(h, "front", "back", "bed", "garage")).toEqual([
      ArmState.Armed,
      ArmState.Armed,
      ArmState.Disarmed,
      ArmState.Armed,
    ]);
    expect(h.world.state.alarm.alarm).toBeDefined();
    expect(h.world.state.alarm.countdowns.has(h.sensor("back"))).toBe(true);
    // A person's disarm of the same group still ends it (D95): a schedule is not a person.
    h.request({ op: "disarm", body: { target: { group: DOWNSTAIRS } } });
    expect(h.world.state.alarm.alarm).toBeUndefined();
  });

  test("a schedule's switch to Disarmed holds back the same, and the mode shows as changed", () => {
    const h = armedHome();
    h.advance(10_000);
    h.door("front", true);
    h.advance(31_000);
    h.request(switchTo(DISARMED_MODE), NIGHT);
    expect(arms(h, "front", "back", "bed", "garage")).toEqual([
      ArmState.Armed,
      ArmState.Disarmed,
      ArmState.Disarmed,
      ArmState.Disarmed,
    ]);
    expect(h.world.state.alarm.alarm).toBeDefined();
    expect(currentMode(h.world.state)).toEqual({ mode: DISARMED_MODE, modified: true });
  });
});

describe("a sensor added while a mode is current (section 12, Q8)", () => {
  test("starts disarmed, and the next switch to Away arms it", () => {
    const h = home();
    h.request(switchTo(AWAY_MODE));
    const added = deviceId(150);
    // The alarm's own handling of `deviceAdded` (setup sends it when provisioning begins, which
    // this harness has no board for).
    const ctx: Context = {
      now: h.world.now,
      view: h.world.state,
      deps: h.world.deps,
      entropy: entropyCursor(new Uint8Array(32), "tick"),
      records: { take: () => ok(seq(0)) },
      event: "tick",
    };
    const handled = handleAlarm(
      h.world.state.alarm,
      { kind: "deviceAdded", device: added, role: Role.Sensor, address: 0x5e0000ff, name: "porch" },
      ctx,
    );
    expect(handled.isOk()).toBe(true);
    if (handled.isOk()) h.world.state = { ...h.world.state, alarm: handled.value.slice };
    expect(armState(h.world.state, added)).toBe(ArmState.Disarmed);
    expect(currentMode(h.world.state)).toEqual({ mode: AWAY_MODE, modified: false });
    h.request(switchTo(AWAY_MODE));
    expect(armState(h.world.state, added)).toBe(ArmState.Armed);
  });
});

describe("which sensors a request would change, for HB5a's check (section 7)", () => {
  test("a switch names those it would arm or disarm; a group's arm or disarm those it would change", () => {
    const h = home();
    h.request({ op: "arm", body: { target: { sensor: h.sensor("bed") } } });
    h.request({ op: "arm", body: { target: { sensor: h.sensor("front") } } });
    const view = h.world.state;
    expect(sensorsChanged(view, { kind: "mode", mode: modeId(NIGHT_MODE) })).toEqual(
      ids(h, "back", "bed"),
    );
    expect(sensorsChanged(view, { kind: "arm", group: groupId(UPSTAIRS) })).toEqual(ids(h, "back"));
    expect(sensorsChanged(view, { kind: "disarm", group: groupId(DOWNSTAIRS) })).toEqual(
      ids(h, "front"),
    );
    expect(sensorsChanged(view, { kind: "mode", mode: DISARMED_MODE })).toEqual(
      ids(h, "front", "bed"),
    );
    expect(sensorsChanged(view, { kind: "mode", mode: modeId(9) })).toBeUndefined();
    expect(sensorsChanged(view, { kind: "arm", group: groupId(9) })).toBeUndefined();
  });

  test("disarm 'mine' disarms every armed sensor the person may manage: all while user management is off (D13, D51)", () => {
    const h = home();
    h.request(switchTo(AWAY_MODE));
    expect(h.request({ op: "disarm", body: { target: "mine" } })).toMatchObject({
      ok: true,
      body: { disarmed: ids(h, "front", "back", "bed", "garage") },
    });
    expect(arms(h, "front", "back", "bed", "garage")).toEqual([
      ArmState.Disarmed,
      ArmState.Disarmed,
      ArmState.Disarmed,
      ArmState.Disarmed,
    ]);
  });
});

describe("a removed device leaves its groups (section 7)", () => {
  test("a sensor leaves its groups, which take a new revision, written now", () => {
    const h = home();
    h.inject({ kind: "deviceRemoved", device: h.sensor("back") });
    const groups = h.world.state.layout.groups;
    expect(groups.get(groupId(DOWNSTAIRS))?.sensors).toEqual(ids(h, "front"));
    expect(groups.get(groupId(UPSTAIRS))?.sensors).toEqual(ids(h, "bed"));
    expect(groups.get(groupId(DOWNSTAIRS))?.revision).toBe(1);
    const writes = h.world.effects.flatMap((e) =>
      e.kind === "write" && (e.op.table === "group_members" || e.op.table === "groups")
        ? [[e.durability, e.op.table, e.op.op]]
        : [],
    );
    expect(writes).toEqual([
      ["now", "group_members", "delete"],
      ["now", "groups", "upsert"],
      ["now", "group_members", "delete"],
      ["now", "groups", "upsert"],
    ]);
  });
});

describe("the second switch keeps a countdown's time (D86, AL3)", () => {
  test("switching to Away during a countdown neither restarts nor cancels it", () => {
    const h = home();
    h.request(switchTo(AWAY_MODE));
    h.advance(10_000);
    h.door("front", true);
    const deadline = h.world.state.alarm.countdowns.get(h.sensor("front"))?.deadline;
    h.advance(5_000);
    h.request(switchTo(AWAY_MODE));
    expect(h.world.state.alarm.countdowns.get(h.sensor("front"))?.deadline).toBe(deadline);
    h.advanceTo(h.now + 26 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
  });
});

describe("arming_changed: every arming action that is not a switch (section 7; A6's notice)", () => {
  test("a group's arm, a sensor's disarm and hsn arm <sensor> each record one, before their sensors", () => {
    const h = home({ realControl: true });
    const since = () => h.decisions().length;
    let before = since();
    h.request({ op: "arm", body: { target: { group: DOWNSTAIRS } } });
    expect(
      h
        .decisions()
        .slice(before)
        .map((d) => [d.kind, d.deviceId, d.value]),
    ).toEqual([
      ["arming_changed", null, 1],
      ["armed", h.sensor("front"), null],
      ["armed", h.sensor("back"), null],
    ]);
    // Its detail names the sensors it changed, each a device number as u32 LE, which notify
    // reads for the notice's recipients: front (100) and back (101).
    const changed = h.decisions("arming_changed")[0];
    expect([h.sensor("front"), h.sensor("back")]).toEqual([deviceId(100), deviceId(101)]);
    expect([...(changed?.detail ?? new Uint8Array())]).toEqual([100, 0, 0, 0, 101, 0, 0, 0]);
    before = since();
    h.request({ op: "disarm", body: { target: { sensor: h.sensor("front") } } });
    expect(
      h
        .decisions()
        .slice(before)
        .map((d) => [d.kind, d.deviceId, d.value]),
    ).toEqual([
      ["arming_changed", h.sensor("front"), 0],
      ["disarmed", h.sensor("front"), null],
    ]);
    before = since();
    h.command({ kind: "arm", sensors: ["bed"], continue: false }, "bench");
    expect(
      h
        .decisions()
        .slice(before)
        .map((d) => [d.kind, d.deviceId, d.value]),
    ).toEqual([
      ["arming_changed", h.sensor("bed"), 1],
      ["armed", h.sensor("bed"), null],
    ]);
    expect([...(h.decisions("arming_changed").at(-1)?.detail ?? new Uint8Array())]).toEqual([
      102, 0, 0, 0,
    ]);
    // An action that changes nothing names no sensor: bed is armed already.
    h.request({ op: "arm", body: { target: { sensor: h.sensor("bed") } } });
    expect(h.decisions("arming_changed").at(-1)?.detail).toEqual(new Uint8Array());
    // A number above 255 keeps all four bytes, low byte first.
    expect([...sensorList([deviceId(0x01020304)])]).toEqual([4, 3, 2, 1]);
  });

  test("none for a switch, a refused request, or a refused hsn arm", () => {
    const h = home({ realControl: true });
    h.request(switchTo(AWAY_MODE));
    h.request(switchTo(DISARMED_MODE));
    h.door("front", true);
    h.request({ op: "arm", body: { target: { group: DOWNSTAIRS } } });
    h.command({ kind: "arm", sensors: ["front"], continue: false });
    expect(h.decisions("arming_changed")).toEqual([]);
    expect(h.decisions("mode_switched")).toHaveLength(2);
  });
});

describe("disarm 'mine' with user management on (D13, D33, D51)", () => {
  test("only the armed sensors the person may manage are disarmed", () => {
    const h = home({ anna: { userManagement: true, manages: ["front", "bed"] } });
    h.request(switchTo(AWAY_MODE), NIGHT);
    expect(h.request({ op: "disarm", body: { target: "mine" } })).toMatchObject({
      ok: true,
      body: { disarmed: ids(h, "front", "bed") },
    });
    expect(arms(h, "front", "back", "bed", "garage")).toEqual([
      ArmState.Disarmed,
      ArmState.Armed,
      ArmState.Disarmed,
      ArmState.Armed,
    ]);
  });
});

describe("deleting a group or a mode (section 6; section 11, 'Step 1's questions, settled')", () => {
  const scheduled = (): Home =>
    home({
      realControl: true,
      schedules: [
        { id: 4, group: UPSTAIRS },
        { id: 5, mode: NIGHT_MODE },
        { id: 6, sensor: "garage" },
      ],
    });

  test("what a schedule names is refused, naming the entries; nothing changes", () => {
    const h = scheduled();
    expect(h.request({ op: "group.delete", body: { group: UPSTAIRS, ifRevision: 0 } })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "group", reason: "inUse", refs: [4] } },
    });
    expect(h.request({ op: "mode.delete", body: { mode: NIGHT_MODE, ifRevision: 0 } })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "mode", reason: "inUse", refs: [5] } },
    });
    expect(h.world.state.layout.groups.has(groupId(UPSTAIRS))).toBe(true);
    expect(h.world.state.layout.modes.has(modeId(NIGHT_MODE))).toBe(true);
  });

  test("hsn device remove of a sensor a schedule names is refused, naming the entries", () => {
    const h = scheduled();
    expect(h.command({ kind: "deviceRemove", name: "garage" })).toEqual({
      ok: false,
      error: {
        code: "opRefused",
        message: "named by schedules 6",
        app: { code: "invalid", detail: { field: "device", reason: "inUse", refs: [6] } },
      },
    });
  });

  test("a group nothing names goes, with its rows, and the modes holding it lose it", () => {
    const h = scheduled();
    expect(h.request({ op: "group.delete", body: { group: DOWNSTAIRS, ifRevision: 0 } })).toEqual({
      ok: true,
      body: {},
    });
    expect(h.world.state.layout.groups.has(groupId(DOWNSTAIRS))).toBe(false);
    const night = h.world.state.layout.modes.get(modeId(NIGHT_MODE));
    expect([night?.groups, night?.revision]).toEqual([[], 1]);
    const writes = h.world.effects.flatMap((e) =>
      e.kind === "write" && e.op.op !== "prune" ? [[e.durability, e.op.table, e.op.op]] : [],
    );
    expect(writes.slice(-5)).toEqual([
      ["now", "group_members", "delete"],
      ["now", "group_members", "delete"],
      ["now", "groups", "delete"],
      ["now", "mode_groups", "delete"],
      ["now", "modes", "upsert"],
    ]);
  });

  test("an unknown one is notFound; a stale revision a conflict with the object; a fixed mode is refused", () => {
    const h = scheduled();
    expect(h.request({ op: "group.delete", body: { group: 9, ifRevision: 0 } })).toEqual({
      ok: false,
      error: { code: "notFound", detail: { what: "group", id: 9 } },
    });
    expect(h.request({ op: "group.delete", body: { group: DOWNSTAIRS, ifRevision: 3 } })).toEqual({
      ok: false,
      error: {
        code: "conflict",
        detail: {
          revision: 0,
          object: {
            id: DOWNSTAIRS,
            name: "Downstairs",
            sensors: ids(h, "front", "back"),
            sirens: "all",
            revision: 0,
          },
        },
      },
    });
    expect(h.request({ op: "mode.delete", body: { mode: AWAY_MODE, ifRevision: 0 } })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "mode", reason: "fixed" } },
    });
    expect(h.request({ op: "mode.delete", body: { mode: NIGHT_MODE, ifRevision: 1 } })).toEqual({
      ok: false,
      error: {
        code: "conflict",
        detail: {
          revision: 0,
          object: { id: NIGHT_MODE, name: "Night", fixed: "no", groups: [DOWNSTAIRS], revision: 0 },
        },
      },
    });
  });

  test("deleting the current mode leaves arming that matches no mode, changed", () => {
    const h = home();
    h.request(switchTo(NIGHT_MODE));
    expect(h.request({ op: "mode.delete", body: { mode: NIGHT_MODE, ifRevision: 0 } })).toEqual({
      ok: true,
      body: {},
    });
    expect(currentMode(h.world.state)).toEqual({ mode: null, modified: true });
  });
});

describe("mode_switched is written now (section 11, 'Step 1's questions, settled')", () => {
  /** The commit a decision of `kind` reached, the last one, with whether it was flushed at once. */
  function commitOf(h: Home, kind: string) {
    return h.world.writer.commits.findLast((c) =>
      c.items.some(
        (i) => i.kind === "record" && i.record.kind === "decision" && i.record.row.kind === kind,
      ),
    );
  }

  test("in the commit of the switch, with its sensors' arming", () => {
    const h = home();
    const commits = h.world.writer.commits.length;
    h.request(switchTo(AWAY_MODE));
    expect(h.decisions("mode_switched").map((d) => d.durability)).toEqual(["now"]);
    const commit = commitOf(h, "mode_switched");
    expect(h.world.writer.commits.length).toBe(commits + 1);
    expect(commit === h.world.writer.commits.at(-1)).toBe(true);
    expect(commit?.items.some((i) => i.kind === "write" && i.op.table === "sensor_config")).toBe(
      true,
    );
  });

  test("a switch that changes no sensor still commits its record at once", () => {
    const h = home();
    h.request(switchTo(AWAY_MODE));
    const commits = h.world.writer.commits.length;
    h.request(switchTo(AWAY_MODE));
    expect(h.decisions("mode_switched").map((d) => d.durability)).toEqual(["now", "now"]);
    expect(h.world.writer.commits.length).toBe(commits + 1);
    const commit = h.world.writer.commits.at(-1);
    expect(
      commit?.items
        .filter((i) => i.kind === "record" && i.record.kind === "decision")
        .map((i) => (i.kind === "record" && i.record.kind === "decision" ? i.record.row.kind : "")),
    ).toContain("mode_switched");
    expect(commit?.items.some((i) => i.kind === "write" && i.op.table === "sensor_config")).toBe(
      false,
    );
  });
});

describe("making and changing groups and modes (section 6, group.* and mode.*; section 7)", () => {
  const tableWrites = (h: Home, from: number) =>
    h.world.effects
      .slice(from)
      .flatMap((e) =>
        e.kind === "write" && e.op.op !== "prune" ? [[e.durability, e.op.table, e.op.op]] : [],
      );

  test("group.create makes the group, revision 0, its rows written now, and answers it", () => {
    const h = home({ realControl: true });
    const from = h.world.effects.length;
    const reply = h.request({
      op: "group.create",
      body: {
        name: "Outside",
        sensors: [h.sensor("garage"), h.sensor("garage")],
        sirens: [h.sirenDevice("hall")],
      },
    });
    expect(reply).toEqual({
      ok: true,
      body: {
        id: 3,
        name: "Outside",
        sensors: ids(h, "garage"),
        sirens: [h.sirenDevice("hall")],
        revision: 0,
      },
    });
    expect(tableWrites(h, from)).toEqual([
      ["now", "groups", "upsert"],
      ["now", "group_members", "upsert"],
      ["now", "group_sirens", "upsert"],
    ]);
    expect(triggerSirens(h.world.state, h.sensor("garage"))).toEqual([h.sirenDevice("hall")]);
    // hsn op answers the same body (section 6).
    expect(
      h.command({
        kind: "op",
        operation: { op: "group.create", body: { name: "Porch", sensors: [], sirens: "all" } },
      }),
    ).toMatchObject({
      ok: true,
      result: { kind: "op", body: { id: 4, name: "Porch", sirens: "all" } },
    });
  });

  test("a name taken, a sensor or siren that is none, a list of no siren: refused, nothing made", () => {
    const h = home();
    const create = (body: {
      name: string;
      sensors: readonly number[];
      sirens: "all" | readonly number[];
    }) => h.request({ op: "group.create", body });
    expect(create({ name: "Downstairs", sensors: [], sirens: "all" })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "name", reason: "taken" } },
    });
    expect(
      create({ name: "X", sensors: [h.sensor("front"), h.sirenDevice("hall")], sirens: "all" }),
    ).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "sensors.1", reason: "unknownReference" } },
    });
    expect(create({ name: "X", sensors: [], sirens: [h.sensor("front")] })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "sirens.0", reason: "unknownReference" } },
    });
    expect(create({ name: "X", sensors: [], sirens: [] })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "sirens", reason: "range" } },
    });
    expect(h.world.state.layout.groups.size).toBe(2);
  });

  test("group.update needs the current revision, takes the next, writes what differs, and changes no arming", () => {
    const h = home();
    h.request({ op: "arm", body: { target: { group: DOWNSTAIRS } } });
    const stale = h.request({
      op: "group.update",
      body: {
        group: DOWNSTAIRS,
        name: "Down",
        sensors: [h.sensor("front")],
        sirens: "all",
        ifRevision: 4,
      },
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "conflict", detail: { revision: 0 } },
    });
    const from = h.world.effects.length;
    const reply = h.request({
      op: "group.update",
      body: {
        group: DOWNSTAIRS,
        name: "Down",
        sensors: [h.sensor("front"), h.sensor("garage")],
        sirens: "all",
        ifRevision: 0,
      },
    });
    expect(reply).toEqual({
      ok: true,
      body: {
        id: DOWNSTAIRS,
        name: "Down",
        sensors: ids(h, "front", "garage"),
        sirens: "all",
        revision: 1,
      },
    });
    expect(tableWrites(h, from)).toEqual([
      ["now", "groups", "upsert"],
      ["now", "group_members", "delete"],
      ["now", "group_members", "upsert"],
    ]);
    // Editing a group while armed changes no sensor's state (section 7).
    expect(arms(h, "front", "back", "garage")).toEqual([
      ArmState.Armed,
      ArmState.Armed,
      ArmState.Disarmed,
    ]);
    expect(
      h.request({
        op: "group.update",
        body: { group: DOWNSTAIRS, name: "Upstairs", sensors: [], sirens: "all", ifRevision: 1 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "name", reason: "taken" } },
    });
    expect(
      h.request({
        op: "group.update",
        body: { group: 9, name: "Z", sensors: [], sirens: "all", ifRevision: 0 },
      }),
    ).toEqual({ ok: false, error: { code: "notFound", detail: { what: "group", id: 9 } } });
  });

  test("mode.create and mode.update: names unique among modes, groups that exist, fixed modes refused", () => {
    const h = home();
    expect(h.request({ op: "mode.create", body: { name: "Away", groups: [] } })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "name", reason: "taken" } },
    });
    expect(h.request({ op: "mode.create", body: { name: "Bed", groups: [UPSTAIRS, 9] } })).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "groups.1", reason: "unknownReference" } },
    });
    expect(h.request({ op: "mode.create", body: { name: "Bed", groups: [UPSTAIRS] } })).toEqual({
      ok: true,
      body: { id: 4, name: "Bed", fixed: "no", groups: [UPSTAIRS], revision: 0 },
    });
    expect(
      h.request({
        op: "mode.update",
        body: { mode: AWAY_MODE, name: "Out", groups: [], ifRevision: 0 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid", detail: { field: "mode", reason: "fixed" } },
    });
    expect(
      h.request({
        op: "mode.update",
        body: { mode: 4, name: "Bed", groups: [DOWNSTAIRS], ifRevision: 1 },
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict", detail: { revision: 0 } } });
    expect(
      h.request({
        op: "mode.update",
        body: { mode: 4, name: "Bed", groups: [DOWNSTAIRS], ifRevision: 0 },
      }),
    ).toEqual({
      ok: true,
      body: { id: 4, name: "Bed", fixed: "no", groups: [DOWNSTAIRS], revision: 1 },
    });
    // The next switch to it arms its new groups' sensors.
    h.request(switchTo(4));
    expect(arms(h, "front", "back", "bed")).toEqual([
      ArmState.Armed,
      ArmState.Armed,
      ArmState.Disarmed,
    ]);
  });
});

/**
 * `hsn arm --all` and `hsn disarm --all` as switches to the fixed modes Away and Disarmed
 * (m2-design.md section 1; D90): the real control, layout and alarm modules, with the alarm
 * harness's stand-ins for the rest. A site with only the fixed modes and no groups must behave
 * exactly as M1a's hub did: the same answers, the same per-sensor decisions, the same packets,
 * with one decision more before them, `mode_switched`.
 */
import { describe, expect, test } from "bun:test";
import { armState } from "../../../src/core/alarm/view.ts";
import { currentMode } from "../../../src/core/layout/view.ts";
import type { ControlCommand } from "../../../src/core/model/control.ts";
import { AWAY_MODE, DISARMED_MODE } from "../../../src/core/model/ids.ts";
import { ArmState } from "../../../src/core/model/rows.ts";
import { Home } from "../../scenarios/alarm/harness.ts";

function home(realControl: boolean): Home {
  return new Home({
    sensors: [
      { name: "front", arm: ArmState.Disarmed },
      { name: "back", arm: ArmState.Disarmed },
    ],
    sirens: [{ name: "hall" }, { name: "porch" }],
    realControl,
  });
}

/**
 * Armed with the front door open (refused, then with --continue), the back door's alarm and the
 * disarm that ends it, armed again, the back door's countdown cancelled by a disarm, and a disarm
 * of a disarmed house.
 */
function day(h: Home): unknown[] {
  const replies: unknown[] = [];
  const say = (command: ControlCommand) => replies.push(h.command(command, "bench"));
  h.advance(5_000);
  h.door("front", true);
  say({ kind: "arm", sensors: "all", continue: false });
  say({ kind: "arm", sensors: "all", continue: true });
  h.advance(2_000);
  h.door("front", false);
  h.advance(5_000);
  h.door("back", true);
  h.advance(40_000);
  say({ kind: "arm", sensors: "all", continue: false });
  say({ kind: "disarm", sensors: "all" });
  h.advance(5_000);
  h.door("back", false);
  say({ kind: "arm", sensors: "all", continue: false });
  h.advance(3_000);
  h.door("back", true);
  h.advance(10_000);
  say({ kind: "disarm", sensors: "all" });
  h.advance(10_000);
  say({ kind: "disarm", sensors: "all" });
  return replies;
}

/** Decisions without their numbers, which the real control's records move. */
function decisions(h: Home, without: readonly string[] = []) {
  return h
    .decisions()
    .filter((d) => !without.includes(d.kind))
    .map((d) => ({
      kind: d.kind,
      device: d.deviceId,
      value: d.value,
      detail: d.detail === null ? null : [...d.detail],
      durability: d.durability,
    }));
}

const sends = (h: Home) => h.sends().map((s) => [s.link, [...s.bytes]]);

describe("hsn arm --all and hsn disarm --all as switches (section 1)", () => {
  test("the same answers, decisions and packets as M1a's arm and disarm of every sensor", () => {
    const m1a = home(false);
    const m2 = home(true);
    const m1aReplies = day(m1a);
    const m2Replies = day(m2);
    expect(m2Replies).toEqual(m1aReplies);
    // The per-sensor decisions are M1a's; the summaries are M2's own: `mode_switched` for the
    // switch, `arming_changed` for the stand-in's M1a-style arm of every sensor (section 7).
    expect(decisions(m2, ["mode_switched"])).toEqual(decisions(m1a, ["arming_changed"]));
    expect(decisions(m2, []).some((d) => d.kind === "arming_changed")).toBe(false);
    expect(sends(m2)).toEqual(sends(m1a));
    // The answers are M1a's own: refused for the open door, then armed, waiting, disarmed.
    expect(m1aReplies[0]).toMatchObject({
      ok: false,
      error: { code: "doorsOpen", names: ["front"] },
    });
    expect(m1aReplies[1]).toEqual({
      ok: true,
      result: { kind: "arm", armed: ["back"], waitsForDoorToClose: ["front"] },
    });
    expect(m1aReplies[3]).toEqual({
      ok: true,
      result: {
        kind: "disarm",
        disarmed: ["front", "back"],
        countdownsCancelled: [],
        alarmEnded: true,
      },
    });
    expect(m1aReplies[4]).toEqual({
      ok: true,
      result: { kind: "arm", armed: ["front", "back"], waitsForDoorToClose: [] },
    });
    expect(m1aReplies[5]).toEqual({
      ok: true,
      result: {
        kind: "disarm",
        disarmed: ["front", "back"],
        countdownsCancelled: ["back"],
        alarmEnded: false,
      },
    });
  });

  test("each switch is one mode_switched, before its sensors' decisions, naming the mode and the actor", () => {
    const h = home(true);
    day(h);
    const kinds = h.decisions().map((d) => d.kind);
    const switched = h.decisions("mode_switched");
    // The refused arm made no switch; the four switches made and the last one, of a disarmed
    // house, are recorded.
    expect(switched.map((d) => d.value)).toEqual([
      AWAY_MODE,
      AWAY_MODE,
      DISARMED_MODE,
      AWAY_MODE,
      DISARMED_MODE,
      DISARMED_MODE,
    ]);
    expect(
      switched.every((d) => new TextDecoder().decode(d.detail ?? new Uint8Array()) === "bench"),
    ).toBe(true);
    const first = kinds.indexOf("mode_switched");
    // front, its door open, is armed and then waits for it (D50), as M1a's arm did.
    expect(kinds.slice(first, first + 4)).toEqual([
      "mode_switched",
      "armed",
      "waits_for_door_to_close",
      "armed",
    ]);
    expect(currentMode(h.world.state)).toEqual({ mode: DISARMED_MODE, modified: false });
  });

  test("an open door without --continue: refused, nothing armed, no switch, the mode as it was", () => {
    const h = home(true);
    h.door("front", true);
    expect(h.command({ kind: "arm", sensors: "all", continue: false })).toMatchObject({
      ok: false,
      error: { code: "doorsOpen", names: ["front"] },
    });
    expect(h.decisions("mode_switched")).toEqual([]);
    expect(armState(h.world.state, h.sensor("back"))).toBe(ArmState.Disarmed);
    expect(currentMode(h.world.state)).toEqual({ mode: DISARMED_MODE, modified: false });
  });

  test("the hub computer is never asked about a low battery, as M1a never asked", () => {
    const h = home(true);
    h.setBattery("front", 0);
    h.heartbeat("front", false);
    expect(h.command({ kind: "arm", sensors: "all", continue: false })).toEqual({
      ok: true,
      result: { kind: "arm", armed: ["front", "back"], waitsForDoorToClose: [] },
    });
    expect(currentMode(h.world.state)).toEqual({ mode: AWAY_MODE, modified: false });
  });

  test("hsn op mode.switch is answered as an operation: the sensors changed, or needsConfirmation", () => {
    const h = home(true);
    h.setBattery("front", 0);
    h.heartbeat("front", false);
    expect(
      h.command({ kind: "op", operation: { op: "mode.switch", body: { mode: AWAY_MODE } } }),
    ).toEqual({
      ok: false,
      error: {
        code: "opRefused",
        message: "needsConfirmation",
        app: {
          code: "needsConfirmation",
          detail: { openDoors: [], lowBattery: [h.sensor("front")] },
        },
      },
    });
    expect(
      h.command({
        kind: "op",
        operation: {
          op: "mode.switch",
          body: { mode: AWAY_MODE, confirm: { openDoors: false, lowBattery: true } },
        },
      }),
    ).toEqual({
      ok: true,
      result: {
        kind: "op",
        body: {
          armed: [h.sensor("front"), h.sensor("back")],
          disarmed: [],
          waiting: [],
          lowBattery: [h.sensor("front")],
          heldBack: [],
        },
      },
    });
  });

  test("hsn arm and hsn disarm of named sensors are as built: no switch", () => {
    const h = home(true);
    h.command({ kind: "arm", sensors: ["front"], continue: false });
    h.command({ kind: "disarm", sensors: ["front"] });
    expect(h.decisions("mode_switched")).toEqual([]);
    expect(currentMode(h.world.state)).toEqual({ mode: DISARMED_MODE, modified: true });
  });
});

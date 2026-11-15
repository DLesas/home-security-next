/**
 * A schedule's switch during an alarm (m2-design.md section 7, D117; section 11, "Step 1's
 * questions, settled"): a scheduled switch to Disarmed leaves the alarm's trigger armed, its
 * reply's `heldBack` names it, and the schedule records `schedule_held_back` naming it, caused by
 * the run's `schedule_ran`, in the run's own step. Every module is the real one, the entry runs on
 * the real calendar.
 */
import { describe, expect, test } from "bun:test";
import { DISARMED_MODE } from "../../../src/core/model/ids.ts";
import { ArmState } from "../../../src/core/model/rows.ts";
import { Home, SECOND } from "./harness.ts";

/** The entry runs at 08:05 UTC; the hub starts at 08:00. */
const AT = 8 * 60 + 5;

function u32s(bytes: Uint8Array | null): readonly number[] {
  if (bytes === null) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}

describe("a scheduled switch to Disarmed during an alarm (D117)", () => {
  test("holds back the trigger: its reply's heldBack names it, and schedule_held_back is recorded", () => {
    const h = new Home({
      sensors: [
        { name: "front", arm: ArmState.Armed },
        { name: "back", arm: ArmState.Armed },
      ],
      sirens: [{ name: "hall" }],
      layout: {},
      schedules: [{ id: 1, mode: DISARMED_MODE, enabled: true, at: AT }],
    });
    // The front door opens and its 30 s countdown runs out: the alarm sounds before 08:05.
    h.door("front", true);
    h.advance(31_000);
    expect(h.decisions("alarm")).toHaveLength(1);
    const front = h.sensor("front");
    const back = h.sensor("back");

    const before = h.world.effects.length;
    // The hub's mono 0 is 08:00 UTC: the entry is due 5 minutes in.
    h.advanceTo((AT - 8 * 60) * 60 * SECOND + SECOND);
    const answers = h
      .messagesOf("opAnswer")
      .map((s) => s.message)
      .filter((m) => m.answerTo.kind === "schedule");
    expect(answers).toHaveLength(1);
    const outcome = answers[0]?.outcome;
    const body = outcome?.ok === true ? outcome.body : undefined;
    expect(body).toMatchObject({ disarmed: [back], heldBack: [front] });

    const ran = h.decisions("schedule_ran");
    const held = h.decisions("schedule_held_back");
    expect(ran).toHaveLength(1);
    // value: the entry; device: the entry's own sensor, none for a mode; detail: the sensors held.
    expect(held.map((d) => [d.value, d.deviceId, u32s(d.detail), d.causeSeq])).toEqual([
      [1, null, [front], ran[0]?.seq ?? null],
    ]);
    expect(held[0]?.durability).toBe("now");
    expect(h.world.effects.length).toBeGreaterThan(before);
    // The trigger stays armed; the rest is disarmed.
    expect(h.world.state.alarm.sensors.get(front)?.arm).not.toBe(ArmState.Disarmed);
    expect(h.world.state.alarm.sensors.get(back)?.arm).toBe(ArmState.Disarmed);
  });
});

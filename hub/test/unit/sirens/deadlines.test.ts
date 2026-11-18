/**
 * No sirens deadline is left at or before a step's time (hub-design.md section 2, "Timers"), in
 * the World (the real `step` with `checkDeadlines`, so a deadline left behind fails the step that
 * left it, and the World keeps the fault):
 *
 * - A siren's path rules follow from its paths, so one rule can make the next due at once
 *   (section 8, "Silence"; D52, D73): Wi-Fi lost on a siren LoRa has not heard from for as long is
 *   silent in that same step; Wi-Fi back on a siren whose LoRa has been quiet past 630 s ‡ has LoRa
 *   lost in that same step. Each is decided once, at its exact moment, and again after its path
 *   came back and went again.
 * - A command's repeats (§8) in a step that ran late by more than an interval go on on their grid
 *   after now, instead of one at or before now.
 */
import { describe, expect, test } from "bun:test";
import { mono } from "../../../src/core/model/time.ts";
import { ArmState } from "../../../src/core/model/rows.ts";
import { Home, SECOND } from "../../scenarios/alarm/harness.ts";

const armedFront = [{ name: "front", arm: ArmState.Armed }] as const;

/** Nothing faulted, and no timer of any module at or before the World's time. */
function noneLeft(h: Home): void {
  expect(h.world.faults.map((f) => f.message)).toEqual([]);
  const now = h.world.now.mono;
  expect((h.world.core.deadlines?.(h.world.state) ?? []).filter((t) => t.at <= now)).toEqual([]);
}

/**
 * The index of each commit holding a decision of `kind`. A "now" item commits its step at once
 * (section 4), so two decisions in one commit were made in one step.
 */
function commitsOf(h: Home, kind: string): number[] {
  return h.world.writer.commits.flatMap((commit, i) =>
    commit.items.some(
      (item) =>
        item.kind === "record" && item.record.kind === "decision" && item.record.row.kind === kind,
    )
      ? [i]
      : [],
  );
}

/** Both paths of `hall` gone at 10 s; its last packets on each were at the start. */
function bothDown(): Home {
  const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
  h.advance(10_000);
  h.radioDown("hall");
  h.wifiDown("hall");
  return h;
}

describe("Wi-Fi lost with LoRa as long quiet (D52, D73)", () => {
  test("silent in the very step Wi-Fi is lost, at its exact moment, once, critical while armed", () => {
    const h = bothDown();
    const siren = h.sirenDevice("hall");
    const lostAt = h.world.state.sirens.timers.find((t) => t.key.kind === "wifiPathLost")?.at;
    expect(lostAt).toBe(mono(70 * SECOND));
    expect(h.world.advanceTo(mono(70 * SECOND - 1)).isOk()).toBe(true);
    expect(h.decisions("siren_wifi_lost")).toEqual([]);
    expect(h.decisions("siren_silent")).toEqual([]);
    noneLeft(h);
    expect(h.world.advanceTo(mono(70 * SECOND)).isOk()).toBe(true);
    expect(h.decisions("siren_wifi_lost").map((d) => [d.deviceId, d.durability])).toEqual([
      [siren, "now"],
    ]);
    expect(h.decisions("siren_silent").map((d) => [d.deviceId, d.value, d.durability])).toEqual([
      [siren, 1, "now"],
    ]);
    // The two in one step: silence follows the loss in the same commit.
    expect(commitsOf(h, "siren_silent")).toEqual(commitsOf(h, "siren_wifi_lost"));
    noneLeft(h);
    expect(h.world.advanceByMs(3_600_000).isOk()).toBe(true);
    expect(h.decisions("siren_silent")).toHaveLength(1);
    noneLeft(h);
  });

  test("twice in a row: Wi-Fi back, then gone again, is lost and silent again, once more", () => {
    const h = bothDown();
    expect(h.world.advanceTo(mono(100 * SECOND)).isOk()).toBe(true);
    h.wifiUp("hall");
    expect(h.world.advanceTo(mono(110 * SECOND)).isOk()).toBe(true);
    h.wifiDown("hall");
    expect(h.world.advanceTo(mono(400 * SECOND)).isOk()).toBe(true);
    expect(h.decisions("siren_wifi_lost")).toHaveLength(2);
    expect(h.decisions("siren_silent")).toHaveLength(2);
    expect(commitsOf(h, "siren_silent")).toEqual(commitsOf(h, "siren_wifi_lost"));
    noneLeft(h);
  });
});

describe("Wi-Fi back while LoRa has been quiet (D73)", () => {
  test("past 630 s ‡ since LoRa: LoRa lost in the step Wi-Fi comes back, once", () => {
    const h = bothDown();
    expect(h.world.advanceTo(mono(800 * SECOND)).isOk()).toBe(true);
    expect(h.decisions("siren_lora_lost")).toEqual([]);
    h.wifiUp("hall");
    expect(h.decisions("siren_lora_lost").map((d) => d.durability)).toEqual(["now"]);
    noneLeft(h);
    expect(h.world.advanceTo(mono(2_000 * SECOND)).isOk()).toBe(true);
    expect(h.decisions("siren_lora_lost")).toHaveLength(1);
    noneLeft(h);
  });

  test("before 630 s: LoRa lost by its timer, at 630 s after the last LoRa packet", () => {
    const h = bothDown();
    expect(h.world.advanceTo(mono(200 * SECOND)).isOk()).toBe(true);
    h.wifiUp("hall");
    expect(h.decisions("siren_lora_lost")).toEqual([]);
    noneLeft(h);
    const at = h.world.state.sirens.timers.find((t) => t.key.kind === "loraPathLost")?.at;
    expect(at).toBeDefined();
    expect(at ?? 0).toBeGreaterThan(h.world.now.mono);
    expect(h.world.advanceTo(mono((at ?? 0) - 1)).isOk()).toBe(true);
    expect(h.decisions("siren_lora_lost")).toEqual([]);
    expect(h.world.advanceTo(mono(at ?? 0)).isOk()).toBe(true);
    expect(h.decisions("siren_lora_lost")).toHaveLength(1);
    noneLeft(h);
  });
});

describe("a command's repeats in a step that ran late (§8)", () => {
  /** A command in flight to a siren that hears nothing: repeated every 2 s on Wi-Fi. */
  function commanded(): { h: Home; nextWifi: number } {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
    h.advance(5_000);
    h.scripted("hall").deaf = true;
    h.door("front", true);
    h.advance(30_500);
    const flight = h.world.state.sirens.sirens.get(h.sirenDevice("hall"))?.inFlight;
    expect(flight?.nextWifi).toBeDefined();
    return { h, nextWifi: flight?.nextWifi ?? 0 };
  }

  function lateTick(h: Home, at: number) {
    const result = h.world.core.step(
      h.world.state,
      {
        now: { mono: mono(at), wall: h.world.now.wall, wallTrusted: true },
        entropy: new Uint8Array(32),
        event: { kind: "tick" },
      },
      h.world.deps,
    );
    expect(result.isOk() ? "" : result.error.message).toBe("");
    return result;
  }

  test("late by 5 s: one repeat now, the next on its 2 s grid after now, none in the past", () => {
    const { h, nextWifi } = commanded();
    const result = lateTick(h, nextWifi + 5 * SECOND);
    if (result.isErr()) return;
    const flight = result.value.state.sirens.sirens.get(h.sirenDevice("hall"))?.inFlight;
    expect(flight?.nextWifi).toBe(mono(nextWifi + 6 * SECOND));
    const wifi = h.wifiLinks.get("hall");
    expect(result.value.effects.filter((e) => e.kind === "send" && e.link === wifi)).toHaveLength(
      1,
    );
  });

  test("late by exactly one interval: the next is two intervals on, not at now", () => {
    const { h, nextWifi } = commanded();
    const result = lateTick(h, nextWifi + 2 * SECOND);
    if (result.isErr()) return;
    const flight = result.value.state.sirens.sirens.get(h.sirenDevice("hall"))?.inFlight;
    expect(flight?.nextWifi).toBe(mono(nextWifi + 4 * SECOND));
  });

  test("on time: the next is one interval on, as always", () => {
    const { h, nextWifi } = commanded();
    const result = lateTick(h, nextWifi);
    if (result.isErr()) return;
    const flight = result.value.state.sirens.sirens.get(h.sirenDevice("hall"))?.inFlight;
    expect(flight?.nextWifi).toBe(mono(nextWifi + 2 * SECOND));
  });
});

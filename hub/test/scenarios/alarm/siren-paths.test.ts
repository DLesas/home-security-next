/**
 * A siren's paths in the World (hub-design.md section 7, "Siren reports and lost paths"; section
 * 8, "Silence" and "What the siren should do, and commands"; §7 "Siren command", D52, D73, D80,
 * SR4, SR5): on Wi-Fi only, on LoRa only, losing each path, a command never confirmed, and a siren
 * that restarts during an alarm.
 */
import { describe, expect, test } from "bun:test";
import { SirenAction, SirenState } from "@hsn/protocol";
import { ArmState } from "../../../src/core/model/rows.ts";
import { actedCommands, Home, SECOND } from "./harness.ts";

const armedFront = [{ name: "front", arm: ArmState.Armed }] as const;

describe("a siren on one path", () => {
  test("D73: on Wi-Fi only it is commanded and confirmed on Wi-Fi; its LoRa path is lost after 630 s", () => {
    const h = new Home({
      sensors: armedFront,
      sirens: [{ name: "hall", lora: false }, { name: "porch" }],
    });
    h.door("front", true);
    h.advance(31_000);
    expect(actedCommands(h, "hall").map((c) => [c.action, c.path])).toEqual([
      [SirenAction.SoundAlarm, "wifi"],
    ]);
    expect(h.decisions("siren_lora_lost").map((d) => d.deviceId)).toEqual([]);
    h.advanceTo(631 * SECOND);
    expect(h.decisions("siren_lora_lost").map((d) => d.deviceId)).toEqual([h.sirenDevice("hall")]);
    expect(h.decisions("siren_lora_lost")[0]?.durability).toBe("now");
    expect(h.decisions("siren_wifi_lost")).toEqual([]);
  });

  test("D52: on LoRa only it is commanded through the gateway, repeated every 5 s, and reports paced", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall", wifi: false }] });
    h.door("front", true);
    h.advance(31_000);
    expect(actedCommands(h, "hall").map((c) => [c.action, c.path])).toEqual([
      [SirenAction.SoundAlarm, "lora"],
    ]);
    // Wi-Fi was never seen: lost after 70 s ‡, a warning; LoRa carries on, so not silent.
    h.advanceTo(400 * SECOND);
    expect(h.decisions("siren_wifi_lost")).toHaveLength(1);
    expect(h.decisions("siren_silent")).toEqual([]);
  });
});

describe("losing a path (D73)", () => {
  test("Wi-Fi going down is lost at once on the LoRa report with reason 3, then commands go on LoRa only", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
    h.advance(10_000);
    h.wifiDown("hall");
    h.advance(1_000);
    const lost = h.decisions("siren_wifi_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.durability).toBe("now");
    h.door("front", true);
    h.advance(31_000);
    expect(actedCommands(h, "hall").map((c) => c.path)).toEqual(["lora"]);
    // A packet on the path clears it: back on Wi-Fi, the next loss is reported again.
    h.wifiUp("hall");
    h.advance(1_000);
    h.wifiDown("hall");
    h.advance(1_000);
    expect(h.decisions("siren_wifi_lost")).toHaveLength(2);
  });

  test("D52: losing both is silence, critical while a sensor is armed", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
    h.advance(10_000);
    h.radioDown("hall");
    h.wifiDown("hall");
    h.advance(100_000);
    const silent = h.decisions("siren_silent");
    expect(silent.map((d) => [d.deviceId, d.value, d.durability])).toEqual([
      [h.sirenDevice("hall"), 1, "now"],
    ]);
  });

  test("D52: on LoRa alone at DR5 a siren reporting at its pace every 30 s is never silent", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
    h.wifiDown("hall");
    h.advance(3_600_000);
    expect(h.decisions("siren_silent")).toEqual([]);
    expect(h.decisions("siren_lora_lost")).toEqual([]);
  });

  test("D52: on LoRa alone at DR2 its pace is 82.4 s and it is still never silent", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall", sendRate: 2 }] });
    h.wifiDown("hall");
    h.advance(3_600_000);
    const reports = h
      .scripted("hall")
      .reports.filter((r) => r.path === "lora" && r.fields.reason === 3);
    const gaps = reports.slice(1).map((r, i) => (r.at - (reports[i]?.at ?? 0)) / SECOND);
    expect(Math.min(...gaps.slice(1))).toBeGreaterThanOrEqual(82);
    expect(h.decisions("siren_silent")).toEqual([]);
  });
});

describe("a command never confirmed (SR4, §7 step 4)", () => {
  test("is repeated every 2 s on Wi-Fi and 5 s on LoRa for a minute, then siren_unreachable; the next report re-sends it", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
    h.advance(5_000);
    h.scripted("hall").deaf = true;
    h.door("front", true);
    h.advance(30_500);
    const command = h.decisions("siren_command").at(-1);
    expect(command?.value).toBe(SirenAction.SoundAlarm * 65_536 + 300);
    const device = h.sirenDevice("hall");
    const counter = h.sends((s) => s.counters.some((c) => c.device === device)).at(-1)
      ?.counters[0]?.counter;
    h.advance(59_000);
    const ofCommand = (link: number | undefined) =>
      h.sends((s) => s.link === link && s.counters[0]?.counter === counter);
    expect(ofCommand(h.wifiLinks.get("hall"))).toHaveLength(30);
    expect(ofCommand(h.radioLinks.get("hall"))).toHaveLength(12);
    expect(h.decisions("siren_unreachable")).toEqual([]);
    h.advance(1_000);
    expect(h.decisions("siren_unreachable").map((d) => d.durability)).toEqual(["now"]);
    // The siren hears again; its next report says off, and the correction rule sounds it.
    h.scripted("hall").deaf = false;
    h.advance(31_000);
    expect(actedCommands(h, "hall").map((c) => c.action)).toEqual([SirenAction.SoundAlarm]);
    expect(h.scripted("hall").output).toBe(SirenState.SoundingAlarm);
  });
});

describe("a siren that restarts during an alarm (D80, section 8, correcting a siren)", () => {
  test("after a power-on it reports off and is sounded again for what is left", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
    const t0 = h.now;
    h.door("front", true);
    h.advanceTo(t0 + 100 * SECOND);
    expect(h.scripted("hall").output).toBe(SirenState.SoundingAlarm);
    h.scripted("hall").restart("powerOn", h.now);
    h.advance(1_000);
    const commands = actedCommands(h, "hall");
    expect(commands.map((c) => c.action)).toEqual([SirenAction.SoundAlarm, SirenAction.SoundAlarm]);
    // What is left: until 330 s, from 100 s.
    expect(commands[1]?.seconds).toBe(230);
    expect(h.scripted("hall").output).toBe(SirenState.SoundingAlarm);
  });

  test("after a reset it keeps sounding, and is not commanded again", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
    h.door("front", true);
    h.advance(100_000);
    h.scripted("hall").restart("reset", h.now);
    h.advance(60_000);
    expect(actedCommands(h, "hall")).toHaveLength(1);
    expect(h.scripted("hall").output).toBe(SirenState.SoundingAlarm);
  });

  test("with less than 10 s ‡ left it is not sounded again", () => {
    const h = new Home({ sensors: armedFront, sirens: [{ name: "hall" }] });
    const t0 = h.now;
    h.door("front", true);
    h.advanceTo(t0 + 321 * SECOND);
    h.scripted("hall").restart("powerOn", h.now);
    h.advance(1_000);
    expect(actedCommands(h, "hall")).toHaveLength(1);
  });
});

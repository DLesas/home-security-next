/**
 * The armed door through to the sirens and a disarm (hub-design.md section 7, "Door opens while
 * armed" and "Countdown ends: alarm and siren command"; AL3, AL4, HB11, D24, D95, D114), in the
 * World with a scripted siren on both paths.
 */
import { describe, expect, test } from "bun:test";
import { MessageType, SirenAction, SirenState } from "@hsn/protocol";
import { ArmState } from "../../../src/core/model/rows.ts";
import { commandOf, Home, openCommand, SECOND } from "./harness.ts";

function home(): Home {
  return new Home({
    sensors: [
      { name: "front", arm: ArmState.Armed },
      { name: "back", arm: ArmState.Armed },
    ],
    sirens: [{ name: "hall" }, { name: "porch" }],
  });
}

/** The commands a siren acted on, as action and seconds. */
function acted(h: Home, siren: string) {
  return h
    .scripted(siren)
    .acted.flatMap((a) =>
      a.message.type === MessageType.SirenCommand && a.message.action !== SirenAction.ReportNow
        ? [{ action: a.message.action, seconds: a.message.soundSeconds }]
        : [],
    );
}

describe("an armed door through to the sirens (AL3, HB11)", () => {
  test("AL3 AL4: the countdown runs from the opening; at its end every siren sounds once, confirmed", () => {
    const h = home();
    h.advance(5_000);
    const t0 = h.now;
    h.door("front", true);
    expect(h.decisions("countdown_started").map((d) => [d.value, d.durability])).toEqual([
      [30, "now"],
    ]);
    // The countdown row was committed in the very turn of the report (section 5).
    const commit = h.world.writer.commits.at(-1);
    expect(commit?.items.some((i) => i.kind === "write" && i.op.table === "countdowns")).toBe(true);
    h.advanceTo(t0 + 29.9 * SECOND);
    expect(h.decisions("alarm")).toEqual([]);
    h.advanceTo(t0 + 31 * SECOND);
    expect(h.decisions("alarm")).toHaveLength(1);
    for (const siren of ["hall", "porch"]) {
      expect(acted(h, siren)).toEqual([{ action: SirenAction.SoundAlarm, seconds: 300 }]);
      expect(h.scripted(siren).output).toBe(SirenState.SoundingAlarm);
    }
    // Each siren confirmed "report now" after the start, then the alarm's command.
    expect(h.decisions("siren_confirmed")).toHaveLength(4);
  });

  test("the alarm and its sirens are committed before any command leaves (section 5)", () => {
    const h = home();
    h.door("front", true);
    h.advance(31_000);
    const commits = h.world.writer.commits;
    const alarmCommit = commits.findIndex((c) =>
      c.items.some((i) => i.kind === "write" && i.op.table === "alarm_sirens"),
    );
    expect(alarmCommit).toBeGreaterThanOrEqual(0);
    const firstCommand = h
      .scripted("hall")
      .acted.find(
        (a) =>
          a.message.type === MessageType.SirenCommand &&
          a.message.action === SirenAction.SoundAlarm,
      )?.at;
    expect(firstCommand).toBeDefined();
    expect(commits[alarmCommit]?.at).toBeLessThanOrEqual(firstCommand ?? 0);
  });

  test("the same command goes on Wi-Fi and through the gateway, the same bytes (D73, §7 step 1)", () => {
    const h = home();
    h.door("front", true);
    h.advance(30_500);
    const hall = h.sirenDevice("hall");
    const toHall = h.sends(
      (s) =>
        s.counters.some((c) => c.device === hall) &&
        commandOf(h, "hall", s.bytes)?.action === SirenAction.SoundAlarm,
    );
    const wifi = h.wifiLinks.get("hall");
    const radio = h.radioLinks.get("hall");
    const onWifi = toHall.filter((s) => s.link === wifi);
    const onRadio = toHall.filter((s) => s.link === radio);
    expect(onWifi.length).toBeGreaterThan(0);
    expect(onRadio.length).toBeGreaterThan(0);
    expect(onRadio[0]?.bytes).toEqual(onWifi[0]?.bytes);
    expect(openCommand(h, "hall", onWifi[0]?.bytes ?? new Uint8Array())).toMatchObject({
      type: MessageType.SirenCommand,
      action: SirenAction.SoundAlarm,
    });
  });

  test("D95: a disarm of every trigger ends the alarm and commands the sirens off", () => {
    const h = home();
    h.door("front", true);
    h.advance(40_000);
    expect(h.command({ kind: "disarm", sensors: "all" })).toMatchObject({
      ok: true,
      result: { kind: "disarm", alarmEnded: true },
    });
    h.advance(1_000);
    for (const siren of ["hall", "porch"]) {
      expect(acted(h, siren).at(-1)).toEqual({ action: SirenAction.Off, seconds: 0 });
      expect(h.scripted(siren).output).toBe(SirenState.Off);
    }
    expect(h.decisions("alarm_ended").map((d) => d.value)).toEqual([1]);
  });

  test("AL6 AL9 D67: the alarm ends by itself with the sirens' time; the open door then waits", () => {
    const h = home();
    h.door("front", true);
    h.door("back", true);
    h.door("back", false);
    h.advance(31_000);
    h.advance(300_000);
    expect(h.decisions("alarm_ended").map((d) => d.value)).toEqual([0]);
    expect(h.scripted("hall").output).toBe(SirenState.Off);
    // Time running out is not a change: no command was sent for it (section 8).
    expect(acted(h, "hall")).toEqual([{ action: SirenAction.SoundAlarm, seconds: 300 }]);
    const changed = h.messagesOf("armedChanged").map((m) => [m.message.sensor, m.message.arm]);
    expect(changed).toEqual([[h.sensor("front"), ArmState.WaitsForCloseAfterAlarm]]);
    // An alarm that ended by itself is followed by a new one commanded afresh.
    h.door("front", false);
    h.door("back", true);
    h.advance(31_000);
    expect(acted(h, "hall")).toEqual([
      { action: SirenAction.SoundAlarm, seconds: 300 },
      { action: SirenAction.SoundAlarm, seconds: 300 },
    ]);
  });
});

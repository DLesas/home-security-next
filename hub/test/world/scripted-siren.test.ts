/**
 * The scripted siren against protocol.md §4, §6 and §7 and the firmware's siren role: the
 * command counter rule, sounding capped and stopping by itself, reports with their reasons on
 * each path, the LoRa pace, a restart after a power-on and after a reset, and settings.
 */
import { describe, expect, test } from "bun:test";
import {
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  openPacket,
  sealPacket,
  SirenAction,
  SirenReportReason,
  SirenState,
} from "@hsn/protocol";
import { mono } from "../../src/core/model/time.ts";
import { ScriptedSiren } from "./scripted-siren.ts";
import { vectorsOf } from "./vectors.ts";

const SECOND = 1_000_000;
const vector = vectorsOf("siren-command.json")[0];
const KEY = vector?.key ?? new Uint8Array(16);
const ADDRESS = vector?.address ?? 1;

function command(counter: number, message: Message): Uint8Array {
  return sealPacket(message, {
    key: KEY,
    direction: Direction.FromHub,
    address: ADDRESS,
    counter,
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Radio,
  });
}

const sound = (seconds: number): Message => ({
  type: MessageType.SirenCommand,
  action: SirenAction.SoundAlarm,
  soundSeconds: seconds,
});

function opened(bytes: Uint8Array) {
  const result = openPacket(bytes, {
    key: KEY,
    expectedDirection: Direction.ToHub,
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Link,
  });
  return result.ok ? result.value : undefined;
}

function siren(wifiUp = true): ScriptedSiren {
  return new ScriptedSiren({ key: KEY, address: ADDRESS, wifiUp, phase: 1 });
}

describe("the scripted siren", () => {
  test("§4: its first packet after pairing carries the resume point 1,024, then Started and a report on Wi-Fi", () => {
    const s = siren();
    const out = s.wifi.wake(mono(0)).map((b) => opened(b));
    expect(out.map((p) => [p?.header.counter, p?.message.type])).toEqual([
      [1024, MessageType.Started],
      [1025, MessageType.SirenReport],
    ]);
  });

  test("§7: a new command is acted on and answered on its path; an exact repeat answered again; older ignored", () => {
    const s = siren();
    s.wifi.wake(mono(0));
    const answer = s.wifi.receive(command(10, sound(60)), mono(SECOND));
    expect(opened(answer[0] ?? new Uint8Array())?.message).toMatchObject({
      state: SirenState.SoundingAlarm,
      soundingSecondsLeft: 60,
      lastCommandCounterLow: 10,
      reason: SirenReportReason.CommandAnswer,
    });
    expect(s.wifi.receive(command(10, sound(60)), mono(2 * SECOND))).toHaveLength(1);
    expect(s.lora.receive(command(9, sound(60)), mono(3 * SECOND))).toEqual([]);
    expect(s.acted).toHaveLength(1);
    // The LoRa copy of a command acted on by Wi-Fi is answered on LoRa (§7 step 3).
    expect(s.lora.receive(command(10, sound(60)), mono(4 * SECOND))).toHaveLength(1);
  });

  test("SR5: sounds for the command capped by its longest sound, then stops by itself and reports it", () => {
    const s = new ScriptedSiren({
      key: KEY,
      address: ADDRESS,
      settings: { maxSoundS: 100 },
      phase: 1,
    });
    s.wifi.wake(mono(0));
    s.wifi.receive(command(10, sound(300)), mono(0));
    expect(s.secondsLeft(mono(0))).toBe(100);
    expect(s.wifi.nextWake()).toBe(mono(30 * SECOND));
    s.wifi.wake(mono(100 * SECOND));
    expect(s.output).toBe(SirenState.Off);
    expect(s.reports.at(-1)?.fields.state).toBe(SirenState.Off);
  });

  test("§7: reports every 30 s on Wi-Fi; Wi-Fi down is reported on LoRa at once with reason 3, then paced", () => {
    const s = siren();
    s.wifi.wake(mono(0));
    s.wifi.wake(mono(30 * SECOND));
    expect(s.reports.at(-1)).toMatchObject({
      path: "wifi",
      fields: { reason: SirenReportReason.Regular },
    });
    s.setWifi(false, mono(31 * SECOND));
    const change = s.lora.wake(mono(31 * SECOND));
    expect(change.map((b) => opened(b)?.message)).toMatchObject([
      { reason: SirenReportReason.WifiReportFailed, flags: { wifiConnected: false } },
    ]);
    s.lora.wake(mono(60 * SECOND));
    expect(s.reports.filter((r) => r.path === "lora")).toHaveLength(2);
  });

  test("§7: at DR0 its regular LoRa reports keep 200 × a report's airtime apart (329.4 s)", () => {
    const s = new ScriptedSiren({
      key: KEY,
      address: ADDRESS,
      wifiUp: false,
      settings: { sendRate: 0 },
      phase: 1,
    });
    for (let t = 0; t <= 2_000; t += 1) {
      const at = mono(t * SECOND);
      if ((s.lora.nextWake() ?? Infinity) <= at) s.lora.wake(at);
    }
    const times = s.reports.map((r) => r.at / SECOND);
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(329);
  });

  test("D80: a power-on restart is silent; a reset sounds on; both send Started with their cause", () => {
    const s = siren();
    s.wifi.wake(mono(0));
    s.wifi.receive(command(10, sound(300)), mono(0));
    s.restart("reset", mono(10 * SECOND));
    expect(s.output).toBe(SirenState.SoundingAlarm);
    const started = s.wifi.wake(mono(10 * SECOND)).map((b) => opened(b));
    expect(started[0]?.message).toMatchObject({ type: MessageType.Started, resetCause: 3 });
    // Counters continue from the saved resume point: skipped, never repeated (§4).
    expect(started[0]?.header.counter).toBe(2048);
    s.restart("powerOn", mono(20 * SECOND));
    expect(s.output).toBe(SirenState.Off);
    s.wifi.wake(mono(20 * SECOND));
    // Its last command counter is kept in flash: the same command again is a repeat, answered
    // and not acted on.
    expect(s.wifi.receive(command(10, sound(300)), mono(21 * SECOND))).toHaveLength(1);
    expect(s.output).toBe(SirenState.Off);
  });

  test("§6: settings: a longest sound of 0 is ignored; the site channel of D115 is taken", () => {
    const s = siren();
    s.wifi.wake(mono(0));
    s.wifi.receive(
      command(11, {
        type: MessageType.SirenSettings,
        settingsVersion: 4,
        wifiReportIntervalSeconds: 60,
        loraCheckIntervalUnits: 20,
        maxSoundSeconds: 0,
        sendDataRate: 2,
        commandDataRate: 9,
        siteChannel: 2,
      }),
      mono(SECOND),
    );
    expect(s.held).toMatchObject({
      version: 4,
      wifiIntervalS: 60,
      maxSoundS: 300,
      sendRate: 2,
      commandRate: 5,
      siteChannel: 2,
    });
  });
});

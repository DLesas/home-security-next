/**
 * The sensors module's rules beyond when to reply (hub-design.md section 8; protocol.md §6, §7;
 * D24, D107, D108, D114), through the real `step` with the stand-ins: the rate a reply goes at
 * (the version named, flag bit 7, a version not kept, a log entries packet), the disarmed notice
 * twice with the same bytes, flag bits 5 and 7, missed door changes and an unexpected door state
 * without ever touching arming, each silence threshold, D107's n over a week of losses, the
 * outcome of each packet sent, and `hsn sensor set`.
 */
import { describe, expect, test } from "bun:test";
import { type Message, MessageType, toHex, TransmitResultCode } from "@hsn/protocol";
import { deviceId } from "../../../src/core/model/ids.ts";
import { ArmState, type SensorConfigRow } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { encodeHistory } from "../../../src/core/sensors/settings.ts";
import { dayOf } from "../../../src/core/sensors/silence.ts";
import {
  Bench,
  benchSensors,
  flags,
  heartbeat,
  type RecordingGateway,
  SECOND,
  sensorRow,
  sensorSnapshot,
} from "../../scenarios/sensors/bench.ts";

const MIN = 60 * SECOND;

function bench(
  over: Partial<SensorConfigRow> = {},
  rate = 2,
  extra: Parameters<typeof sensorSnapshot>[2] = {},
) {
  const sensors = benchSensors(1);
  const device = sensors[0]?.device ?? deviceId(0);
  const b = new Bench(sensors);
  b.boot(sensorSnapshot(sensors, rate, { configs: [sensorRow(device, rate, over)], ...extra }));
  return { b, device };
}

const door = (
  open: boolean,
  count: number,
  over: Partial<Extract<Message, { type: 2 }>> = {},
): Message => ({
  type: MessageType.DoorChanged,
  settingsVersion: 1,
  flags: flags({ doorOpen: open, replyWanted: true }),
  // 120 reads as a healthy cell, as the heartbeats' does, so health has no change to record.
  batteryCode: 120,
  temperatureCelsius: 1,
  doorChangeCount: count,
  eventAgeSeconds: 0,
  ...over,
});

describe("the rate a reply goes at (section 8)", () => {
  // Version 4 kept with reply rate DR5, version 3 with DR4, on a DR2 site.
  const history = encodeHistory([
    { version: 4, replyRate: 5, move: 0 },
    { version: 3, replyRate: 4, move: 0 },
  ]);
  const over = { version: 4, replyRate: 5, versionHistory: history };

  test("the reply rate of the version the packet names, from the last 16 kept", () => {
    const { b } = bench(over);
    b.hear(b.seal(0, heartbeat({ settingsVersion: 3 }), 100), mono(10 * SECOND), 2);
    b.hear(
      b.seal(0, heartbeat({ settingsVersion: 4, flags: flags({ replyWanted: true }) }), 101),
      mono(200 * SECOND),
      2,
    );
    expect(b.stand.radioOuts.map((o) => o.dataRate)).toEqual([4, 5]);
  });

  test("a version not kept: the arrival rate; flag bit 7: the arrival rate", () => {
    const { b } = bench(over);
    b.hear(b.seal(0, heartbeat({ settingsVersion: 99 }), 100), mono(10 * SECOND), 2);
    b.hear(
      b.seal(
        0,
        heartbeat({
          settingsVersion: 4,
          flags: flags({ replyWanted: true, listeningAtSendRate: true }),
        }),
        101,
      ),
      mono(200 * SECOND),
      2,
    );
    expect(b.stand.radioOuts.map((o) => o.dataRate)).toEqual([2, 2]);
  });

  test("a log entries packet: as the sensor's most recent status packet says", () => {
    const { b } = bench(over);
    b.hear(b.seal(0, heartbeat({ settingsVersion: 3 }), 100), mono(10 * SECOND), 2);
    const log: Message = {
      type: MessageType.LogEntries,
      entries: [{ ageTenths: 0, level: 2, code: 1, text: "x" }],
    };
    b.hear(b.seal(0, log, 101), mono(12 * SECOND), 2);
    b.hear(
      b.seal(
        0,
        heartbeat({
          settingsVersion: 4,
          flags: flags({ listeningAtSendRate: true, replyWanted: true }),
        }),
        102,
      ),
      mono(200 * SECOND),
      2,
    );
    b.hear(b.seal(0, log, 103), mono(202 * SECOND), 2);
    expect(b.stand.radioOuts.map((o) => [o.purpose, o.dataRate])).toEqual([
      ["heartbeatReply", 4],
      ["eventReply", 4],
      ["heartbeatReply", 2],
      ["eventReply", 2],
    ]);
  });

  test("flag bit 7 steps the reply rate one slower at once ‡ and bumps the version", () => {
    const { b, device } = bench(over);
    b.hear(
      b.seal(
        0,
        heartbeat({
          settingsVersion: 4,
          flags: flags({ replyWanted: true, listeningAtSendRate: true }),
        }),
        100,
      ),
      mono(10 * SECOND),
      2,
    );
    expect(b.world.state.sensors.sensors.get(device)?.config).toMatchObject({
      replyRate: 4,
      version: 5,
    });
    const opened = b.openReply(0, b.stand.radioOuts[0]?.packet ?? new Uint8Array(), 100);
    expect(opened).toMatchObject({ settingsVersion: 5, replyDataRate: 4 });
  });

  test("a fixed reply rate is not changed by bit 7", () => {
    const { b, device } = bench({ ...over, replyRateFixed: true });
    b.hear(
      b.seal(
        0,
        heartbeat({
          settingsVersion: 4,
          flags: flags({ replyWanted: true, listeningAtSendRate: true }),
        }),
        100,
      ),
      mono(10 * SECOND),
      2,
    );
    expect(b.world.state.sensors.sensors.get(device)?.config).toMatchObject({
      replyRate: 5,
      version: 4,
    });
  });
});

describe("the disarmed notice (D24)", () => {
  test("goes twice, 2 s apart, the same bytes, bound to the countdown's newest report, through its gateway", () => {
    const { b, device } = bench({ arm: ArmState.Armed }, 5);
    b.stand.armed.add(device);
    b.hear(b.seal(0, door(true, 1), 100), mono(10 * SECOND), 5);
    b.hear(b.seal(0, door(true, 1, { eventAgeSeconds: 3 }), 101), mono(13 * SECOND), 5);
    b.command({ kind: "disarm", sensors: "all" });
    expect(b.world.advanceTo(mono(20 * SECOND)).isOk()).toBe(true);
    const notices = b.stand.radioOuts.filter((o) => o.purpose === "disarmedNotice");
    expect(notices).toHaveLength(2);
    expect(toHex(notices[0]?.packet ?? new Uint8Array())).toBe(
      toHex(notices[1]?.packet ?? new Uint8Array()),
    );
    expect(notices[0]?.counter).toBe(notices[1]?.counter);
    expect(notices.map((n) => n.timing)).toEqual([
      { kind: "asap", latest: undefined },
      { kind: "asap", latest: undefined },
    ]);
    const requests = (b.gateway as RecordingGateway).requests.filter(
      (r) => r.request.packet.length === 18,
    );
    expect(requests.map((r) => r.at - (requests[0]?.at ?? 0))).toEqual([0, 2 * SECOND]);
    expect(b.openReply(0, notices[0]?.packet ?? new Uint8Array(), 101)).toEqual({
      type: MessageType.DisarmedNotice,
    });
    expect(b.decisions("disarmed_notice").map((d) => d.value)).toEqual([101]);
    // The disarm bumped the version: "not armed" reaches the sensor at its next heartbeat.
    expect(b.world.state.sensors.sensors.get(device)?.config).toMatchObject({
      arm: ArmState.Disarmed,
      version: 2,
    });
  });
});

describe("a heartbeat never changes arming (D114); the door warnings are the alarm module's", () => {
  test("bit 5, a change count ahead and an unexpected door state: sensors records none of them, and changes no arming", () => {
    const { b, device } = bench({ arm: ArmState.Armed });
    b.stand.armed.add(device);
    b.hear(b.seal(0, door(false, 2), 100), mono(10 * SECOND), 2);
    const before = b.world.effects.length;
    const messages = b.stand.messages.length;
    const odd = heartbeat({
      doorChangeCount: 9,
      flags: flags({ doorOpen: true, localAlarmSounded: true }),
    });
    b.hear(b.seal(0, odd, 101), mono(200 * SECOND), 2);
    for (const kind of [
      "door_state_unexpected",
      "door_changes_missed",
      "local_alarm_reported",
    ] as const) {
      expect(b.decisions(kind)).toEqual([]);
    }
    expect(b.stand.messages.slice(messages).map((m) => m.kind)).not.toContain("armedChanged");
    expect(b.world.state.alarm.countdowns.size).toBe(0);
    const effects = b.world.effects.slice(before);
    expect(effects.some((e) => e.kind === "write" && e.op.table === "sensor_config")).toBe(false);
    expect(
      effects.some((e) => (e.kind === "write" || e.kind === "record") && e.durability === "now"),
    ).toBe(false);
  });

  test("armedChanged bumps the version and writes the row now, with when it was armed", () => {
    const { b, device } = bench();
    b.command({ kind: "arm", sensors: "all", continue: true });
    expect(b.world.state.sensors.sensors.get(device)?.config).toMatchObject({
      arm: ArmState.Armed,
      version: 2,
    });
    expect(
      b
        .effects("write")
        .filter((e) => e.op.table === "sensor_config")
        .at(-1)?.durability,
    ).toBe("now");
  });
});

describe("silence (D107, HB25)", () => {
  test("silent after n × I + 30 s ‡ from the last packet, n = 5 ‡ before a day of data; critical decisions are written now", () => {
    const { b, device } = bench({}, 5);
    b.hear(b.seal(0, heartbeat(), 100), mono(10 * SECOND), 5);
    const heard = 10 * SECOND + 30_000;
    const at = heard + 5 * 3 * MIN + 30 * SECOND;
    expect(b.world.advanceTo(mono(at - 1)).isOk()).toBe(true);
    expect(b.decisions("sensor_silent")).toEqual([]);
    expect(b.world.advanceTo(mono(at)).isOk()).toBe(true);
    expect(b.decisions("sensor_silent").map((d) => [d.deviceId, d.value])).toEqual([[device, 5]]);
    // Once silent, no more until heard again.
    expect(b.world.advanceTo(mono(3 * at)).isOk()).toBe(true);
    expect(b.decisions("sensor_silent")).toHaveLength(1);
  });

  test("counted from the hub's start when nothing was heard since, at the interval its packets come at", () => {
    const { b } = bench({ heartbeatUnits: 4 }, 1);
    // At DR1 the interval is at least 3 minutes (§7), not 4 × 15 s.
    expect(b.world.state.sensors.timers.find((t) => t.key.kind === "silence")?.at).toBe(
      mono(5 * 3 * MIN + 30 * SECOND),
    );
  });

  test("D107's n over a week of losses: the counter's advance is expected, a Started's jump is not", () => {
    const wall = Date.UTC(2026, 10, 13);
    const today = dayOf(wall);
    // Six days of 1 % loss and one of 0.2 %: home B's 30 sensors would give n = 4.
    const lossDaily = [1, 2, 3, 4, 5, 6, 7].map((back) => ({
      deviceId: deviceId(3),
      day: today - back,
      received: back === 7 ? 998 : 990,
      expected: 1000,
    }));
    const sensors = benchSensors(30);
    const b = new Bench(sensors);
    b.boot(sensorSnapshot(sensors, 5, { extra: { lossDaily } }));
    expect(b.world.state.sensors.sensors.get(deviceId(3))?.missed).toBe(4);
    expect(b.world.state.sensors.sensors.get(deviceId(4))?.missed).toBe(5);
    // Today: counters 100, 103 (2 lost), a Started at 1,024 (not counted as 921 lost), then 1,025.
    const started: Message = {
      type: MessageType.Started,
      role: 1,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 1,
      lastFatalError: 0,
      settingsVersion: 1,
    };
    b.hear(b.seal(0, heartbeat(), 100), mono(10 * SECOND), 5);
    b.hear(b.seal(0, heartbeat(), 103), mono(200 * SECOND), 5);
    b.hear(b.seal(0, started, 1024), mono(400 * SECOND), 5);
    b.hear(b.seal(0, heartbeat(), 1025), mono(600 * SECOND), 5);
    expect(b.world.state.sensors.sensors.get(deviceId(3))?.loss.get(today)).toEqual({
      received: 4,
      expected: 6,
    });
    const rows = b.effects("write").filter((e) => e.op.table === "loss_daily");
    expect(rows.at(-1)).toMatchObject({
      durability: "routine",
      op: { row: { day: today, received: 4, expected: 6 } },
    });
  });

  test("the daily choice: n again from the last 7 days, and poor_link above 20 %", () => {
    const today = dayOf(Date.UTC(2026, 10, 13));
    const lossDaily = [1, 2].map((back) => ({
      deviceId: deviceId(3),
      day: today - back,
      received: 700,
      expected: 1000,
    }));
    const { b, device } = bench({}, 5, { extra: { lossDaily } });
    expect(b.world.advanceTo(mono(24 * 60 * MIN)).isOk()).toBe(true);
    expect(b.decisions("poor_link").map((d) => [d.deviceId, d.value])).toEqual([[device, 300]]);
    expect(b.world.state.sensors.sensors.get(device)?.missed).toBe(8);
  });
});

describe("outcomes and settings", () => {
  test("each packet's outcome is its tx row; a sent reply with a next heartbeat gives the slot; a busy one is recorded", () => {
    const { b, device } = bench({}, 5);
    b.hear(
      b.seal(0, heartbeat({ flags: flags({ replyWanted: true }) }), 100),
      mono(10 * SECOND),
      5,
    );
    const gw = b.gateway as RecordingGateway;
    const first = gw.requests[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    b.deliver(gw.result(first, TransmitResultCode.RadioBusy));
    // The busy radio is the outcome on the reply's tx row, not a decision; nor is the reply.
    expect(b.decisions("reply_skipped")).toEqual([]);
    expect(b.decisions("reply")).toEqual([]);
    expect(b.world.state.sensors.sensors.get(device)?.slotFrom).toBeUndefined();
    b.hear(
      b.seal(0, heartbeat({ flags: flags({ replyWanted: true }) }), 101),
      mono(200 * SECOND),
      5,
    );
    const second = gw.requests[1];
    if (second === undefined) return;
    b.deliver(gw.result(second, TransmitResultCode.Sent, 1234));
    expect(b.world.state.sensors.sensors.get(device)?.slotFrom).toBe(101);
    const tx = b
      .records()
      .flatMap((r) =>
        r.kind === "tx" ? [[r.table, r.row.outcome, r.row.gwSentUs, r.row.type]] : [],
      );
    expect(tx).toEqual([
      ["routine", TransmitResultCode.RadioBusy, 0, MessageType.Reply],
      ["routine", TransmitResultCode.Sent, 1234, MessageType.Reply],
    ]);
  });

  test("hsn sensor set: each change bumps the version, written now, and is answered with it", () => {
    const { b, device } = bench({}, 5);
    b.command({ kind: "sensorSet", name: "sensor-1", countdown: 45, correction: 12 });
    expect(b.world.replies.at(-1)?.reply).toEqual({
      ok: true,
      result: { kind: "sensorSet", name: "sensor-1", version: 2 },
    });
    expect(b.world.state.sensors.sensors.get(device)?.config).toMatchObject({
      countdownS: 45,
      correctionUnits: 12,
      correctionFixed: true,
    });
    b.command({ kind: "sensorSet", name: "sensor-1", correction: "learn" });
    expect(b.world.replies.at(-1)?.reply).toEqual({
      ok: true,
      result: { kind: "sensorSet", name: "sensor-1", version: 2 },
    });
    expect(b.world.state.sensors.sensors.get(device)?.config.correctionFixed).toBe(false);
  });
});

/**
 * The restart rule at its boundaries (hub-design.md section 5, "What the hub does on a start
 * where it cannot know how long it was down"; section 7, "Hub restart"; D80, D113, HB30): what a
 * saved countdown and alarm become at boot, what is written again, and the judgement once the
 * downtime is known.
 */
import { describe, expect, test } from "bun:test";
import { bootId, deviceId, HUB_DEVICE, seq } from "../../../src/core/model/ids.ts";
import { AlarmTriggerKind, ArmState, DeviceState } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import { sensorConfig } from "../../scenarios/alarm/harness.ts";
import { decisionsIn, Direct, report, SECOND, SIREN, sirenSnapshot } from "../sirens/direct.ts";

const FRONT = deviceId(100);

/** A snapshot of boot 1 whose last commit was at 50 s, with a countdown and maybe an alarm. */
function saved(
  options: { mark?: boolean; alarm?: boolean; commanded?: boolean } = {},
): DurableSnapshot {
  const base = sirenSnapshot();
  return {
    ...base,
    devices: [
      ...base.devices,
      {
        ...(base.devices[0] ?? ({} as never)),
        id: FRONT,
        address: 0x5e000001,
        role: 1,
        name: "front",
        state: DeviceState.Contacted,
      },
    ],
    sensorConfig: [sensorConfig(FRONT, ArmState.Armed, 30)],
    countdowns:
      options.alarm === true
        ? []
        : [
            {
              sensorId: FRONT,
              boot: bootId(1),
              openedMono: mono(40 * SECOND),
              deadlineMono: mono(70 * SECOND),
              newestCounter: 66,
              replyGatewayId: null,
              replyRate: 5,
              causeSeq: seq(9),
            },
          ],
    alarm:
      options.alarm === true
        ? { boot: bootId(1), startedMono: mono(10 * SECOND), causeSeq: seq(8) }
        : undefined,
    alarmTriggers:
      options.alarm === true
        ? [
            {
              sensorId: FRONT,
              kind: AlarmTriggerKind.CountdownEnd,
              boot: bootId(1),
              atMono: mono(10 * SECOND),
            },
          ]
        : [],
    alarmSirens:
      options.alarm === true
        ? [
            {
              sirenId: SIREN,
              boot: bootId(1),
              untilMono: mono(310 * SECOND),
              commanded: options.commanded ?? true,
            },
          ]
        : [],
    deviceState:
      options.mark === false
        ? []
        : [
            {
              deviceId: HUB_DEVICE,
              boot: bootId(1),
              lastSeenMono: mono(50 * SECOND),
              lastSeenMs: 0,
              clockOk: true,
              window: null,
              reading: null,
              rssi: null,
              snrQ: null,
              bestGatewayId: null,
              uptimeS: null,
              estimates: null,
            },
          ],
  };
}

describe("a saved countdown at boot (D80, D113, HB30)", () => {
  test("D113: resumes with the time it had left at the last commit, counted from the start", () => {
    const d = new Direct();
    const out = d.boot(saved(), 2);
    expect(d.state.alarm.countdowns.get(FRONT)?.deadline).toBe(mono(20 * SECOND));
    // Written again now with this boot's id, and the writer told to commit every second.
    const written = out.flatMap((o) =>
      o.kind === "write" && o.op.op === "upsert" && o.op.table === "countdowns"
        ? [[o.durability, o.op.row.boot, o.op.row.deadlineMono]]
        : [],
    );
    expect(written).toEqual([["now", bootId(2), mono(20 * SECOND)]]);
    expect(out).toContainEqual({ kind: "cadence", everyMs: 1_000 });
  });

  test("with no commit mark of its run, the whole countdown again: never early", () => {
    const d = new Direct();
    d.boot(saved({ mark: false }), 2);
    expect(d.state.alarm.countdowns.get(FRONT)?.deadline).toBe(mono(30 * SECOND));
  });

  test("D80: the downtime known moves it back; one that has passed is judged by D106", () => {
    const short = new Direct();
    short.boot(saved(), 2);
    short.send({ kind: "downtimeKnown", downtimeMs: 15_000, source: "wallClock" });
    expect(short.state.alarm.countdowns.get(FRONT)?.deadline).toBe(mono(5 * SECOND));
    const long = new Direct();
    long.boot(saved(), 2);
    const out = long.send({ kind: "downtimeKnown", downtimeMs: 25_000, source: "gatewayUptime" });
    expect(decisionsIn(out, "late_report_sirens").map((r) => r.value)).toEqual([295]);
    // Judged once: a second downtime changes nothing.
    expect(long.send({ kind: "downtimeKnown", downtimeMs: 1, source: "wallClock" })).toEqual([]);
  });
});

describe("a saved alarm at boot (D80, D113)", () => {
  test("D113: its siren is not commanded at boot; reported off with the downtime unknown, the alarm may be cut short", () => {
    const d = new Direct();
    const booted = d.boot(saved({ alarm: true }), 2);
    expect(booted.some((o) => o.kind === "sirenIntent")).toBe(false);
    expect(d.state.alarm.alarm?.sirens.get(SIREN)?.until).toBe(mono(260 * SECOND));
    const out = d.send(report({ state: 0 }, undefined, 9000));
    expect(decisionsIn(out, "alarm_may_be_cut_short")).toHaveLength(1);
    expect(decisionsIn(out, "siren_command")).toEqual([]);
  });

  test("D80: known later, a siren cut short is sounded for what is left", () => {
    const d = new Direct();
    d.boot(saved({ alarm: true }), 2);
    d.send(report({ state: 0 }, undefined, 9000));
    d.at = mono(10 * SECOND);
    const out = d.send({ kind: "downtimeKnown", downtimeMs: 30_000, source: "wallClock" });
    // Until 260 − 30 = 230 s, from 10 s.
    expect(decisionsIn(out, "siren_command").map((r) => r.value)).toEqual([65_536 + 220]);
  });

  test("a siren never seen sounding for the saved alarm is sounded by the correction rule", () => {
    const d = new Direct();
    d.boot(saved({ alarm: true, commanded: false }), 2);
    const out = d.send(report({ state: 0 }, undefined, 9000));
    expect(decisionsIn(out, "alarm_may_be_cut_short")).toEqual([]);
    expect(decisionsIn(out, "siren_command").map((r) => r.value)).toEqual([65_536 + 260]);
  });

  test("D80: a siren reporting sounding is adopted, and its time becomes the alarm's (unknown downtime)", () => {
    const d = new Direct();
    d.boot(saved({ alarm: true }), 2);
    const out = d.send(report({ state: 1, secondsLeft: 200 }, undefined, 9000));
    expect(decisionsIn(out, "siren_adopted").map((r) => r.value)).toEqual([200]);
    expect(d.state.alarm.alarm?.sirens.get(SIREN)?.until).toBe(mono(200 * SECOND));
    expect(decisionsIn(out, "siren_command")).toEqual([]);
  });
});

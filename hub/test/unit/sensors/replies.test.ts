/**
 * When the hub replies to a sensor and what the reply says (hub-design.md section 8, "When to
 * reply", "Which rate a packet goes at"; protocol.md §6, §7; D72), through the real `step` with
 * the stand-ins: a heartbeat answered only when its version differs or it asks, at the fixed
 * moment on its gateway's clock, skipped when decided more than 700 ms ‡ after its end; event
 * reports always, as soon as possible within the listen time; the reply's binding, counter, rate,
 * next heartbeat, the countdown, and the resume point written now at 1,024.
 */
import { describe, expect, test } from "bun:test";
import { MessageType, type MessageOf, TransmitWhen } from "@hsn/protocol";
import { mono } from "../../../src/core/model/time.ts";
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

type Reply = MessageOf<typeof MessageType.Reply>;

function bench(over: Parameters<typeof sensorRow>[2] = {}, rate = 5) {
  const sensors = benchSensors(1);
  const sensor = sensors[0];
  const b = new Bench(sensors);
  if (sensor === undefined) return { b, gateway: b.gateway as RecordingGateway };
  b.boot(sensorSnapshot(sensors, rate, { configs: [sensorRow(sensor.device, rate, over)] }));
  return { b, gateway: b.gateway as RecordingGateway };
}

function replyOf(b: Bench, index: number, answered: number): Reply | undefined {
  const out = b.stand.radioOuts.at(index);
  if (out === undefined) return undefined;
  const opened = b.openReply(0, out.packet, answered);
  return opened?.type === MessageType.Reply ? opened : undefined;
}

describe("heartbeat replies (D72)", () => {
  test("a heartbeat holding the current version that does not ask gets nothing, and nothing is written now", () => {
    const { b } = bench();
    const before = b.world.effects.length;
    b.hear(b.seal(0, heartbeat({ settingsVersion: 1 }), 100), mono(10 * SECOND), 5);
    expect(b.stand.radioOuts).toEqual([]);
    const after = b.world.effects.slice(before);
    expect(
      after.filter((e) => (e.kind === "write" || e.kind === "record") && e.durability === "now"),
    ).toEqual([]);
    // The routine row and window, as section 7 says (D72).
    expect(after.some((e) => e.kind === "write" && e.op.table === "device_state")).toBe(true);
  });

  test("a link check is answered at the fixed moment, 1 s † after its end on its gateway's clock", () => {
    const { b, gateway } = bench();
    const end = mono(10 * SECOND);
    b.hear(b.seal(0, heartbeat({ flags: flags({ replyWanted: true }) }), 100), end, 5);
    const out = b.stand.radioOuts[0];
    expect(out?.timing).toEqual({
      kind: "at",
      gateway: out?.gateway ?? 0,
      gatewayMicros: end + SECOND,
    } as never);
    expect(out?.purpose).toBe("heartbeatReply");
    expect(out?.counter).toBe(1024);
    const reply = replyOf(b, 0, 100);
    expect(reply?.settingsVersion).toBe(1);
    expect(gateway.requests[0]?.request.when).toBe(TransmitWhen.AtTime);
  });

  test("a heartbeat holding another version is answered without asking", () => {
    const { b } = bench({ version: 7 });
    b.hear(b.seal(0, heartbeat({ settingsVersion: 6 }), 100), mono(10 * SECOND), 5);
    expect(replyOf(b, 0, 100)?.settingsVersion).toBe(7);
  });

  test("decided more than 700 ms ‡ after the heartbeat's end, the reply is skipped and recorded", () => {
    const late = bench();
    late.b.hear(
      late.b.seal(0, heartbeat({ flags: flags({ replyWanted: true }) }), 100),
      mono(10 * SECOND),
      5,
      { delayMs: 701 },
    );
    expect(late.b.stand.radioOuts).toEqual([]);
    expect(late.b.decisions("reply_skipped")).toHaveLength(1);
    const inTime = bench();
    inTime.b.hear(
      inTime.b.seal(0, heartbeat({ flags: flags({ replyWanted: true }) }), 100),
      mono(10 * SECOND),
      5,
      { delayMs: 700 },
    );
    expect(inTime.b.stand.radioOuts).toHaveLength(1);
  });

  test("the first counter, a multiple of 1,024, has its next resume point written now in the same step", () => {
    const { b } = bench();
    b.hear(
      b.seal(0, heartbeat({ flags: flags({ replyWanted: true }) }), 100),
      mono(10 * SECOND),
      5,
    );
    const resume = b.effects("write").find((w) => w.op.table === "send_counters");
    expect(resume).toMatchObject({ durability: "now", op: { row: { resumePoint: 2048 } } });
    // The send passed the gate after that commit: the far end got the request.
    expect((b.gateway as RecordingGateway).requests).toHaveLength(1);
  });
});

describe("event replies (section 8)", () => {
  const door = (open: boolean, age: number) =>
    ({
      type: MessageType.DoorChanged,
      settingsVersion: 1,
      flags: flags({ doorOpen: open, replyWanted: true }),
      batteryCode: 120,
      temperatureCelsius: 20,
      doorChangeCount: 1,
      eventAgeSeconds: age,
    }) as const;

  test("go as soon as possible, starting no later than the end + the listen time at the arrival rate − the reply's airtime", () => {
    for (const rate of [5, 2]) {
      const { b } = bench({}, rate);
      const end = mono(10 * SECOND);
      b.hear(b.seal(0, door(true, 0), 100), end, rate);
      const out = b.stand.radioOuts[0];
      const listen = b.rules.replies.eventListenMs[rate] ?? 0;
      const airtime = rate === 5 ? 71.936 : 452.608;
      expect(out?.timing).toEqual({
        kind: "asap",
        latest: mono(end + Math.round((listen - airtime) * 1000)),
      });
      expect(replyOf(b, 0, 100)?.nextHeartbeatTenths).toBe(0);
    }
  });

  test("a reply to an armed opening says armed, countdown started, with the seconds left", () => {
    const { b } = bench({ arm: 1, countdownS: 30 });
    b.stand.armed.add(b.sensors[0]?.device ?? (0 as never));
    b.hear(b.seal(0, door(true, 2), 100), mono(10 * SECOND), 5);
    const reply = replyOf(b, 0, 100);
    expect(reply?.flags).toEqual({ armed: true, countdownStarted: true, updateAvailable: false });
    expect(reply?.countdownRemainingSeconds).toBe(28);
  });

  test("cover, button, Started and log entries are always answered", () => {
    const { b } = bench();
    const status = {
      settingsVersion: 1,
      flags: flags(),
      batteryCode: 1,
      temperatureCelsius: 1,
      doorChangeCount: 0,
      eventAgeSeconds: 0,
    };
    b.hear(b.seal(0, { type: MessageType.CoverChanged, ...status }, 100), mono(10 * SECOND), 5);
    b.hear(
      b.seal(0, { type: MessageType.Button, ...status, buttonAction: 1 }, 101),
      mono(20 * SECOND),
      5,
    );
    b.hear(
      b.seal(
        0,
        {
          type: MessageType.Started,
          role: 1,
          firmwareVersion: { major: 1, minor: 0, patch: 0 },
          resetCause: 1,
          lastFatalError: 0,
          settingsVersion: 1,
        },
        102,
      ),
      mono(30 * SECOND),
      5,
    );
    b.hear(
      b.seal(
        0,
        { type: MessageType.LogEntries, entries: [{ ageTenths: 0, level: 2, code: 1, text: "x" }] },
        103,
      ),
      mono(40 * SECOND),
      5,
    );
    expect(b.stand.radioOuts.map((o) => o.purpose)).toEqual([
      "eventReply",
      "eventReply",
      "eventReply",
      "eventReply",
    ]);
  });
});

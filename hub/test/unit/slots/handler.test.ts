/**
 * The slots module in the real `step` with the stand-ins (hub-design.md section 8, "Heartbeat
 * slots" and "Clock correction"): new sensors placed and the plan made again when crowded, each
 * phase written now; the next heartbeat a reply names, and the early one after Started; which
 * heartbeat pairs make a sample (slotted, newest, one gateway, one version, no Started between);
 * a correction sent through a version change; a restarted plan anchored again; the plan made
 * again for the new rate at a switch.
 */
import { describe, expect, test } from "bun:test";
import { type Message, MessageType, TransmitResultCode } from "@hsn/protocol";
import { type DeviceId, deviceId } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import { encodeEstimates } from "../../../src/core/slots/estimates.ts";
import {
  Bench,
  benchSensors,
  flags,
  heartbeat,
  type RecordingGateway,
  SECOND,
  sensorSnapshot,
} from "../../scenarios/sensors/bench.ts";
import { forwardedFrame } from "../../scenarios/sensors/stand-ins.ts";

const I = 180 * SECOND;

function oneSensor() {
  const sensors = benchSensors(1);
  const b = new Bench(sensors);
  b.boot(sensorSnapshot(sensors, 5));
  return { b, device: sensors[0]?.device ?? deviceId(0) };
}

const slot = (b: Bench, device: DeviceId) => b.world.state.slots.entries.get(device);

/** Answers the latest transmit request "sent". */
function sent(b: Bench): void {
  const gw = b.gateway as RecordingGateway;
  const last = gw.requests.at(-1);
  if (last !== undefined) b.deliver(gw.result(last, TransmitResultCode.Sent));
}

const asking = (over: Partial<Extract<Message, { type: 1 }>> = {}) =>
  heartbeat({ flags: flags({ replyWanted: true }), ...over });

describe("placing sensors (section 8)", () => {
  test("each new sensor takes the largest clearance; when the smallest falls below 2w ‡ all are planned again evenly; phases are written now", () => {
    const sensors = benchSensors(30);
    const b = new Bench(sensors);
    b.boot(sensorSnapshot([], 5));
    for (const s of sensors) {
      b.stand.toAdd.set(s.name, { device: s.device, address: s.address, role: 1 });
      const before = b.world.effects.length;
      b.command({ kind: "usbAdd", port: "/dev/x", name: s.name });
      const writes = b.world.effects
        .slice(before)
        .filter((e) => e.kind === "write" && e.op.table === "device_state");
      expect(writes.length).toBeGreaterThanOrEqual(1);
      expect(writes.every((w) => w.kind === "write" && w.durability === "now")).toBe(true);
    }
    const phases = sensors.map((s) => slot(b, s.device)?.slot.phaseUs ?? -1);
    expect(phases.slice(0, 3)).toEqual([0, 6 * SECOND, 12 * SECOND]);
    expect(phases.at(-1)).toBe(174 * SECOND);
  });

  test("two sensors: the second takes the middle of the free time, with no replan", () => {
    const sensors = benchSensors(2);
    const b = new Bench(sensors);
    b.boot(sensorSnapshot([], 5));
    for (const s of sensors) {
      b.stand.toAdd.set(s.name, { device: s.device, address: s.address, role: 1 });
      b.command({ kind: "usbAdd", port: "/dev/x", name: s.name });
    }
    const span = slot(b, sensors[0]?.device ?? deviceId(0))?.slot.spanUs ?? 0;
    expect(slot(b, sensors[1]?.device ?? deviceId(0))?.slot.phaseUs).toBe(
      Math.round(span + (I - span - span) / 2),
    );
  });
});

describe("the next heartbeat in a reply", () => {
  test("a link-check reply names the first slot at least I/2 after the answered end, in tenths", () => {
    const { b, device } = oneSensor();
    const phase = slot(b, device)?.slot.phaseUs ?? 0;
    b.hear(b.seal(0, asking(), 100), mono(1000 * SECOND), 5);
    const reply = b.openReply(0, b.stand.radioOuts[0]?.packet ?? new Uint8Array(), 100);
    const end = 1000 * SECOND;
    let t = phase;
    while (t < end + I / 2) t += I;
    expect(reply).toMatchObject({ nextHeartbeatTenths: Math.round((t - end) / 100_000) });
  });

  test("a reply to Started names the early heartbeat, at least 30 s ‡ after it; a door reply names none", () => {
    const { b, device } = oneSensor();
    const phase = slot(b, device)?.slot.phaseUs ?? 0;
    const started: Message = {
      type: MessageType.Started,
      role: 1,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 1,
      lastFatalError: 0,
      settingsVersion: 1,
    };
    const end = 1000 * SECOND;
    b.hear(b.seal(0, started, 100), mono(end), 5);
    let t = phase;
    while (t < end + 30 * SECOND) t += I;
    expect(b.openReply(0, b.stand.radioOuts[0]?.packet ?? new Uint8Array(), 100)).toMatchObject({
      nextHeartbeatTenths: Math.round((t - end) / 100_000),
    });
    const door: Message = {
      type: MessageType.DoorChanged,
      settingsVersion: 1,
      flags: flags({ replyWanted: true }),
      batteryCode: 1,
      temperatureCelsius: 1,
      doorChangeCount: 1,
      eventAgeSeconds: 0,
    };
    b.hear(b.seal(0, door, 101), mono(end + 60 * SECOND), 5);
    expect(b.openReply(0, b.stand.radioOuts[1]?.packet ?? new Uint8Array(), 101)).toMatchObject({
      nextHeartbeatTenths: 0,
    });
  });
});

describe("clock samples (section 8, Clock correction)", () => {
  /** A sensor given its slot by a sent reply to counter 100, then heartbeats at `ends`. */
  function sampled(
    ends: readonly {
      readonly at: number;
      readonly counter: number;
      readonly over?: Partial<Extract<Message, { type: 1 }>>;
      readonly rate?: number;
    }[],
  ) {
    const { b, device } = oneSensor();
    b.hear(b.seal(0, asking(), 100), mono(10 * SECOND), 5);
    sent(b);
    for (const e of ends)
      b.hear(b.seal(0, heartbeat(e.over ?? {}), e.counter), mono(e.at), e.rate ?? 5);
    return { b, samples: slot(b, device)?.samples ?? [] };
  }
  const fast = (k: number) => 200 * SECOND + Math.round((k * I) / 1.01);

  test("two slotted heartbeats of one version make a sample d = I ÷ G − 1", () => {
    const { samples } = sampled([0, 1, 2].map((k) => ({ at: fast(k), counter: 101 + k })));
    expect(samples).toHaveLength(2);
    for (const d of samples) expect(d).toBeCloseTo(0.01, 6);
  });

  test("a heartbeat not after the slot-giving reply is not slotted; nor one with bit 7", () => {
    const { b, device } = oneSensor();
    b.hear(b.seal(0, heartbeat(), 98), mono(fast(0)), 5);
    b.hear(b.seal(0, heartbeat(), 99), mono(fast(1)), 5);
    expect(slot(b, device)?.samples).toEqual([]);
    const flagged = sampled(
      [0, 1].map((k) => ({
        at: fast(k),
        counter: 101 + k,
        over: { flags: flags({ listeningAtSendRate: true }) },
      })),
    );
    expect(flagged.samples).toEqual([]);
  });

  test("no sample across another settings version, or a Started", () => {
    const versions = sampled([
      { at: fast(0), counter: 101, over: { settingsVersion: 1 } },
      { at: fast(1), counter: 102, over: { settingsVersion: 9 } },
    ]);
    expect(versions.samples).toEqual([]);
    const { b, device } = oneSensor();
    b.hear(b.seal(0, asking(), 100), mono(10 * SECOND), 5);
    sent(b);
    b.hear(b.seal(0, heartbeat(), 101), mono(fast(0)), 5);
    const started: Message = {
      type: MessageType.Started,
      role: 1,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 1,
      lastFatalError: 0,
      settingsVersion: 1,
    };
    b.hear(b.seal(0, started, 102), mono(fast(0) + 10 * SECOND), 5);
    b.hear(b.seal(0, heartbeat(), 103), mono(fast(1)), 5);
    expect(slot(b, device)?.samples).toEqual([]);
  });

  test("no sample from two gateways' clocks, nor from a packet below the newest (a replay)", () => {
    const { b, device } = oneSensor();
    b.hear(b.seal(0, asking(), 100), mono(10 * SECOND), 5);
    sent(b);
    b.hear(b.seal(0, heartbeat(), 101), mono(fast(0)), 5);
    const second = b.world.openLink("network", "gw2");
    expect(b.world.advanceTo(mono(fast(1) + 30_000)).isOk()).toBe(true);
    expect(
      b.world
        .deliver(
          second,
          forwardedFrame(b.seal(0, heartbeat(), 102), {
            endedAt: mono(fast(1)),
            dataRate: 5,
            siteChannel: 1,
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(slot(b, device)?.samples).toEqual([]);
    b.hear(b.seal(0, heartbeat(), 104), mono(fast(2)), 5);
    b.hear(b.seal(0, heartbeat(), 103), mono(fast(3)), 5);
    expect(slot(b, device)?.samples).toEqual([]);
  });

  test("with 3 samples 1 % fast, the next reply carries a new version with the correction", () => {
    const { b } = sampled([0, 1, 2, 3].map((k) => ({ at: fast(k), counter: 101 + k })));
    b.hear(b.seal(0, heartbeat(), 105), mono(fast(4)), 5);
    const reply = b.openReply(0, b.stand.radioOuts.at(-1)?.packet ?? new Uint8Array(), 105);
    expect(reply).toMatchObject({ settingsVersion: 2, clockCorrectionTenPpm: 1000 });
  });
});

describe("after a restart and at a switch", () => {
  test("a plan from the snapshot is anchored again at the sensor's first heartbeat, and written now", () => {
    const sensors = benchSensors(1);
    const device = sensors[0]?.device ?? deviceId(0);
    const b = new Bench(sensors);
    const estimates = encodeEstimates(
      { device, order: device, intervalUs: I, spanUs: 3_133_632, phaseUs: 7 * SECOND },
      [0.002],
    );
    const state = {
      deviceId: device,
      boot: 1 as never,
      lastSeenMono: mono(0),
      lastSeenMs: 0,
      clockOk: true,
      window: null,
      reading: null,
      rssi: null,
      snrQ: null,
      bestGatewayId: null,
      uptimeS: null,
      estimates,
    };
    b.boot(sensorSnapshot(sensors, 5, { extra: { deviceState: [state] } }), 2);
    expect(slot(b, device)).toMatchObject({ anchored: false, samples: [0.002] });
    b.hear(b.seal(0, asking(), 100), mono(1000 * SECOND), 5);
    expect(b.openReply(0, b.stand.radioOuts[0]?.packet ?? new Uint8Array(), 100)).toMatchObject({
      nextHeartbeatTenths: 0,
    });
    expect(slot(b, device)).toMatchObject({
      anchored: true,
      slot: { phaseUs: (1000 * SECOND) % I },
    });
    const write = b
      .effects("write")
      .filter((e) => e.op.table === "device_state" && e.durability === "now");
    expect(write.length).toBeGreaterThan(0);
  });

  test("at a switch to DR0 the plan is made again with the 5-minute floor", () => {
    const { b, device } = oneSensor();
    b.command({ kind: "siteChange", rate: 0 });
    // It confirms the announcing version 2: every sensor in, so the switch goes.
    b.hear(b.seal(0, asking({ settingsVersion: 2 }), 100), mono(10 * SECOND), 5);
    expect(slot(b, device)?.slot.intervalUs).toBe(300 * SECOND);
  });
});

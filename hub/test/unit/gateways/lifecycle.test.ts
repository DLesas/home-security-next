/**
 * The gateways outside their packets (hub-design.md sections 4, 5, 7 and 8): restored at boot,
 * added and removed, the site move's switch (D115), a failed commit's resume points, and the
 * clock mapping of forwarded packets (section 8, "Heartbeat slots").
 */
import { describe, expect, test } from "bun:test";
import {
  Direction,
  encodeReplayWindow,
  MaxPacketLength,
  MessageType,
  openPacket,
  sessionBinding,
} from "@hsn/protocol";
import { bootId, linkId } from "../../../src/core/model/ids.ts";
import { DeviceState } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  toGateway,
  toHub as clockToHub,
  unwrapNear,
  withSample,
  EMPTY_CLOCK,
} from "../../../src/core/gateways/clock.ts";
import { nextSettingsVersion } from "../../../src/core/gateways/settings.ts";
import {
  configRow,
  connectVectors,
  deviceOf,
  deviceRow,
  effectsOf,
  GATEWAY_ADDRESS,
  GATEWAY_KEY,
  GATEWAY_RANDOM,
  Harness,
  HUB_RANDOM,
  ofKind,
  snapshotWith,
  toHub,
  vectorSite,
} from "./harness.ts";

const GATEWAY = deviceOf(GATEWAY_ADDRESS);
const LINK = linkId(1);
const SESSION = sessionBinding(GATEWAY_RANDOM, HUB_RANDOM);
const WRAP = 2 ** 32;

function forwarded(counter: number, receivedAtMicros: number): Uint8Array {
  return toHub(
    GATEWAY_ADDRESS,
    {
      type: MessageType.ForwardedPacket,
      receivedAtMicros,
      rssiDbm: -90,
      snrQuarterDb: 8,
      dataRate: 5,
      siteChannel: 1,
      packet: new Uint8Array(25).fill(0x10),
    },
    counter,
    SESSION,
  );
}

function endedAtOf(h: Harness, counter: number, receivedAtMicros: number): number | undefined {
  const arrival = ofKind(
    h.frame(LINK, forwarded(counter, receivedAtMicros)).messages,
    "devicePacket",
  )[0]?.arrival;
  return arrival?.path === "lora" ? arrival.endedAt : undefined;
}

describe("boot", () => {
  test("restores each paired gateway: counter from its resume point, settings, highest counter, uptime, baseline", () => {
    const h = new Harness();
    h.boot(
      snapshotWith({
        sendCounters: [{ deviceId: GATEWAY, resumePoint: 62_464 }],
        gatewayConfig: [configRow(GATEWAY_ADDRESS, 9, { defaultPowerDbm: 17 })],
        deviceState: [
          {
            deviceId: GATEWAY,
            boot: bootId(1),
            lastSeenMono: mono(0),
            lastSeenMs: 0,
            clockOk: true,
            window: encodeReplayWindow({ highest: 88_213, seenBelow: 0n }),
            reading: null,
            rssi: null,
            snrQ: null,
            bestGatewayId: null,
            uptimeS: 7200,
            estimates: Uint8Array.from([1, 0x38, 0xfb]), // −1,224 tenths: −122.4 dB
          },
        ],
      }),
    );
    const entry = h.state.gateways.gateways.get(GATEWAY);
    expect(entry?.counter).toEqual({ step: 1024, next: 62_464, resumePoint: 62_464 });
    expect(entry?.config.version).toBe(9);
    expect(entry?.config.defaultPowerDbm).toBe(17);
    expect(entry?.highestAccepted).toBe(88_213);
    expect(entry?.uptimeS).toBe(7200);
    expect(entry?.noise.baseline).toBeCloseTo(-122.4, 10);
    expect(entry?.live).toBeUndefined();
  });

  test("skips removed devices and devices of other roles", () => {
    const h = new Harness();
    h.boot(
      snapshotWith({
        devices: [deviceRow(GATEWAY_ADDRESS, 3, DeviceState.Removed), deviceRow(0x1a2b3c4d, 1)],
      }),
    );
    expect(h.state.gateways.gateways.size).toBe(0);
  });

  test("its first packet to a restored gateway takes the resume point, which writes the next one now", () => {
    const h = new Harness();
    h.boot(snapshotWith({ sendCounters: [{ deviceId: GATEWAY, resumePoint: 2048 }] }));
    const link = h.open(1);
    const out = h.frame(
      link,
      toHub(
        GATEWAY_ADDRESS,
        {
          type: MessageType.Hello,
          gatewayRandom: GATEWAY_RANDOM,
          firmwareVersion: { major: 1, minor: 0, patch: 0 },
          settingsVersion: 1,
        },
        1,
        new Uint8Array(),
      ),
    );
    expect(effectsOf(out.effects, "send")[0]?.counters).toEqual([
      { device: GATEWAY, counter: 2048 },
    ]);
    expect(effectsOf(out.effects, "write").filter((w) => w.op.table === "send_counters")).toEqual([
      {
        kind: "write",
        durability: "now",
        op: { table: "send_counters", op: "upsert", row: { deviceId: GATEWAY, resumePoint: 3072 } },
      },
    ]);
  });
});

describe("adding and removing a gateway", () => {
  test("added: settings version 1 written now, with the site's powers", () => {
    const h = new Harness();
    h.boot(
      snapshotWith({
        devices: [],
        gatewayConfig: [],
        site: vectorSite({ replyPowerDbm: 19, sirenPowerDbm: 21 }),
      }),
    );
    const out = h.input({
      kind: "deviceAdded",
      device: GATEWAY,
      role: 3,
      address: GATEWAY_ADDRESS,
      name: "gateway-1",
    });
    expect(effectsOf(out.effects, "write")).toEqual([
      {
        kind: "write",
        durability: "now",
        op: {
          table: "gateway_config",
          op: "upsert",
          row: {
            deviceId: GATEWAY,
            version: 1,
            statusIntervalS: 30,
            interferenceDb: 10,
            interferenceS: 30,
            defaultPowerDbm: 19,
            sirenPowerDbm: 21,
          },
        },
      },
    ]);
    expect(h.state.gateways.gateways.get(GATEWAY)?.counter).toEqual({
      step: 1024,
      next: 1,
      resumePoint: 1024,
    });
    // A sensor is not a gateway.
    expect(
      h.input({
        kind: "deviceAdded",
        device: deviceOf(0x1a2b3c4d),
        role: 1,
        address: 0x1a2b3c4d,
        name: "s",
      }).effects,
    ).toEqual([]);
  });

  test("removed: its session ends, its link is closed, gatewayDown", () => {
    const h = new Harness();
    connectVectors(h, LINK);
    const out = h.input({ kind: "deviceRemoved", device: GATEWAY });
    expect(effectsOf(out.effects, "close")).toEqual([
      { kind: "close", link: LINK, reason: "gateway removed" },
    ]);
    expect(ofKind(out.messages, "gatewayDown")).toEqual([
      { kind: "gatewayDown", gateway: GATEWAY },
    ]);
    expect(h.state.gateways.gateways.has(GATEWAY)).toBe(false);
    expect(h.state.gateways.timers).toEqual([]);
  });
});

describe("the site move's switch (D115)", () => {
  test("every gateway gets a new version written now; a connected one is sent it at once, with the new channel and rate", () => {
    const h = new Harness();
    connectVectors(h, LINK);
    const out = h.input({
      kind: "siteMove",
      move: 1,
      stage: "switched",
      channel: 2,
      rate: 2,
      forced: false,
    });
    expect(
      effectsOf(out.effects, "write")
        .filter((w) => w.op.table === "gateway_config")
        .map((w) => [
          w.durability,
          w.op.op === "upsert" && w.op.table === "gateway_config" ? w.op.row.version : 0,
        ]),
    ).toEqual([["now", 2]]);
    const sent = effectsOf(out.effects, "send")[0];
    const opened = openPacket(sent?.bytes ?? new Uint8Array(), {
      key: GATEWAY_KEY,
      expectedDirection: Direction.FromHub,
      binding: SESSION,
      maxLength: MaxPacketLength.Link,
    });
    expect(opened.ok && opened.value.message).toMatchObject({
      type: MessageType.GatewaySettings,
      settingsVersion: 2,
      siteChannel: 2,
      listenDataRateMask: 1 << 2,
    });
  });

  test("a field that stays keeps the site's value; the switch is applied once; announcing changes nothing", () => {
    const h = new Harness();
    connectVectors(h, LINK);
    expect(
      h.input({
        kind: "siteMove",
        move: 1,
        stage: "announcing",
        channel: undefined,
        rate: 2,
        forced: false,
      }).effects,
    ).toEqual([]);
    h.input({
      kind: "siteMove",
      move: 1,
      stage: "switched",
      channel: undefined,
      rate: 2,
      forced: false,
    });
    expect(h.state.gateways.site).toMatchObject({ channel: 0, rateMask: 4, appliedMove: 1 });
    expect(
      h.input({
        kind: "siteMove",
        move: 1,
        stage: "switched",
        channel: undefined,
        rate: 2,
        forced: false,
      }).effects,
    ).toEqual([]);
  });

  test("an offline gateway gets its new settings at its next welcome", () => {
    const h = new Harness();
    h.boot(snapshotWith({ sendCounters: [] }));
    h.input({ kind: "siteMove", move: 3, stage: "switched", channel: 2, rate: 0, forced: false });
    const link = h.open(1);
    h.entropy = HUB_RANDOM;
    const out = h.frame(
      link,
      toHub(
        GATEWAY_ADDRESS,
        {
          type: MessageType.Hello,
          gatewayRandom: GATEWAY_RANDOM,
          firmwareVersion: { major: 1, minor: 0, patch: 0 },
          settingsVersion: 1,
        },
        1,
        new Uint8Array(),
      ),
    );
    const settings = effectsOf(out.effects, "send")[1];
    const opened = openPacket(settings?.bytes ?? new Uint8Array(), {
      key: GATEWAY_KEY,
      expectedDirection: Direction.FromHub,
      binding: SESSION,
      maxLength: MaxPacketLength.Link,
    });
    expect(opened.ok && opened.value.message).toMatchObject({
      settingsVersion: 2,
      siteChannel: 2,
      listenDataRateMask: 1,
    });
  });

  test("a restart after the switch does not switch again: the stored settings already carry it", () => {
    const h = new Harness();
    h.boot(
      snapshotWith({ site: vectorSite({ moveId: 4, moveStage: 2, channel: 2, rateMask: 4 }) }),
    );
    expect(
      h.input({ kind: "siteMove", move: 4, stage: "switched", channel: 2, rate: 2, forced: false })
        .effects,
    ).toEqual([]);
  });

  test("versions run 1 to 255, then 1", () => {
    expect(nextSettingsVersion(1)).toBe(2);
    expect(nextSettingsVersion(254)).toBe(255);
    expect(nextSettingsVersion(255)).toBe(1);
    expect(nextSettingsVersion(0)).toBe(1);
  });
});

describe("a failed commit (section 4)", () => {
  test("re-emits every gateway key's resume point, now", () => {
    const h = new Harness();
    h.boot(snapshotWith({ sendCounters: [{ deviceId: GATEWAY, resumePoint: 5120 }] }));
    const out = h.input({ kind: "commit", outcome: { kind: "failed", message: "disk" } });
    expect(effectsOf(out.effects, "write")).toEqual([
      {
        kind: "write",
        durability: "now",
        op: { table: "send_counters", op: "upsert", row: { deviceId: GATEWAY, resumePoint: 5120 } },
      },
    ]);
    expect(h.input({ kind: "commit", outcome: { kind: "recovered" } }).effects).toEqual([]);
  });
});

describe("the clock mapping", () => {
  test("unwrapping takes the 32-bit time nearest the reference", () => {
    expect(unwrapNear(5, WRAP + 10)).toBe(WRAP + 5);
    expect(unwrapNear(WRAP - 5, WRAP + 10)).toBe(WRAP - 5);
    expect(unwrapNear(10, WRAP - 5)).toBe(WRAP + 10);
    expect(unwrapNear(0, 0)).toBe(0);
  });

  test("the offset is the smallest of the last 64 samples, which removes network delay", () => {
    let clock = EMPTY_CLOCK;
    clock = withSample(clock, 1_000_000, mono(3_000_000), 64); // delay 0: offset 2,000,000
    clock = withSample(clock, 2_000_000, mono(4_050_000), 64); // 50 ms late
    expect(clock.offset).toBe(2_000_000);
    expect(clockToHub(clock, 1_500_000, mono(4_000_000))).toBe(mono(3_500_000));
    expect(toGateway(clock, mono(3_500_000))).toBe(1_500_000);
    // After 64 later samples the first has gone, and the new smallest rules.
    for (let i = 0; i < 64; i++) clock = withSample(clock, 3_000_000 + i, mono(5_010_000 + i), 64);
    expect(clock.samples).toHaveLength(64);
    expect(clock.offset).toBe(2_010_000);
  });

  test("through the handler: the forwarded packet's end on the hub's clock, across the 32-bit wrap", () => {
    const h = new Harness();
    connectVectors(h, LINK);
    h.now = mono(10_000_000);
    expect(endedAtOf(h, 10, WRAP - 1_000_000)).toBe(10_000_000);
    // Two seconds later on both clocks, the gateway's time has wrapped.
    h.now = mono(12_030_000);
    expect(endedAtOf(h, 11, 1_000_000)).toBe(12_000_000);
    // A frame that took longer on the network is placed by the smallest delay seen.
    h.now = mono(14_200_000);
    expect(endedAtOf(h, 12, 3_000_000)).toBe(14_000_000);
  });

  test("a new session starts its own mapping", () => {
    const h = new Harness();
    connectVectors(h, LINK);
    h.now = mono(10_000_000);
    endedAtOf(h, 10, 5);
    expect(h.state.gateways.gateways.get(GATEWAY)?.live?.clock.samples).toHaveLength(1);
    h.entropy = new Uint8Array(8).fill(9);
    h.frame(
      LINK,
      toHub(
        GATEWAY_ADDRESS,
        {
          type: MessageType.Hello,
          gatewayRandom: new Uint8Array(8).fill(3),
          firmwareVersion: { major: 1, minor: 0, patch: 0 },
          settingsVersion: 1,
        },
        20,
        new Uint8Array(),
      ),
    );
    const next = sessionBinding(new Uint8Array(8).fill(3), new Uint8Array(8).fill(9));
    h.frame(
      LINK,
      toHub(
        GATEWAY_ADDRESS,
        {
          type: MessageType.Started,
          role: 3,
          firmwareVersion: { major: 1, minor: 0, patch: 0 },
          resetCause: 1,
          lastFatalError: 0,
          settingsVersion: 1,
        },
        21,
        next,
      ),
    );
    expect(h.state.gateways.gateways.get(GATEWAY)?.live?.clock).toEqual(EMPTY_CLOCK);
  });

  test("the mapping keeps the rules' number of frames", () => {
    expect(DEFAULT_RULES.slots.clockMappingFrames).toBe(64);
  });
});

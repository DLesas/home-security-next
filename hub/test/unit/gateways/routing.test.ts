/**
 * Which gateway a packet goes through and gateway silence (hub-design.md section 8, "Which
 * gateway a packet goes through" and "Silence"; §7, D97): rerouting an event reply 20 ms ‡
 * early, a notice through any gateway, the siren's best gateway over 15 minutes ‡ with
 * duplicates, a gateway offline after 60 s naming the sensors only it heard, and their silence
 * held back.
 */
import { describe, expect, test } from "bun:test";
import {
  Direction,
  MaxPacketLength,
  MessageType,
  NO_BINDING,
  openPacket,
  sessionBinding,
  TransmitPriority,
} from "@hsn/protocol";
import { type DeviceId, type LinkId, linkId, sendRef } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import {
  bestGatewayForSiren,
  connectedGateways,
  replyGateway,
  sensorSilenceHeldBack,
  sensorsOnlyHeardBy,
} from "../../../src/core/gateways/view.ts";
import {
  configRow,
  decisionsIn,
  deviceOf,
  deviceRow,
  effectsOf,
  GATEWAY_ADDRESS,
  Harness,
  keyOf,
  ofKind,
  SECOND,
  SECOND_GATEWAY_ADDRESS,
  SENSOR_ADDRESS,
  SIREN_ADDRESS,
  snapshotWith,
  statusMessage,
  toHub,
  vectorSite,
} from "./harness.ts";

const G1 = deviceOf(GATEWAY_ADDRESS);
const G2 = deviceOf(SECOND_GATEWAY_ADDRESS);
const SENSOR = deviceOf(SENSOR_ADDRESS);
const SIREN = deviceOf(SIREN_ADDRESS);
const RULES = DEFAULT_RULES;
const OFFLINE_MS = RULES.silence.gatewayOfflineMs;

/** Both gateways paired; gateway 1 on link 1 (the vectors' session), gateway 2 on link 2. */
function twoGateways(): { readonly h: Harness; readonly second: Uint8Array } {
  const h = new Harness();
  h.boot(
    snapshotWith({
      devices: [
        deviceRow(GATEWAY_ADDRESS, 3),
        deviceRow(SECOND_GATEWAY_ADDRESS, 3),
        deviceRow(SENSOR_ADDRESS, 1),
        deviceRow(SIREN_ADDRESS, 2),
      ],
      gatewayConfig: [configRow(GATEWAY_ADDRESS), configRow(SECOND_GATEWAY_ADDRESS)],
      sendCounters: [],
      site: vectorSite(),
    }),
  );
  connect(h, linkId(1), GATEWAY_ADDRESS, 0x10, 100);
  return { h, second: connect(h, linkId(2), SECOND_GATEWAY_ADDRESS, 0x20, 100) };
}

/** Connects a gateway on `link` with its own random; returns the session value. */
function connect(
  h: Harness,
  link: LinkId,
  address: number,
  random: number,
  counter: number,
): Uint8Array {
  if (!h.state.links.open.has(link)) h.open(link);
  const gatewayRandom = new Uint8Array(8).fill(random);
  const hubRandom = new Uint8Array(8).fill(random + 1);
  h.entropy = hubRandom;
  h.frame(
    link,
    toHub(
      address,
      {
        type: MessageType.Hello,
        gatewayRandom,
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        settingsVersion: 1,
      },
      counter,
      NO_BINDING,
    ),
  );
  const session = sessionBinding(gatewayRandom, hubRandom);
  h.frame(
    link,
    toHub(
      address,
      {
        type: MessageType.Started,
        role: 3,
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        resetCause: 1,
        lastFatalError: 0,
        settingsVersion: 1,
      },
      counter + 1,
      session,
    ),
  );
  return session;
}

function forwarded(
  address: number,
  session: Uint8Array,
  counter: number,
  receivedAtMicros: number,
): Uint8Array {
  return toHub(
    address,
    {
      type: MessageType.ForwardedPacket,
      receivedAtMicros,
      rssiDbm: -90,
      snrQuarterDb: 20,
      dataRate: 5,
      siteChannel: 1,
      packet: new Uint8Array(25).fill(0x10),
    },
    counter,
    session,
  );
}

function accepted(
  device: DeviceId,
  role: number,
  gateway: DeviceId,
  snrQuarterDb: number,
): Internal {
  return {
    kind: "accepted",
    device,
    role,
    counter: 1,
    message: {
      type: MessageType.Started,
      role,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 1,
      lastFatalError: 0,
      settingsVersion: 1,
    },
    arrival: {
      path: "lora",
      gateway,
      link: linkId(1),
      gatewayCounter: 1,
      gatewayMicros: 0,
      endedAt: mono(0),
      rssiDbm: -90,
      snrQuarterDb,
      dataRate: 5,
      siteChannel: 1,
    },
    record: 0 as never,
    newest: true,
  };
}

function view(h: Harness): HubState {
  return h.state;
}

describe("replies and notices", () => {
  test("an event reply whose gateway is gone goes through another, its latest moment 20 ms ‡ earlier", () => {
    const { h, second } = twoGateways();
    // Give gateway 2 a clock mapping: one forwarded packet at gateway time 1,000,000.
    h.now = mono(3_000_000);
    h.frame(linkId(2), forwarded(SECOND_GATEWAY_ADDRESS, second, 200, 1_000_000));
    h.input({ kind: "linkClosed", link: linkId(1), reason: "remote" });
    expect(replyGateway(view(h), G1, false)).toBe(G2);
    expect(replyGateway(view(h), G1, true)).toBeUndefined();
    const latest = mono(4_500_000);
    const out = h.input({
      kind: "radioOut",
      ref: sendRef(1),
      device: SENSOR,
      packet: new Uint8Array(32).fill(1),
      counter: 5,
      gateway: G1,
      timing: { kind: "asap", latest },
      dataRate: 5,
      powerDbm: 22,
      priority: TransmitPriority.Normal,
      purpose: "eventReply",
    });
    const send = effectsOf(out.effects, "send")[0];
    expect(send?.link).toBe(linkId(2));
    const opened = openPacket(send?.bytes ?? new Uint8Array(), {
      key: keyOf(SECOND_GATEWAY_ADDRESS),
      expectedDirection: Direction.FromHub,
      binding: second,
      maxLength: MaxPacketLength.Link,
    });
    const request =
      opened.ok && opened.value.message.type === MessageType.TransmitRequest
        ? opened.value.message
        : undefined;
    // hub 3,000,000 ↔ gateway 1,000,000; the latest 4,500,000 − 20 ms = 4,480,000 → 2,480,000.
    expect(request?.gatewayTimeMicros).toBe(2_480_000);
  });

  test("a disarmed notice whose gateway is gone goes through any connected one, with no limit", () => {
    const { h } = twoGateways();
    h.input({ kind: "linkClosed", link: linkId(2), reason: "remote" });
    const out = h.input({
      kind: "radioOut",
      ref: sendRef(2),
      device: SENSOR,
      packet: new Uint8Array(18).fill(1),
      counter: 6,
      gateway: G2,
      timing: { kind: "asap", latest: undefined },
      dataRate: 5,
      powerDbm: 22,
      priority: TransmitPriority.Normal,
      purpose: "disarmedNotice",
    });
    expect(effectsOf(out.effects, "send").map((s) => s.link)).toEqual([linkId(1)]);
  });
});

describe("the siren's best gateway", () => {
  test("the highest SNR in the last 15 minutes ‡ among open sessions, the most recent on a tie", () => {
    const { h } = twoGateways();
    h.input(accepted(SIREN, 2, G1, 10));
    h.now = mono(SECOND);
    h.input(accepted(SIREN, 2, G2, 30));
    expect(bestGatewayForSiren(view(h), SIREN, h.now, RULES)).toBe(G2);
    h.now = mono(2 * SECOND);
    h.input(accepted(SIREN, 2, G1, 30));
    expect(bestGatewayForSiren(view(h), SIREN, h.now, RULES)).toBe(G1);
    // Exactly 15 minutes after the second copy, it is still in the window, tied with the third.
    const window = RULES.sirens.bestGatewayWindowMs * 1000;
    expect(bestGatewayForSiren(view(h), SIREN, mono(SECOND + window), RULES)).toBe(G1);
    // Past the window for the first two copies: only the later ones count, and G2's 50 beats 30.
    h.input(accepted(SIREN, 2, G2, 50));
    expect(bestGatewayForSiren(view(h), SIREN, mono(2 * SECOND + window + 1), RULES)).toBe(G2);
    // With every copy out of the window: any connected gateway, the lowest id (G2 = 3 < G1 = 4).
    expect(bestGatewayForSiren(view(h), SIREN, mono(3 * SECOND + 2 * window), RULES)).toBe(G2);
  });

  test("a copy exactly 15 minutes ‡ old still counts; a microsecond later it does not", () => {
    const { h } = twoGateways();
    h.input(accepted(SIREN, 2, G1, 40));
    h.now = mono(SECOND);
    h.input(accepted(SIREN, 2, G2, 10));
    const window = RULES.sirens.bestGatewayWindowMs * 1000;
    expect(bestGatewayForSiren(view(h), SIREN, mono(window), RULES)).toBe(G1);
    expect(bestGatewayForSiren(view(h), SIREN, mono(window + 1), RULES)).toBe(G2);
  });

  test("only open sessions count: the best copy's gateway gone, the next best is used", () => {
    const { h } = twoGateways();
    h.input(accepted(SIREN, 2, G1, 40));
    h.input(accepted(SIREN, 2, G2, 10));
    expect(bestGatewayForSiren(view(h), SIREN, h.now, RULES)).toBe(G1);
    h.input({ kind: "linkClosed", link: linkId(1), reason: "remote" });
    expect(bestGatewayForSiren(view(h), SIREN, h.now, RULES)).toBe(G2);
  });

  test("a duplicate copy counts, with the SNR its gateway forwarded it with", () => {
    const { h, second } = twoGateways();
    h.input(accepted(SIREN, 2, G1, 10));
    // Gateway 2 forwards the same siren packet at a better SNR; intake refuses it as a duplicate.
    const sirenPacket = toHub(
      SIREN_ADDRESS,
      {
        type: MessageType.Started,
        role: 2,
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        resetCause: 1,
        lastFatalError: 0,
        settingsVersion: 1,
      },
      77,
      NO_BINDING,
    );
    h.frame(
      linkId(2),
      toHub(
        SECOND_GATEWAY_ADDRESS,
        {
          type: MessageType.ForwardedPacket,
          receivedAtMicros: 5,
          rssiDbm: -80,
          snrQuarterDb: 40,
          dataRate: 5,
          siteChannel: 1,
          packet: sirenPacket,
        },
        300,
        second,
      ),
    );
    h.input({
      kind: "rejected",
      source: { device: G2 },
      reason: "duplicate",
      address: SIREN_ADDRESS,
      sample: sirenPacket.slice(0, 16),
      copy: { device: SIREN, gateway: G2, snrQuarterDb: 40, rssiDbm: -80, at: h.now },
    });
    expect(bestGatewayForSiren(view(h), SIREN, h.now, RULES)).toBe(G2);
  });

  test("with none heard recently, any connected gateway; with none connected, none", () => {
    const { h } = twoGateways();
    expect(bestGatewayForSiren(view(h), SIREN, h.now, RULES)).toBe(G2);
    h.input({ kind: "linkClosed", link: linkId(2), reason: "remote" });
    expect(bestGatewayForSiren(view(h), SIREN, h.now, RULES)).toBe(G1);
    h.input({ kind: "linkClosed", link: linkId(1), reason: "remote" });
    h.input({ kind: "linkClosed", link: linkId(2), reason: "remote" });
    expect(bestGatewayForSiren(view(h), SIREN, h.now, RULES)).toBeUndefined();
  });
});

describe("gateway silence (D97)", () => {
  test("offline after 60 s with nothing, not before: a warning written now naming the sensors only it heard", () => {
    const { h } = twoGateways();
    h.input(accepted(SENSOR, 1, G1, 10));
    // Gateway 2 keeps talking; gateway 1 falls silent.
    h.advance(OFFLINE_MS / 2);
    h.frame(
      linkId(2),
      toHub(
        SECOND_GATEWAY_ADDRESS,
        statusMessage(),
        400,
        h.state.gateways.gateways.get(G2)?.live?.binding ?? new Uint8Array(16),
      ),
    );
    const before = h.advance(OFFLINE_MS / 2 - 1);
    expect(decisionsIn(before.messages)).toEqual([]);
    // Only it heard the sensor, but it is not silent yet: nothing is held back.
    expect(sensorSilenceHeldBack(view(h), SENSOR, RULES)).toBe(false);
    const out = h.advance(1);
    const records = ofKind(out.messages, "auditRecord").filter((r) => r.record.kind === "decision");
    expect(
      records.map((r) =>
        r.record.kind === "decision"
          ? [r.record.row.kind, r.record.row.deviceId, r.record.row.value]
          : [],
      ),
    ).toEqual([["gateway_offline", G1, 1]]);
    expect(records[0]?.durability).toBe("now");
    const detail = records[0]?.record.kind === "decision" ? records[0].record.row.detail : null;
    expect(Array.from(detail ?? [])).toEqual([SENSOR, 0, 0, 0]);
    expect(ofKind(out.messages, "gatewayDown")).toEqual([{ kind: "gatewayDown", gateway: G1 }]);
    expect(connectedGateways(view(h))).toEqual([G2]);
    expect(sensorSilenceHeldBack(view(h), SENSOR, RULES)).toBe(true);
  });

  test("a sensor another gateway also heard is not named, and its silence is not held back", () => {
    const { h } = twoGateways();
    h.input(accepted(SENSOR, 1, G1, 10));
    h.input({
      kind: "rejected",
      source: { device: G2 },
      reason: "duplicate",
      address: SENSOR_ADDRESS,
      sample: new Uint8Array(16),
      copy: { device: SENSOR, gateway: G2, snrQuarterDb: 0, rssiDbm: -100, at: h.now },
    });
    expect(sensorsOnlyHeardBy(view(h), G1, RULES)).toEqual([]);
    h.advance(OFFLINE_MS);
    expect(sensorSilenceHeldBack(view(h), SENSOR, RULES)).toBe(false);
  });

  test("heard more than an hour ‡ before the gateway's last packet, a sensor is not its", () => {
    const { h } = twoGateways();
    h.input(accepted(SENSOR, 1, G1, 10));
    const hour = RULES.silence.heardByOtherGatewayMs;
    h.now = mono(h.now + hour * 1000 + 1);
    h.frame(
      linkId(1),
      toHub(
        GATEWAY_ADDRESS,
        statusMessage(),
        500,
        h.state.gateways.gateways.get(G1)?.live?.binding ?? new Uint8Array(16),
      ),
    );
    expect(sensorsOnlyHeardBy(view(h), G1, RULES)).toEqual([]);
  });

  test("a silent gateway heard again is back: gatewayUp, routes again, raised once only", () => {
    const { h } = twoGateways();
    h.advance(OFFLINE_MS);
    expect(decisionsIn(h.advance(OFFLINE_MS).messages)).toEqual([]);
    const back = h.frame(
      linkId(1),
      toHub(
        GATEWAY_ADDRESS,
        statusMessage(),
        600,
        h.state.gateways.gateways.get(G1)?.live?.binding ?? new Uint8Array(16),
      ),
    );
    expect(ofKind(back.messages, "gatewayUp")).toEqual([
      { kind: "gatewayUp", gateway: G1, link: linkId(1) },
    ]);
    expect(connectedGateways(view(h))).toContain(G1);
  });

  test("a gateway the hub knows but never heard after a start is offline 60 s after the start", () => {
    const h = new Harness();
    h.boot();
    expect(decisionsIn(h.advance(OFFLINE_MS - 1).messages)).toEqual([]);
    expect(decisionsIn(h.advance(1).messages)).toEqual(["gateway_offline"]);
  });
});

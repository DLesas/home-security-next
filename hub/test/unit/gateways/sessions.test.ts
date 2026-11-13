/**
 * Gateway sessions (hub-design.md section 8, "Gateway sessions"; section 7, "Gateway
 * connection"; protocol.md §4): the hello's counter rule and its write-now, the welcome with the
 * input's entropy and the settings after it, keeping the live session until the new one is
 * proven, closing an unproven one after 10 s ‡, and the session counter rule.
 */
import { describe, expect, test } from "bun:test";
import {
  encodeReplayWindow,
  MessageType,
  NO_BINDING,
  sessionBinding,
  toHex,
  TransmitPriority,
} from "@hsn/protocol";
import { linkId, sendRef } from "../../../src/core/model/ids.ts";
import { TxOutcome } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  configRow,
  connectVectors,
  decisionsIn,
  deviceOf,
  effectsOf,
  fieldCase,
  GATEWAY_ADDRESS,
  GATEWAY_RANDOM,
  Harness,
  HUB_RANDOM,
  ofKind,
  SENSOR_ADDRESS,
  snapshotWith,
  statusMessage,
  toHub,
  vectorSite,
} from "./harness.ts";

const GATEWAY = deviceOf(GATEWAY_ADDRESS);
const SESSION = sessionBinding(GATEWAY_RANDOM, HUB_RANDOM);
const UNPROVEN_MS = DEFAULT_RULES.gateways.unprovenSessionMs;

/** A hello from the vectors' gateway with its own random and counter. */
function hello(counter: number, random: number): Uint8Array {
  return toHub(
    GATEWAY_ADDRESS,
    {
      type: MessageType.Hello,
      gatewayRandom: new Uint8Array(8).fill(random),
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      settingsVersion: 1,
    },
    counter,
    NO_BINDING,
  );
}

/** A gateway status on the session `binding` with this counter. */
function status(counter: number, binding: Uint8Array, settingsVersion = 1): Uint8Array {
  return toHub(GATEWAY_ADDRESS, statusMessage({ settingsVersion }), counter, binding);
}

function started(counter: number, binding: Uint8Array): Uint8Array {
  return toHub(
    GATEWAY_ADDRESS,
    {
      type: MessageType.Started,
      role: 3,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 1,
      lastFatalError: 0,
      settingsVersion: 1,
    },
    counter,
    binding,
  );
}

function session(random: number, hub: Uint8Array): Uint8Array {
  return sessionBinding(new Uint8Array(8).fill(random), hub);
}

describe("a hello", () => {
  test("is answered with the welcome and settings vectors, byte for byte, the hub random from the input's entropy", () => {
    const h = new Harness();
    h.boot(
      snapshotWith({
        sendCounters: [],
        site: vectorSite(),
        gatewayConfig: [configRow(GATEWAY_ADDRESS, 1, { defaultPowerDbm: 14, sirenPowerDbm: 22 })],
      }),
    );
    const link = h.open(1);
    h.entropy = HUB_RANDOM;
    const out = h.frame(link, fieldCase("hello.json", "gateway hello").packet);
    const sends = effectsOf(out.effects, "send");
    expect(sends.map((s) => toHex(s.bytes))).toEqual([
      toHex(fieldCase("welcome.json", "welcome, bound").packet),
      toHex(fieldCase("gateway-settings.json", "gateway settings").packet),
    ]);
    expect(sends.map((s) => s.link)).toEqual([link, link]);
    expect(sends.map((s) => s.counters)).toEqual([
      [{ device: GATEWAY, counter: 1 }],
      [{ device: GATEWAY, counter: 2 }],
    ]);
    expect(decisionsIn(out.messages)).toEqual(["gateway_welcomed", "gateway_settings"]);
  });

  test("writes its counter now as the gateway's highest, before anything is sent", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    const writes = effectsOf(h.effects, "write").filter((w) => w.op.table === "device_state");
    const first = writes[0];
    expect(first?.durability).toBe("now");
    expect(
      first?.op.op === "upsert" && first.op.table === "device_state"
        ? first.op.row.window
        : undefined,
    ).toEqual(encodeReplayWindow({ highest: 1, seenBelow: 0n }));
  });

  test("the later connection vectors: welcome counter 30 and 31 with the hub randoms e0… and f0…", () => {
    for (const [helloName, welcomeName, counter, random] of [
      [
        "gateway hello on a later connection",
        "welcome answering the hello on later connection 1",
        30,
        0xe0,
      ],
      [
        "gateway hello with every version",
        "welcome answering the hello on later connection 2",
        31,
        0xf0,
      ],
    ] as const) {
      const h = new Harness();
      h.boot(snapshotWith({ sendCounters: [] }));
      const entry = h.state.gateways.gateways.get(GATEWAY);
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      const gateways = new Map(h.state.gateways.gateways);
      gateways.set(GATEWAY, {
        ...entry,
        counter: { step: 1024, next: counter, resumePoint: 1024 },
      });
      h.state = { ...h.state, gateways: { ...h.state.gateways, gateways } };
      const link = h.open(1);
      h.entropy = Uint8Array.from({ length: 8 }, (_, i) => random + i);
      const out = h.frame(link, fieldCase("hello.json", helloName).packet);
      expect(toHex(effectsOf(out.effects, "send")[0]?.bytes ?? new Uint8Array())).toBe(
        toHex(fieldCase("welcome.json", welcomeName).packet),
      );
    }
  });

  test("at or below the highest counter accepted is a replay: tooOld, counted, nothing sent", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    const link = h.open(2);
    for (const replay of [fieldCase("hello.json", "gateway hello").packet, hello(2, 0x11)]) {
      const out = h.frame(link, replay);
      expect(effectsOf(out.effects, "send")).toEqual([]);
      expect(ofKind(out.messages, "rejected").map((r) => r.reason)).toEqual(["tooOld"]);
    }
    // One above the highest (Started was 2) is a new connection.
    const fresh = h.frame(link, hello(3, 0x11));
    expect(effectsOf(fresh.effects, "send")).toHaveLength(2);
  });

  test("after a restart, the restored highest counter refuses a recorded hello", () => {
    const h = new Harness();
    h.boot(
      snapshotWith({
        deviceState: [
          {
            deviceId: GATEWAY,
            boot: 1 as never,
            lastSeenMono: 0 as never,
            lastSeenMs: 0,
            clockOk: true,
            window: encodeReplayWindow({ highest: 30, seenBelow: 0n }),
            reading: null,
            rssi: null,
            snrQ: null,
            bestGatewayId: null,
            uptimeS: 500,
            estimates: null,
          },
        ],
      }),
    );
    const link = h.open(1);
    const replayed = h.frame(
      link,
      fieldCase("hello.json", "gateway hello on a later connection").packet,
    );
    expect(ofKind(replayed.messages, "rejected").map((r) => r.reason)).toEqual(["tooOld"]);
    expect(effectsOf(replayed.effects, "send")).toEqual([]);
    expect(effectsOf(h.frame(link, hello(31, 0x22)).effects, "send")).toHaveLength(2);
  });
});

describe("proving a session", () => {
  test("its first session-bound packet proves it: gatewayUp, and its timer is cleared", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    const up = ofKind(h.messages, "gatewayUp");
    expect(up).toEqual([{ kind: "gatewayUp", gateway: GATEWAY, link: linkId(1) }]);
    expect(h.state.gateways.timers.filter((t) => t.key.kind === "unprovenSession")).toEqual([]);
    expect(h.state.gateways.gateways.get(GATEWAY)?.live?.binding).toEqual(SESSION);
  });

  test("unproven, the new link is closed after 10 s ‡, not before", () => {
    const h = new Harness();
    h.boot();
    const link = h.open(1);
    h.frame(link, hello(5000, 0x33));
    expect(effectsOf(h.advance(UNPROVEN_MS - 1).effects, "close")).toEqual([]);
    expect(effectsOf(h.advance(1).effects, "close")).toEqual([
      { kind: "close", link, reason: "gateway session not proven" },
    ]);
    expect(h.state.gateways.gateways.get(GATEWAY)?.candidates).toEqual([]);
  });

  test("a live session is kept for everything until the new one is proven, then its link is closed", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    const second = h.open(2);
    h.entropy = new Uint8Array(8).fill(0x44);
    h.frame(second, hello(3000, 0x55));
    const newSession = session(0x55, new Uint8Array(8).fill(0x44));
    // Still the old session: its statuses are accepted and the radio goes through link 1.
    expect(ofKind(h.frame(linkId(1), status(10, SESSION)).messages, "rejected")).toEqual([]);
    const radio = h.input({
      kind: "radioOut",
      ref: sendRef(7),
      device: deviceOf(SENSOR_ADDRESS),
      packet: new Uint8Array(30),
      counter: 5,
      gateway: GATEWAY,
      timing: { kind: "asap", latest: undefined },
      dataRate: 5,
      powerDbm: 22,
      priority: TransmitPriority.Normal,
      purpose: "eventReply",
    });
    expect(effectsOf(radio.effects, "send")[0]?.link).toBe(linkId(1));
    // The new session proves itself: the old link closes, its request gets "no result".
    const proof = h.frame(second, started(3001, newSession));
    expect(effectsOf(proof.effects, "close")).toEqual([
      { kind: "close", link: linkId(1), reason: "gateway session replaced" },
    ]);
    expect(ofKind(proof.messages, "radioResult").map((r) => [r.ref, r.outcome])).toEqual([
      [sendRef(7), TxOutcome.NoResult],
    ]);
    expect(ofKind(proof.messages, "gatewayUp")).toEqual([
      { kind: "gatewayUp", gateway: GATEWAY, link: second },
    ]);
    // The old session is gone: its packets now have no session to open under.
    expect(
      ofKind(h.frame(linkId(1), status(11, SESSION)).messages, "rejected").map((r) => r.reason),
    ).toEqual(["noSession"]);
  });

  test("a hello replayed on another link never takes over: the live session goes on, the stranger's link closes", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    const stranger = h.open(2);
    // A hello recorded but never delivered: its counter is above every one accepted.
    const out = h.frame(stranger, hello(4000, 0x66));
    expect(effectsOf(out.effects, "send")).toHaveLength(2);
    expect(effectsOf(h.advance(UNPROVEN_MS).effects, "close")).toEqual([
      { kind: "close", link: stranger, reason: "gateway session not proven" },
    ]);
    expect(h.state.gateways.gateways.get(GATEWAY)?.live?.link).toBe(linkId(1));
    expect(ofKind(h.frame(linkId(1), status(10, SESSION)).messages, "rejected")).toEqual([]);
  });

  test("with no live session several may wait, and the first proven wins", () => {
    const h = new Harness();
    h.boot();
    const a = h.open(1);
    const b = h.open(2);
    h.entropy = new Uint8Array(8).fill(0x01);
    h.frame(a, hello(2000, 0xa1));
    h.entropy = new Uint8Array(8).fill(0x02);
    h.frame(b, hello(2001, 0xb1));
    expect(h.state.gateways.gateways.get(GATEWAY)?.candidates).toHaveLength(2);
    const proof = h.frame(b, started(2002, session(0xb1, new Uint8Array(8).fill(0x02))));
    expect(effectsOf(proof.effects, "close")).toEqual([
      { kind: "close", link: a, reason: "gateway session replaced" },
    ]);
    expect(h.state.gateways.gateways.get(GATEWAY)?.live?.link).toBe(b);
    expect(h.state.gateways.timers.filter((t) => t.key.kind === "unprovenSession")).toEqual([]);
  });

  test("a restart on the same USB link replaces the session without closing the link", () => {
    const h = new Harness();
    connectVectors(h, linkId(1), "usb");
    h.entropy = new Uint8Array(8).fill(0x77);
    h.frame(linkId(1), hello(1024, 0x78));
    const proof = h.frame(linkId(1), started(1025, session(0x78, new Uint8Array(8).fill(0x77))));
    expect(effectsOf(proof.effects, "close")).toEqual([]);
    expect(h.state.gateways.gateways.get(GATEWAY)?.live?.binding).toEqual(
      session(0x78, new Uint8Array(8).fill(0x77)),
    );
  });
});

describe("the session counter", () => {
  test("must be above the last on the connection: a repeat is a duplicate, a lower one tooOld", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    expect(ofKind(h.frame(linkId(1), status(10, SESSION)).messages, "rejected")).toEqual([]);
    expect(
      ofKind(h.frame(linkId(1), status(10, SESSION)).messages, "rejected").map((r) => r.reason),
    ).toEqual(["duplicate"]);
    expect(
      ofKind(h.frame(linkId(1), status(9, SESSION)).messages, "rejected").map((r) => r.reason),
    ).toEqual(["tooOld"]);
    expect(ofKind(h.frame(linkId(1), status(11, SESSION)).messages, "rejected")).toEqual([]);
  });

  test("a rejected packet changes nothing: no record, no accepted, the same state", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    h.frame(linkId(1), status(10, SESSION));
    const before = h.state;
    const out = h.frame(linkId(1), status(10, SESSION));
    expect(out.messages.map((m) => m.kind)).toEqual(["gatewayPacket", "rejected"]);
    expect(out.effects).toEqual([]);
    expect(h.state.gateways).toBe(before.gateways);
    expect(h.state.links).toBe(before.links);
  });

  test("a packet on a link with no session is noSession; one from an earlier connection on the live link is badTag", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    const other = h.open(2);
    expect(
      ofKind(h.frame(other, status(10, SESSION)).messages, "rejected").map((r) => r.reason),
    ).toEqual(["noSession"]);
    const old = h.frame(linkId(1), status(11, session(0x99, new Uint8Array(8).fill(0x98))));
    expect(ofKind(old.messages, "rejected").map((r) => r.reason)).toEqual(["badTag"]);
  });

  test("a type a gateway does not send on its session is wrongPath", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    const heartbeatType = toHub(
      GATEWAY_ADDRESS,
      {
        type: MessageType.Heartbeat,
        settingsVersion: 1,
        flags: {
          doorOpen: false,
          coverOpen: false,
          usbPower: false,
          charging: false,
          replyWanted: false,
          localAlarmSounded: false,
          buzzing: false,
          listeningAtSendRate: false,
        },
        batteryCode: 100,
        temperatureCelsius: 20,
        doorChangeCount: 0,
        eventAgeSeconds: 0,
      },
      10,
      SESSION,
    );
    expect(
      ofKind(h.frame(linkId(1), heartbeatType).messages, "rejected").map((r) => r.reason),
    ).toEqual(["wrongPath"]);
    const helloOnSession = toHub(
      GATEWAY_ADDRESS,
      {
        type: MessageType.Hello,
        gatewayRandom: new Uint8Array(8),
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        settingsVersion: 1,
      },
      11,
      SESSION,
    );
    expect(
      ofKind(h.frame(linkId(1), helloOnSession).messages, "rejected").map((r) => r.reason),
    ).toEqual(["wrongPath"]);
  });
});

describe("a closed link", () => {
  test("ends its live session: gatewayDown, and every request in flight gets no result", () => {
    const h = new Harness();
    connectVectors(h, linkId(1));
    h.input({
      kind: "radioOut",
      ref: sendRef(3),
      device: deviceOf(SENSOR_ADDRESS),
      packet: new Uint8Array(30),
      counter: 5,
      gateway: GATEWAY,
      timing: { kind: "asap", latest: undefined },
      dataRate: 5,
      powerDbm: 22,
      priority: TransmitPriority.Normal,
      purpose: "disarmedNotice",
    });
    const out = h.input({ kind: "linkClosed", link: linkId(1), reason: "remote" });
    expect(ofKind(out.messages, "gatewayDown")).toEqual([
      { kind: "gatewayDown", gateway: GATEWAY },
    ]);
    expect(ofKind(out.messages, "radioResult").map((r) => [r.ref, r.outcome])).toEqual([
      [sendRef(3), TxOutcome.NoResult],
    ]);
    expect(h.state.gateways.gateways.get(GATEWAY)?.live).toBeUndefined();
    expect(h.state.gateways.timers.filter((t) => t.key.kind === "transmitResult")).toEqual([]);
  });
});

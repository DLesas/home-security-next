/**
 * The scripted gateway against the protocol's vectors and its own radio model (hub-design.md
 * section 11): its hello, Started and forwarded packet are the vector files' exact bytes when
 * given the vectors' values, it takes the vectors' welcome, settings and transmit request, and
 * its radio answers "sent", "too late" and "radio busy" as §6 says.
 */
import { describe, expect, test } from "bun:test";
import {
  counterBinding,
  Direction,
  fromHex,
  MaxPacketLength,
  type Message,
  MessageType,
  openPacket,
  sealPacket,
  sessionBinding,
  timeOnAirMs,
  toHex,
  TransmitPriority,
  TransmitResultCode,
  TransmitWhen,
} from "@hsn/protocol";
import { mono } from "../../src/core/model/time.ts";
import { ScriptedGateway } from "./scripted-gateway.ts";
import { vectorsOf } from "./vectors.ts";

const [hello] = vectorsOf("hello.json");
const [welcome] = vectorsOf("welcome.json");
const [settings] = vectorsOf("gateway-settings.json");
const [forwarded] = vectorsOf("forwarded-packet.json");
const [transmitRequest] = vectorsOf("transmit-request.json");
const startedOnConnection = vectorsOf("started.json").find((v) =>
  v.name.startsWith("gateway started"),
);
const [heartbeat] = vectorsOf("heartbeat.json");

const GATEWAY_KEY = fromHex("202122232425262728292a2b2c2d2e2f");
const GATEWAY_ADDRESS = 0x92a3b4c5;
const GATEWAY_RANDOM = fromHex("a0a1a2a3a4a5a6a7");
const HUB_RANDOM = fromHex("b0b1b2b3b4b5b6b7");
/** The forwarded vector's arrival time; the gateway's clock reads it at hub time 0. */
const RECEIVED_AT = 3735928559;

function vectorGateway(options: { drift?: number; radioPlaces?: number } = {}): ScriptedGateway {
  return new ScriptedGateway({
    key: GATEWAY_KEY,
    address: GATEWAY_ADDRESS,
    nextRandom: () => GATEWAY_RANDOM,
    firmware: { major: 1, minor: 0, patch: 0 },
    settingsVersion: 1,
    resetCause: 3,
    clockOffsetMicros: RECEIVED_AT,
    ...options,
  });
}

/** A packet from the hub to the gateway on the vectors' session. */
function fromHub(message: Message, counter: number): Uint8Array {
  return sealPacket(message, {
    key: GATEWAY_KEY,
    direction: Direction.FromHub,
    address: GATEWAY_ADDRESS,
    counter,
    binding: sessionBinding(GATEWAY_RANDOM, HUB_RANDOM),
    maxLength: MaxPacketLength.Link,
  });
}

/** Opens what the gateway sent, as the hub would. */
function openFromGateway(packet: Uint8Array | undefined): Message | undefined {
  if (packet === undefined) return undefined;
  const opened = openPacket(packet, {
    key: GATEWAY_KEY,
    expectedDirection: Direction.ToHub,
    binding: sessionBinding(GATEWAY_RANDOM, HUB_RANDOM),
    maxLength: MaxPacketLength.Link,
  });
  return opened.ok ? opened.value.message : undefined;
}

/** A gateway with the vectors' session: hello, welcome and settings taken. */
function connected(options: { drift?: number; radioPlaces?: number } = {}): ScriptedGateway {
  const gateway = vectorGateway(options);
  gateway.hello();
  gateway.receive(welcome?.packet ?? new Uint8Array(), mono(0));
  gateway.receive(settings?.packet ?? new Uint8Array(), mono(0));
  return gateway;
}

describe("the scripted gateway against the vectors", () => {
  test("its connection is the vectors' bytes: hello, then Started after the settings, then a forwarded packet", () => {
    const gateway = vectorGateway();
    expect(toHex(gateway.hello() ?? new Uint8Array())).toBe(
      toHex(hello?.packet ?? new Uint8Array()),
    );
    expect(gateway.receive(welcome?.packet ?? new Uint8Array(), mono(0))).toEqual([]);
    expect(gateway.session).toEqual(sessionBinding(GATEWAY_RANDOM, HUB_RANDOM));
    const answer = gateway.receive(settings?.packet ?? new Uint8Array(), mono(0));
    expect(answer.map(toHex)).toEqual([toHex(startedOnConnection?.packet ?? new Uint8Array())]);
    expect(gateway.settings?.settingsVersion).toBe(1);
    const packet = gateway.forward(heartbeat?.packet ?? new Uint8Array(), {
      endedAt: mono(0),
      rssiDbm: -120,
      snrQuarterDb: -30,
      dataRate: 2,
      siteChannel: 1,
    });
    expect(toHex(packet ?? new Uint8Array())).toBe(toHex(forwarded?.packet ?? new Uint8Array()));
  });

  test("takes the vectors' transmit request and answers it with its counter", () => {
    const gateway = connected();
    const results = gateway.receive(transmitRequest?.packet ?? new Uint8Array(), mono(0));
    expect(results.map(openFromGateway)).toEqual([
      {
        type: MessageType.TransmitResult,
        requestCounter: transmitRequest?.counter ?? 0,
        result: TransmitResultCode.Sent,
        sentAtMicros: RECEIVED_AT,
      },
    ]);
    expect(gateway.transmissions).toHaveLength(1);
  });

  test("drops a replayed packet from the hub (strictly higher, §4)", () => {
    const gateway = connected();
    expect(gateway.receive(settings?.packet ?? new Uint8Array(), mono(0))).toEqual([]);
  });

  test("forwards nothing before it has a session", () => {
    expect(
      vectorGateway().forward(new Uint8Array(18), {
        endedAt: mono(0),
        rssiDbm: 0,
        snrQuarterDb: 0,
        dataRate: 5,
        siteChannel: 1,
      }),
    ).toBeUndefined();
  });
});

describe("the scripted gateway's radio", () => {
  const reply = fromHex("184d3c2b1a090000003030e8f23c575152ba80f0a22a7f8d62ca4448454b");
  /** The reply's airtime at DR5: 71.936 ms (§2, 72 ms rounded). */
  const replyAirtime = Math.ceil(timeOnAirMs(7, reply.length) * 1000);
  const request = (when: number, gatewayTimeMicros: number, counter: number) =>
    fromHub(
      {
        type: MessageType.TransmitRequest,
        when,
        gatewayTimeMicros,
        dataRate: 5,
        powerDbm: 22,
        priority: TransmitPriority.Normal,
        packet: reply,
      },
      counter,
    );
  const results = (packets: readonly Uint8Array[]) =>
    packets
      .map(openFromGateway)
      .map((m) => (m?.type === MessageType.TransmitResult ? m.result : undefined));

  test("sends at the given time, and reports it then", () => {
    const gateway = connected();
    const at = RECEIVED_AT + 1_000_000;
    expect(gateway.receive(request(TransmitWhen.AtTime, at, 10), mono(0))).toEqual([]);
    expect(gateway.nextWake()).toBe(mono(1_000_000));
    expect(results(gateway.wake(mono(1_000_000)))).toEqual([TransmitResultCode.Sent]);
    expect(gateway.transmissions[0]?.startMicros).toBe(at);
  });

  test("a request for a given time that the busy radio would start over 20 ms late is too late", () => {
    const gateway = connected();
    const at = RECEIVED_AT + 1_000_000;
    gateway.receive(request(TransmitWhen.AtTime, at, 10), mono(0));
    // The first reply takes about 72 ms at DR5 (§2), so one 30 ms later starts 42 ms late.
    gateway.receive(request(TransmitWhen.AtTime, at + 30_000, 11), mono(0));
    // One 60 ms later starts 12 ms late, within the 20 ms.
    gateway.receive(request(TransmitWhen.AtTime, at + 60_000, 12), mono(0));
    expect(results(gateway.wake(mono(2_000_000)))).toEqual([
      TransmitResultCode.Sent,
      TransmitResultCode.TooLate,
      TransmitResultCode.Sent,
    ]);
    expect(gateway.transmissions.map((t) => t.startMicros - at)).toEqual([0, replyAirtime]);
  });

  test("a moment already past: within 20 ms it is sent at once, beyond that too late at once", () => {
    const gateway = connected();
    const now = mono(1_000_000);
    const nowMicros = gateway.clockMicros(now);
    expect(
      results(gateway.receive(request(TransmitWhen.AtTime, nowMicros - 10_000, 10), now)),
    ).toEqual([TransmitResultCode.Sent]);
    expect(gateway.transmissions[0]?.startMicros).toBe(nowMicros);
    const later = mono(2_000_000);
    const laterMicros = gateway.clockMicros(later);
    expect(
      results(gateway.receive(request(TransmitWhen.AtTime, laterMicros - 30_000, 11), later)),
    ).toEqual([TransmitResultCode.TooLate]);
    expect(gateway.transmissions).toHaveLength(1);
    expect(gateway.nextWake()).toBeUndefined();
  });

  test("as soon as possible waits for the radio, unless that passes its latest moment", () => {
    const gateway = connected();
    const first = gateway.receive(request(TransmitWhen.AsSoonAsPossible, 0, 10), mono(0));
    expect(results(first)).toEqual([TransmitResultCode.Sent]);
    // The radio is busy for 72 ms, past the second's latest moment 10 ms from now.
    const late = gateway.receive(
      request(TransmitWhen.AsSoonAsPossible, RECEIVED_AT + 10_000, 11),
      mono(0),
    );
    expect(late).toEqual([]);
    expect(gateway.nextWake()).toBe(mono(replyAirtime));
    expect(results(gateway.wake(mono(100_000)))).toEqual([TransmitResultCode.TooLate]);
  });

  test("with every place taken, a request is answered radio busy at once", () => {
    const gateway = connected({ radioPlaces: 1 });
    gateway.receive(request(TransmitWhen.AtTime, RECEIVED_AT + 1_000_000, 10), mono(0));
    expect(
      results(gateway.receive(request(TransmitWhen.AtTime, RECEIVED_AT + 2_000_000, 11), mono(0))),
    ).toEqual([TransmitResultCode.RadioBusy]);
  });

  test("its clock drifts against the hub's", () => {
    const gateway = connected({ drift: 0.0001 });
    expect(gateway.clockMicros(mono(10_000_000)) - RECEIVED_AT).toBe(10_001_000);
    expect(gateway.hubTimeAt(RECEIVED_AT + 10_001_000)).toBe(mono(10_000_000));
  });

  test("a transmit request's packet is bound to the session: one sealed for another binding is dropped", () => {
    const gateway = connected();
    const wrong = sealPacket(
      {
        type: MessageType.TransmitRequest,
        when: 1,
        gatewayTimeMicros: 0,
        dataRate: 5,
        powerDbm: 22,
        priority: 0,
        packet: reply,
      },
      {
        key: GATEWAY_KEY,
        direction: Direction.FromHub,
        address: GATEWAY_ADDRESS,
        counter: 50,
        binding: counterBinding(1),
        maxLength: MaxPacketLength.Link,
      },
    );
    expect(gateway.receive(wrong, mono(0))).toEqual([]);
    expect(gateway.transmissions).toEqual([]);
  });
});

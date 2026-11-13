/**
 * Sending by radio (hub-design.md sections 4, 7 and 8; protocol.md §6): which gateway each
 * `radioOut` goes through, its moment, the two counters, a resume point written now, the
 * deadline for its result and "no result" after it, results and `sendFailed` handed back.
 */
import { describe, expect, test } from "bun:test";
import {
  MessageType,
  openPacket,
  Direction,
  MaxPacketLength,
  sessionBinding,
  TransmitPriority,
  TransmitResultCode,
  TransmitWhen,
} from "@hsn/protocol";
import type { Internal } from "../../../src/core/model/messages.ts";
import { type DeviceId, linkId, sendRef } from "../../../src/core/model/ids.ts";
import { TxOutcome } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import type { GatewayEntry } from "../../../src/core/gateways/state.ts";
import {
  connectVectors,
  decisionsIn,
  deviceOf,
  effectsOf,
  GATEWAY_ADDRESS,
  GATEWAY_KEY,
  GATEWAY_RANDOM,
  Harness,
  HUB_RANDOM,
  ofKind,
  SECOND,
  SENSOR_ADDRESS,
  toHub,
} from "./harness.ts";

const GATEWAY = deviceOf(GATEWAY_ADDRESS);
const SENSOR = deviceOf(SENSOR_ADDRESS);
const LINK = linkId(1);
const SESSION = sessionBinding(GATEWAY_RANDOM, HUB_RANDOM);
const { resultGraceMs, resultNoLimitMs } = DEFAULT_RULES.gateways;
const OFFSET = 7_000_000;

type RadioOut = Extract<Internal, { readonly kind: "radioOut" }>;

function radioOut(overrides: Partial<RadioOut> = {}): RadioOut {
  return {
    kind: "radioOut",
    ref: sendRef(1),
    device: SENSOR,
    packet: new Uint8Array(32).fill(0x18),
    counter: 9410,
    gateway: GATEWAY,
    timing: { kind: "asap", latest: undefined },
    dataRate: 5,
    powerDbm: 22,
    priority: TransmitPriority.Normal,
    purpose: "eventReply",
    ...overrides,
  };
}

/** A harness on the vectors' session, its clock mapping hub = gateway + OFFSET. */
function connected(change: (entry: GatewayEntry) => GatewayEntry = (e) => e): Harness {
  const h = new Harness();
  connectVectors(h, LINK);
  const entry = h.state.gateways.gateways.get(GATEWAY);
  if (entry === undefined) return h;
  const mapped: GatewayEntry = {
    ...entry,
    live:
      entry.live === undefined
        ? undefined
        : { ...entry.live, clock: { samples: [OFFSET], offset: OFFSET } },
  };
  const gateways = new Map(h.state.gateways.gateways);
  gateways.set(GATEWAY, change(mapped));
  h.state = { ...h.state, gateways: { ...h.state.gateways, gateways } };
  return h;
}

/** The transmit request a send carries, opened as the gateway would. */
function requestOf(bytes: Uint8Array | undefined) {
  const opened = openPacket(bytes ?? new Uint8Array(), {
    key: GATEWAY_KEY,
    expectedDirection: Direction.FromHub,
    binding: SESSION,
    maxLength: MaxPacketLength.Link,
  });
  return opened.ok && opened.value.message.type === MessageType.TransmitRequest
    ? { counter: opened.value.header.counter, ...opened.value.message }
    : undefined;
}

function result(
  requestCounter: number,
  code: number,
  counter: number,
  sentAtMicros = 123,
): Uint8Array {
  return toHub(
    GATEWAY_ADDRESS,
    { type: MessageType.TransmitResult, requestCounter, result: code, sentAtMicros },
    counter,
    SESSION,
  );
}

function deadlineOf(h: Harness): Mono | undefined {
  return h.state.gateways.timers.find((t) => t.key.kind === "transmitResult")?.at;
}

describe("the moment, rate, power and priority", () => {
  test("a heartbeat reply goes at its given time on the delivering gateway's clock", () => {
    const h = connected();
    const out = h.input(
      radioOut({
        purpose: "heartbeatReply",
        timing: { kind: "at", gateway: GATEWAY, gatewayMicros: 500_000_000 + 1_000_000 },
        dataRate: 3,
        powerDbm: 20,
      }),
    );
    const request = requestOf(effectsOf(out.effects, "send")[0]?.bytes);
    expect(request).toMatchObject({
      when: TransmitWhen.AtTime,
      gatewayTimeMicros: 501_000_000,
      dataRate: 3,
      powerDbm: 20,
      priority: TransmitPriority.Normal,
    });
    // Its result is due 5 s ‡ after that moment on the hub's clock.
    expect(deadlineOf(h)).toBe(mono(501_000_000 + OFFSET + resultGraceMs * 1000));
  });

  test("an event reply goes as soon as possible, its latest moment converted to the gateway's clock", () => {
    const h = connected();
    const latest = mono(OFFSET + 2_000_000);
    const out = h.input(radioOut({ timing: { kind: "asap", latest } }));
    expect(requestOf(effectsOf(out.effects, "send")[0]?.bytes)).toMatchObject({
      when: TransmitWhen.AsSoonAsPossible,
      gatewayTimeMicros: 2_000_000,
    });
    expect(deadlineOf(h)).toBe(mono(latest + resultGraceMs * 1000));
  });

  test("with no limit the latest moment is 0 and the result is due 10 s ‡ after the request", () => {
    const h = connected();
    h.now = mono(3 * SECOND);
    const out = h.input(radioOut({ purpose: "disarmedNotice" }));
    expect(requestOf(effectsOf(out.effects, "send")[0]?.bytes)).toMatchObject({
      when: TransmitWhen.AsSoonAsPossible,
      gatewayTimeMicros: 0,
    });
    expect(deadlineOf(h)).toBe(mono(3 * SECOND + resultNoLimitMs * 1000));
  });

  test("a siren command keeps its siren priority and power", () => {
    const h = connected();
    const out = h.input(
      radioOut({ purpose: "sirenCommand", priority: TransmitPriority.SirenCommand, powerDbm: 21 }),
    );
    expect(requestOf(effectsOf(out.effects, "send")[0]?.bytes)).toMatchObject({
      priority: TransmitPriority.SirenCommand,
      powerDbm: 21,
    });
  });

  test("a latest moment that lands on 0 goes one microsecond earlier, never meaning 'no limit'", () => {
    const h = connected();
    const out = h.input(radioOut({ timing: { kind: "asap", latest: mono(OFFSET + 2 ** 32) } }));
    expect(requestOf(effectsOf(out.effects, "send")[0]?.bytes)?.gatewayTimeMicros).toBe(
      2 ** 32 - 1,
    );
  });
});

describe("the two counters", () => {
  test("the send names the gateway's counter and the device packet's, and each request takes a new gateway counter", () => {
    const h = connected();
    const first = effectsOf(h.input(radioOut({ ref: sendRef(1) })).effects, "send")[0];
    const second = effectsOf(h.input(radioOut({ ref: sendRef(2) })).effects, "send")[0];
    expect(first?.counters).toEqual([
      { device: GATEWAY, counter: 3 },
      { device: SENSOR, counter: 9410 },
    ]);
    expect(second?.counters).toEqual([
      { device: GATEWAY, counter: 4 },
      { device: SENSOR, counter: 9410 },
    ]);
  });

  test("a gateway counter that is a multiple of 1,024 writes counter + 1,024 now, before the send", () => {
    const h = connected((e) => ({
      ...e,
      counter: { step: 1024, next: 61_440, resumePoint: 61_440 },
    }));
    const out = h.input(radioOut());
    const writes = effectsOf(out.effects, "write").filter((w) => w.op.table === "send_counters");
    expect(writes).toEqual([
      {
        kind: "write",
        durability: "now",
        op: {
          table: "send_counters",
          op: "upsert",
          row: { deviceId: GATEWAY, resumePoint: 62_464 },
        },
      },
    ]);
    expect(out.effects.findIndex((e) => e.kind === "write")).toBeLessThan(
      out.effects.findIndex((e) => e.kind === "send"),
    );
    // The next one asks for nothing.
    expect(effectsOf(h.input(radioOut({ ref: sendRef(2) })).effects, "write")).toEqual([]);
  });
});

describe("which gateway", () => {
  test("a heartbeat reply whose gateway is gone is skipped: no result, nothing sent", () => {
    const h = connected();
    h.input({ kind: "linkClosed", link: LINK, reason: "remote" });
    const out = h.input(
      radioOut({
        purpose: "heartbeatReply",
        timing: { kind: "at", gateway: GATEWAY, gatewayMicros: 5 },
      }),
    );
    expect(effectsOf(out.effects, "send")).toEqual([]);
    expect(ofKind(out.messages, "radioResult").map((r) => [r.outcome, r.gateway])).toEqual([
      [TxOutcome.NoResult, GATEWAY],
    ]);
    expect(decisionsIn(out.messages)).toEqual([]);
  });

  test("with no gateway at all: decision no_path and no result", () => {
    const h = new Harness();
    h.boot();
    const out = h.input(radioOut());
    expect(decisionsIn(out.messages)).toEqual(["no_path"]);
    expect(ofKind(out.messages, "radioResult").map((r) => [r.outcome, r.gateway])).toEqual([
      [TxOutcome.NoResult, undefined],
    ]);
  });
});

describe("results", () => {
  test("a result goes back to the request's module with its outcome; sent carries the gateway's time", () => {
    for (const [code, outcome] of [
      [TransmitResultCode.Sent, TxOutcome.Sent],
      [TransmitResultCode.TooLate, TxOutcome.TooLate],
      [TransmitResultCode.NoAirtimeLeft, TxOutcome.NoAirtime],
      [TransmitResultCode.RadioBusy, TxOutcome.RadioBusy],
      [TransmitResultCode.NotValid, TxOutcome.NotValid],
      [9, TxOutcome.NoResult],
    ] as const) {
      const h = connected();
      h.input(radioOut({ ref: sendRef(5) }));
      const out = h.frame(LINK, result(3, code, 10, 4242));
      expect(ofKind(out.messages, "radioResult")).toEqual([
        {
          kind: "radioResult",
          ref: sendRef(5),
          device: SENSOR,
          gateway: GATEWAY,
          requestCounter: 3,
          outcome,
          sentGatewayMicros: outcome === TxOutcome.Sent ? 4242 : undefined,
        },
      ]);
      // The outcome is on the packet's tx row, which its module writes: no decision.
      expect(decisionsIn(out.messages)).toEqual([]);
      expect(h.state.gateways.timers.filter((t) => t.key.kind === "transmitResult")).toEqual([]);
    }
  });

  test("a result for no request in flight changes nothing", () => {
    const h = connected();
    const out = h.frame(LINK, result(99, TransmitResultCode.Sent, 10));
    expect(ofKind(out.messages, "radioResult")).toEqual([]);
  });

  test("no result by the deadline is 'no result', once; a late result afterwards is ignored", () => {
    const h = connected();
    h.input(radioOut({ ref: sendRef(6) }));
    expect(ofKind(h.advance(resultNoLimitMs - 1).messages, "radioResult")).toEqual([]);
    const timedOut = h.advance(1);
    expect(ofKind(timedOut.messages, "radioResult").map((r) => [r.ref, r.outcome])).toEqual([
      [sendRef(6), TxOutcome.NoResult],
    ]);
    expect(
      ofKind(h.frame(LINK, result(3, TransmitResultCode.Sent, 10)).messages, "radioResult"),
    ).toEqual([]);
  });

  test("a send the shell did not make goes back: held back by the gate, or failed", () => {
    for (const [error, outcome] of [
      ["notDurable", TxOutcome.HeldBack],
      ["queueFull", TxOutcome.SendFailed],
      ["closed", TxOutcome.SendFailed],
    ] as const) {
      const h = connected();
      h.input(radioOut({ ref: sendRef(8) }));
      const out = h.input({ kind: "sendFailed", link: LINK, ref: sendRef(8), error });
      expect(ofKind(out.messages, "radioResult").map((r) => [r.ref, r.outcome])).toEqual([
        [sendRef(8), outcome],
      ]);
      expect(h.state.gateways.gateways.get(GATEWAY)?.requests).toEqual([]);
    }
  });

  test("a sendFailed for another link's ref is not this request's", () => {
    const h = connected();
    h.input(radioOut({ ref: sendRef(8) }));
    const out = h.input({ kind: "sendFailed", link: linkId(9), ref: sendRef(8), error: "closed" });
    expect(ofKind(out.messages, "radioResult")).toEqual([]);
  });
});

export type { DeviceId };

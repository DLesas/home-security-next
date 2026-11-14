/**
 * The gateway vectors through the handlers (hub-design.md section 11, "Unit tests of the core,
 * against the protocol's vectors"): every hello, forwarded-packet, gateway-status,
 * transmit-result and interference case opened into its fields; every welcome, transmit-request
 * and gateway-settings case the hub can make produced byte for byte; every rejected case from
 * the gateway's address counted with its reason and not acted on.
 */
import { describe, expect, test } from "bun:test";
import { toHex, TransmitPriority } from "@hsn/protocol";
import { linkId, sendRef } from "../../../src/core/model/ids.ts";
import { TxOutcome } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import type { GatewayEntry } from "../../../src/core/gateways/state.ts";
import {
  connectVectors,
  decisionsIn,
  deviceOf,
  effectsOf,
  fieldCase,
  fieldCases,
  GATEWAY_ADDRESS,
  Harness,
  HUB_RANDOM,
  ofKind,
  rejectedCases,
  SENSOR_ADDRESS,
  snapshotWith,
} from "./harness.ts";

const GATEWAY = deviceOf(GATEWAY_ADDRESS);
const LINK = linkId(1);

/** A harness on the vectors' session, with the gateway's entry changed by `change`. */
function onSession(change: (entry: GatewayEntry) => GatewayEntry = (e) => e): Harness {
  const h = new Harness();
  connectVectors(h, LINK);
  const entry = h.state.gateways.gateways.get(GATEWAY);
  expect(entry).toBeDefined();
  if (entry === undefined) return h;
  const gateways = new Map(h.state.gateways.gateways);
  gateways.set(GATEWAY, change(entry));
  h.state = { ...h.state, gateways: { ...h.state.gateways, gateways } };
  return h;
}

function withCounter(next: number): (entry: GatewayEntry) => GatewayEntry {
  return (entry) => ({ ...entry, counter: { step: 1024, next, resumePoint: 1024 } });
}

describe("packets from the gateway, opened into their fields", () => {
  test("every hello case opens a session with the case's random, its counter the highest", () => {
    for (const c of fieldCases("hello.json")) {
      const h = new Harness();
      h.boot(snapshotWith({ sendCounters: [] }));
      const link = h.open(1);
      h.entropy = HUB_RANDOM;
      const out = h.frame(link, c.packet);
      const entry = h.state.gateways.gateways.get(GATEWAY);
      expect(entry?.candidates.map((s) => toHex(s.gatewayRandom))).toEqual([
        String(c.fields.gatewayRandom),
      ]);
      expect(entry?.highestAccepted).toBe(c.counter);
      const accepted = ofKind(out.messages, "accepted")[0];
      expect(accepted?.message as unknown).toEqual({
        type: 0x20,
        gatewayRandom: Uint8Array.from(Buffer.from(String(c.fields.gatewayRandom), "hex")),
        firmwareVersion: c.fields.firmwareVersion,
        settingsVersion: c.fields.settingsVersion,
      });
      expect(effectsOf(out.effects, "send")).toHaveLength(2);
    }
  });

  test("every forwarded-packet case becomes a device packet with the gateway's fields", () => {
    for (const c of fieldCases("forwarded-packet.json")) {
      const h = onSession();
      const out = h.frame(LINK, c.packet);
      const device = ofKind(out.messages, "devicePacket");
      expect(device).toHaveLength(1);
      const { bytes, arrival } = device[0] ?? { bytes: new Uint8Array(), arrival: undefined };
      expect(toHex(bytes)).toBe(String(c.fields.packet));
      expect(arrival).toMatchObject({
        path: "lora",
        gateway: GATEWAY,
        link: LINK,
        gatewayCounter: c.counter,
        gatewayMicros: c.fields.receivedAtMicros,
        rssiDbm: c.fields.rssiDbm,
        snrQuarterDb: c.fields.snrQuarterDb,
        dataRate: c.fields.dataRate,
        siteChannel: c.fields.siteChannel,
      });
      // The first packet of a session fixes its mapping: it ended when it arrived.
      expect(arrival?.path === "lora" ? arrival.endedAt : undefined).toBe(h.now);
    }
  });

  test("every gateway-status case is recorded with its fields and kept as the reading", () => {
    for (const c of fieldCases("gateway-status.json")) {
      const h = onSession();
      const out = h.frame(LINK, c.packet);
      expect(ofKind(out.messages, "rejected")).toEqual([]);
      const status = h.state.gateways.gateways.get(GATEWAY)?.status;
      expect(status).toMatchObject({
        settingsVersion: c.fields.settingsVersion,
        uptimeSeconds: c.fields.uptimeSeconds,
        airtimeHundredthsPercent: c.fields.airtimeHundredthsPercent,
        noiseMedianDbm: c.fields.noiseMedianDbm,
        noiseHighestDbm: c.fields.noiseHighestDbm,
        normalNoiseDbm: c.fields.normalNoiseDbm,
        packetsReceived: c.fields.packetsReceived,
        packetsCrcFailed: c.fields.packetsCrcFailed,
      });
      const accepted = ofKind(out.messages, "accepted")[0];
      expect(accepted?.message as unknown).toEqual({ type: 0x22, ...c.fields });
      const rx = ofKind(out.messages, "auditRecord").find((r) => r.record.kind === "rx");
      expect(rx?.record.kind === "rx" ? [rx.record.table, rx.record.row.counter] : []).toEqual([
        "routine",
        c.counter,
      ]);
    }
  });

  test("every transmit-result case resolves its request with its outcome and sent time", () => {
    for (const c of fieldCases("transmit-result.json")) {
      const requestCounter = Number(c.fields.requestCounter);
      const h = onSession((e) => ({
        ...e,
        requests: [
          {
            ref: sendRef(9),
            device: deviceOf(SENSOR_ADDRESS),
            requestCounter,
            link: LINK,
            purpose: "eventReply",
            deadline: mono(60_000_000),
          },
        ],
      }));
      const out = h.frame(LINK, c.packet);
      const result = Number(c.fields.result);
      const outcome = result <= 4 ? result : TxOutcome.NoResult;
      expect(ofKind(out.messages, "radioResult") as unknown).toEqual([
        {
          kind: "radioResult",
          ref: sendRef(9),
          device: deviceOf(SENSOR_ADDRESS),
          gateway: GATEWAY,
          requestCounter: c.fields.requestCounter,
          // The result packet's own counter, for the tx row (D110).
          resultCounter: c.counter,
          outcome,
          sentGatewayMicros: outcome === TxOutcome.Sent ? c.fields.sentAtMicros : undefined,
        },
      ]);
      expect(h.state.gateways.gateways.get(GATEWAY)?.requests).toEqual([]);
    }
  });

  test("every interference case is recorded; started and ended are decisions written now", () => {
    const expected: Record<string, readonly string[]> = {
      "interference started": ["interference_started"],
      "interference ended": ["interference_ended"],
      "interference with unlisted event 2, which passes through": [],
    };
    for (const c of fieldCases("interference.json")) {
      const h = onSession();
      const out = h.frame(LINK, c.packet);
      expect(decisionsIn(out.messages)).toEqual(expected[c.name] ?? ["?"]);
      for (const d of ofKind(out.messages, "auditRecord")) {
        if (d.record.kind !== "decision") continue;
        expect(d.durability).toBe("now");
        expect(d.record.row.value).toBe(Number(c.fields.noiseDbm));
      }
      expect(ofKind(out.messages, "accepted")[0]?.message as unknown).toEqual({
        type: 0x24,
        ...c.fields,
      });
    }
  });

  test("the gateway's log entries become one device_log row each, warnings and worse now", () => {
    for (const c of fieldCases("log-entries.json").filter((v) => v.address === GATEWAY_ADDRESS)) {
      const h = onSession();
      const out = h.frame(LINK, c.packet);
      const rows = ofKind(out.messages, "auditRecord").flatMap((r) =>
        r.record.kind === "deviceLog" ? [{ durability: r.durability, row: r.record.row }] : [],
      );
      const entries = c.fields.entries as readonly {
        level: number;
        code: number;
        ageTenths: number;
      }[];
      expect(rows.map((r) => [r.row.level, r.row.code, r.row.madeMs])).toEqual(
        entries.map((e) => [e.level, e.code, h.wall - e.ageTenths * 100]),
      );
      expect(rows.map((r) => r.durability)).toEqual(
        entries.map((e) => (e.level >= 2 ? "now" : "routine")),
      );
      expect(rows.every((r) => r.row.repeatOf === null && r.row.counter === c.counter)).toBe(true);
    }
  });
});

describe("packets to the gateway, byte for byte", () => {
  test("the welcome and settings of the first connection (also in sessions.test.ts)", () => {
    const h = new Harness();
    connectVectors(h, LINK);
    expect(effectsOf(h.effects, "send").map((s) => toHex(s.bytes))).toEqual([
      toHex(fieldCase("welcome.json", "welcome, bound").packet),
      toHex(fieldCase("gateway-settings.json", "gateway settings").packet),
    ]);
  });

  test("the other gateway-settings cases, sent when a status names another version", () => {
    const cases = [
      {
        name: "gateway settings with negative",
        counter: 3,
        config: {
          version: 2,
          statusIntervalS: 255,
          interferenceDb: 0,
          interferenceS: 255,
          defaultPowerDbm: -9,
          sirenPowerDbm: -128,
        },
        site: { channel: 2, rateMask: 1 },
      },
      {
        name: "gateway settings with unlisted",
        counter: 4,
        config: {
          version: 3,
          statusIntervalS: 30,
          interferenceDb: 10,
          interferenceS: 30,
          defaultPowerDbm: 14,
          sirenPowerDbm: 22,
        },
        site: { channel: 3, rateMask: 192 },
      },
    ];
    for (const c of cases) {
      const h = onSession((e) => ({ ...withCounter(c.counter)(e), config: c.config }));
      h.state = {
        ...h.state,
        gateways: { ...h.state.gateways, site: { ...h.state.gateways.site, ...c.site } },
      };
      const out = h.frame(LINK, fieldCase("gateway-status.json", "gateway status on Wi-Fi").packet);
      expect(effectsOf(out.effects, "send").map((s) => toHex(s.bytes))).toEqual([
        toHex(fieldCase("gateway-settings.json", c.name).packet),
      ]);
    }
  });

  test("the transmit-request cases a radioOut can ask for", () => {
    const offset = 5_000_000;
    const cases = [
      {
        name: "transmit request: a reply as soon as possible",
        counter: 20,
        timing: { kind: "asap", latest: undefined } as const,
        dataRate: 5,
        powerDbm: 22,
        priority: TransmitPriority.Normal,
      },
      {
        name: "transmit request: a siren command",
        counter: 21,
        timing: { kind: "at", gateway: GATEWAY, gatewayMicros: 4294967295 } as const,
        dataRate: 0,
        powerDbm: 14,
        priority: TransmitPriority.SirenCommand,
      },
      {
        name: "transmit request at the radio's lowest power",
        counter: 22,
        timing: { kind: "asap", latest: mono(offset + 1000) } as const,
        dataRate: 5,
        powerDbm: -9,
        priority: TransmitPriority.Normal,
      },
    ];
    for (const c of cases) {
      const vector = fieldCase("transmit-request.json", c.name);
      const h = onSession((e) => ({
        ...withCounter(c.counter)(e),
        live:
          e.live === undefined ? undefined : { ...e.live, clock: { samples: [offset], offset } },
      }));
      const out = h.input({
        kind: "radioOut",
        ref: sendRef(11),
        device: deviceOf(SENSOR_ADDRESS),
        packet: Uint8Array.from(Buffer.from(String(vector.fields.packet), "hex")),
        counter: 77,
        gateway: GATEWAY,
        timing: c.timing,
        dataRate: c.dataRate,
        powerDbm: c.powerDbm,
        priority: c.priority,
        purpose: c.priority === TransmitPriority.SirenCommand ? "sirenCommand" : "eventReply",
      });
      const sends = effectsOf(out.effects, "send");
      expect(sends.map((s) => toHex(s.bytes))).toEqual([toHex(vector.packet)]);
      expect(sends[0]?.counters).toEqual([
        { device: GATEWAY, counter: c.counter },
        { device: deviceOf(SENSOR_ADDRESS), counter: 77 },
      ]);
      expect(sends[0]?.ref).toBe(sendRef(11));
    }
  });
});

describe("rejected packets from the gateway's address", () => {
  const gatewayCases = rejectedCases().filter((c) => toHex(c.packet.slice(1, 5)) === "c5b4a392");

  test("there are some, in both directions", () => {
    expect(gatewayCases.length).toBeGreaterThanOrEqual(5);
  });

  test("each is counted with its error (a hub-bound case) or as wrongDirection, and changes nothing", () => {
    for (const c of gatewayCases) {
      const h = onSession();
      const before = h.state.gateways;
      const out = h.frame(LINK, c.packet);
      const expected = c.expectedDirection === 0 ? c.error : "wrongDirection";
      expect(ofKind(out.messages, "rejected").map((r): string => r.reason)).toEqual([expected]);
      expect(out.effects).toEqual([]);
      expect(ofKind(out.messages, "devicePacket")).toEqual([]);
      expect(h.state.gateways).toBe(before);
    }
  });
});

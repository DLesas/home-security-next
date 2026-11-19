/**
 * Accepting a device packet (hub-design.md section 8, "Accepting a device packet"; protocol.md
 * §3, §4, §5), through the real `step` with the stand-ins: every sensor status, Started and log
 * entries case of the vectors opened into its fields; `rejected-packets.json` case by case as the
 * right rejection, counted by source and not acted on; the 64-packet window against
 * `counters.json` with its saved form; no AES for an unknown address; a second gateway's copy;
 * the wrong path; an authentic packet of an unknown type; what is written now; repeats of log
 * entries; readings that follow only the newest packet.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeMessage,
  EMPTY_REPLAY_WINDOW,
  fromHex,
  type Message,
  MessageType,
  toHex,
} from "@hsn/protocol";
import { checkPacket } from "../../../src/core/intake/accept.ts";
import { z } from "zod";
import type { Effect } from "../../../src/core/model/effects.ts";
import { deviceId, linkId } from "../../../src/core/model/ids.ts";
import { DeviceState } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { emptySnapshot } from "../../world/world.ts";
import { VECTOR_DIRECTORY } from "../../world/vectors.ts";
import {
  Bench,
  type BenchSensor,
  flags,
  heartbeat,
  SECOND,
  sensorRow,
  siteRowAt,
} from "../../scenarios/sensors/bench.ts";
import { forwardedFrame } from "../../scenarios/sensors/stand-ins.ts";

const vectorDevices = VectorCipher.fromVectors().devices;
const SIREN_ADDRESS = 1584361601;
const GATEWAY_ADDRESS = 2460202181;

/** The vector files' devices on a bench: sensors, the siren and the gateway by their roles. */
function vectorBench(
  windows: ReadonlyMap<number, Uint8Array> = new Map(),
  keys: ReadonlyMap<number, Uint8Array> = new Map(),
): Bench {
  const devices: BenchSensor[] = vectorDevices.map((d) => ({
    device: d.device,
    address: d.address,
    key: keys.get(d.address) ?? d.key,
    name: `d${d.device}`,
  }));
  const b = new Bench(devices);
  const role = (address: number) =>
    address === SIREN_ADDRESS ? 2 : address === GATEWAY_ADDRESS ? 3 : 1;
  b.boot({
    ...emptySnapshot(),
    site: siteRowAt(5),
    devices: devices.map((d) => ({
      id: d.device,
      address: d.address,
      role: role(d.address),
      name: d.name,
      chipId: new Uint8Array(6),
      firmware: 0,
      development: true,
      state: DeviceState.Contacted,
      addedMs: 0,
      removedMs: null,
    })),
    sensorConfig: devices.filter((d) => role(d.address) === 1).map((d) => sensorRow(d.device, 5)),
    sendCounters: devices.map((d) => ({ deviceId: d.device, resumePoint: 1024 })),
    deviceState: [...windows].map(([address, window]) => ({
      deviceId: vectorDevices.find((d) => d.address === address)?.device ?? deviceId(0),
      boot: 1 as never,
      lastSeenMono: mono(0),
      lastSeenMs: 0,
      clockOk: true,
      window,
      reading: null,
      rssi: null,
      snrQ: null,
      bestGatewayId: null,
      uptimeS: null,
      estimates: null,
    })),
  });
  return b;
}

/** Delivers a packet as it would arrive: through the gateway for a radio packet, on a link otherwise. */
function arrive(b: Bench, packet: Uint8Array, maxLength: number, at = mono(10 * SECOND)): void {
  if (maxLength === 255) {
    b.hear(packet, at, 5);
  } else {
    if (at > b.world.now.mono)
      b.world.advanceTo(at).match(
        () => undefined,
        () => undefined,
      );
    const siren = b.world.openLink("network", "siren");
    expect(b.world.deliver(siren, packet).isOk()).toBe(true);
  }
}

const caseSchema = z.object({
  name: z.string(),
  canonical: z.boolean(),
  address: z.int(),
  counter: z.int(),
  binding: z.string(),
  maxLength: z.int(),
  fields: z.unknown(),
  packet: z.string(),
});
function cases(file: string): z.infer<typeof caseSchema>[] {
  return z
    .object({ cases: z.array(caseSchema) })
    .parse(JSON.parse(readFileSync(join(VECTOR_DIRECTORY, file), "utf8"))).cases;
}

const lastOut = (b: Bench) => b.world.effects;

describe("the vectors' device packets open into their fields", () => {
  for (const file of [
    "heartbeat.json",
    "door-changed.json",
    "cover-changed.json",
    "button.json",
    "started.json",
    "log-entries.json",
  ]) {
    // Session-bound cases are a gateway's own packets, opened by the gateways module.
    for (const c of cases(file).filter((c) => c.binding === "")) {
      test(`${file}: ${c.name}`, () => {
        const b = vectorBench();
        arrive(b, fromHex(c.packet), c.maxLength);
        const accepted = b.messages("accepted");
        expect(accepted).toHaveLength(1);
        expect(accepted[0]?.message).toEqual({
          type: accepted[0]?.message.type,
          ...(c.fields as object),
        } as never);
        expect(accepted[0]?.counter).toBe(c.counter);
        expect(b.messages("rejected")).toEqual([]);
      });
    }
  }
});

describe("rejected-packets.json, case by case", () => {
  const rejectedSchema = z.object({
    name: z.string(),
    key: z.string(),
    expectedDirection: z.int(),
    binding: z.string(),
    maxLength: z.int(),
    packet: z.string(),
    error: z.string(),
  });
  const replayedSchema = rejectedSchema
    .omit({ error: true })
    .extend({ rule: z.string(), stateBefore: z.unknown(), rejection: z.string() });
  const file = z
    .object({ packets: z.array(rejectedSchema), replayed: z.array(replayedSchema) })
    .parse(JSON.parse(readFileSync(join(VECTOR_DIRECTORY, "rejected-packets.json"), "utf8")));

  /**
   * The hub's own name for a case where it differs (the README lets a receiver map its errors):
   * an address no device has is refused as `unknownAddress` before any AES is spent (section 8).
   */
  const HUB_REASON: Readonly<Record<string, string>> = { "address altered": "unknownAddress" };

  // The hub's intake is the receiver of packets to the hub with no binding.
  const forHub = file.packets.filter((c) => c.expectedDirection === 0 && c.binding === "");
  const radioLength = (c: (typeof forHub)[number]) =>
    c.packet.length / 2 >= 18 && c.packet.length / 2 <= 255;

  for (const c of forHub.filter((c) => c.maxLength === 1024 || radioLength(c))) {
    test(`${c.name}: ${HUB_REASON[c.name] ?? c.error}`, () => {
      const packet = fromHex(c.packet);
      const address = packet.length >= 5 ? new DataView(packet.buffer).getUint32(1, true) : 0;
      // The hub opens with the key it holds for the address: the case's key.
      const b = vectorBench(new Map(), new Map([[address, fromHex(c.key)]]));
      arrive(b, packet, c.maxLength);
      const rejected = b.messages("rejected");
      expect(b.world.faults).toEqual([]);
      expect(rejected.map((r) => r.reason)).toEqual([(HUB_REASON[c.name] ?? c.error) as never]);
      expect(b.messages("accepted")).toEqual([]);
      // Counted by source: the gateway for a radio packet, the link otherwise.
      expect(rejected[0]?.source).toEqual(
        c.maxLength === 255 ? { device: deviceId(90) } : { link: expect.anything() as never },
      );
      expect(rejected[0]?.sample).toEqual(fromHex(c.packet).slice(0, 16));
      expect(b.stand.radioOuts).toEqual([]);
    });
  }

  // A gateway forwards only radio packets of 18 to 255 bytes (§6), so these reach the checks
  // only as the intake's own function sees them.
  for (const c of forHub.filter((c) => c.maxLength === 255 && !radioLength(c))) {
    test(`${c.name}: ${c.error}, in the checks themselves`, () => {
      const known = {
        deviceAt: () => undefined,
        windowOf: () => EMPTY_REPLAY_WINDOW,
        keyStateOf: () => "none" as const,
      };
      const arrival = {
        path: "lora",
        gateway: deviceId(90),
        link: linkId(1),
        gatewayCounter: 0,
        gatewayLink: "network",
        gatewayMicros: 0,
        endedAt: mono(0),
        rssiDbm: 0,
        snrQuarterDb: 0,
        dataRate: 5,
        siteChannel: 1,
      } as const;
      const verdict = checkPacket(known, VectorCipher.fromVectors(), fromHex(c.packet), arrival);
      expect(verdict.isOk() && verdict.value.kind === "rejected" && verdict.value.reason).toBe(
        c.error as never,
      );
    });
  }

  for (const c of file.replayed.filter((c) => c.rule === "replayWindow")) {
    test(`${c.name}: ${c.rejection}`, () => {
      const packet = fromHex(c.packet);
      const address = new DataView(packet.buffer).getUint32(1, true);
      const b = vectorBench(new Map([[address, fromHex(String(c.stateBefore))]]));
      arrive(b, packet, c.maxLength);
      expect(b.messages("rejected").map((r) => r.reason)).toEqual([c.rejection as never]);
      expect(b.messages("accepted")).toEqual([]);
    });
  }
});

describe("the replay window against counters.json (§4), with its saved form", () => {
  const steps = z.array(
    z.object({
      name: z.string(),
      steps: z.array(
        z.object({
          counter: z.int(),
          accepted: z.boolean(),
          state: z.string().optional(),
          rejection: z.string().optional(),
        }),
      ),
    }),
  );
  const sequences = steps.parse(
    (
      JSON.parse(readFileSync(join(VECTOR_DIRECTORY, "counters.json"), "utf8")) as {
        replayWindow: unknown;
      }
    ).replayWindow,
  );
  for (const sequence of sequences) {
    test(sequence.name, () => {
      const b = vectorBench();
      let at = 10;
      for (const step of sequence.steps) {
        const before = b.world.effects.length;
        b.hear(b.seal(0, heartbeat(), step.counter), mono(at * SECOND), 5);
        at += 1;
        const after = b.world.effects.slice(before);
        const windowWrite = after.find(
          (e): e is Extract<Effect, { kind: "write" }> =>
            e.kind === "write" && e.op.table === "device_state",
        );
        if (step.accepted) {
          const row =
            windowWrite?.op.op === "upsert" && windowWrite.op.table === "device_state"
              ? windowWrite.op.row
              : undefined;
          expect(row?.window === undefined || row.window === null ? "" : toHex(row.window)).toBe(
            step.state ?? "",
          );
        } else {
          expect(b.messages("rejected").at(-1)?.reason).toBe(step.rejection as never);
          expect(windowWrite).toBeUndefined();
        }
      }
    });
  }
});

describe("the order of checks and the hub's own reasons (section 8)", () => {
  test("an unknown address is counted with no AES spent", () => {
    const b = vectorBench();
    let opened = 0;
    const open = b.cipher.open;
    b.cipher.open = (...args) => {
      opened += 1;
      return open(...args);
    };
    const packet = b.seal(0, heartbeat(), 5);
    packet.set([0x01, 0x02, 0x03, 0x04], 1);
    b.hear(packet, mono(10 * SECOND), 5);
    expect(b.messages("rejected").map((r) => [r.reason, r.address])).toEqual([
      ["unknownAddress", 0x04030201],
    ]);
    expect(opened).toBe(0);
    // The gateway's forwarded packet is a row of its own, its inside refused, so it is found by
    // the gateway and its counter (D110); its body is the forwarded packet, the refused one inside.
    const carriers = b
      .records()
      .flatMap((r) => (r.kind === "rx" && r.row.type === MessageType.ForwardedPacket ? [r] : []));
    expect(carriers.map((r) => [r.table, r.row.gatewayId, r.row.gwCounter])).toEqual([
      ["routine", null, null],
    ]);
    const carrier = carriers[0]?.row;
    expect(carrier?.deviceId).not.toBeNull();
    expect(toHex(carrier?.body.slice(-packet.length) ?? new Uint8Array())).toBe(toHex(packet));
  });

  test("a copy heard by a second gateway is a duplicate counted for that gateway; one copy is accepted", () => {
    const b = vectorBench();
    const second = b.world.openLink("network", "gw2");
    const packet = b.seal(0, heartbeat({ flags: flags({ replyWanted: true }) }), 5);
    b.hear(packet, mono(10 * SECOND), 5);
    expect(
      b.world
        .deliver(
          second,
          forwardedFrame(packet, { endedAt: mono(10 * SECOND), dataRate: 5, siteChannel: 1 }),
        )
        .isOk(),
    ).toBe(true);
    expect(b.messages("accepted")).toHaveLength(1);
    expect(b.messages("rejected").map((r) => [r.reason, r.source])).toEqual([
      ["duplicate", { device: deviceId(91) }],
    ]);
    // The reply goes through the first gateway (GW9).
    expect(b.stand.radioOuts.map((o) => o.gateway)).toEqual([deviceId(90)]);
  });

  test("a sensor status on a link is wrongPath, and does not use up the counter of the real copy", () => {
    const b = vectorBench();
    const packet = b.seal(0, heartbeat(), 5);
    arrive(b, packet, 1024);
    expect(b.messages("rejected").map((r) => r.reason)).toEqual(["wrongPath"]);
    b.hear(packet, mono(20 * SECOND), 5);
    expect(b.messages("accepted")).toHaveLength(1);
  });

  test("a gateway's own packet inside a forwarded one is wrongPath", () => {
    const hello = cases("hello.json")[0];
    expect(hello).toBeDefined();
    const b = vectorBench();
    b.hear(fromHex(hello?.packet ?? ""), mono(10 * SECOND), 5);
    expect(b.messages("rejected").map((r) => r.reason)).toEqual(["wrongPath"]);
  });

  test("an authentic packet of an unknown type enters the window, is recorded, and its replay is refused", () => {
    const unknown = z
      .object({ packets: z.array(z.object({ name: z.string(), packet: z.string() })) })
      .parse(JSON.parse(readFileSync(join(VECTOR_DIRECTORY, "rejected-packets.json"), "utf8")))
      .packets.find((p) => p.name.includes("unknown message type"));
    const b = vectorBench();
    const packet = fromHex(unknown?.packet ?? "");
    b.hear(packet, mono(10 * SECOND), 5);
    b.hear(packet, mono(20 * SECOND), 5);
    expect(b.messages("rejected").map((r) => r.reason)).toEqual(["unknownType", "duplicate"]);
    const rx = b.records().flatMap((r) => (r.kind === "rx" ? [[r.table, r.row.type]] : []));
    // The replay is a duplicate: no row of its own, counted in `rejects` for its gateway (D110).
    expect(rx).toEqual([["event", 0x7f]]);
  });
});

describe("what is written now (section 5)", () => {
  const status = {
    settingsVersion: 1,
    flags: flags({ replyWanted: true }),
    batteryCode: 120,
    temperatureCelsius: 20,
    doorChangeCount: 0,
    eventAgeSeconds: 0,
  };
  const reports: [string, Message][] = [
    ["door", { type: MessageType.DoorChanged, ...status, doorChangeCount: 1 }],
    ["cover", { type: MessageType.CoverChanged, ...status }],
    ["button", { type: MessageType.Button, ...status, buttonAction: 1 }],
    [
      "Started",
      {
        type: MessageType.Started,
        role: 1,
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        resetCause: 1,
        lastFatalError: 0,
        settingsVersion: 1,
      },
    ],
  ];
  for (const [name, message] of reports) {
    test(`a ${name} report's record, window and reading are written now`, () => {
      const b = vectorBench();
      const before = b.world.effects.length;
      b.hear(b.seal(0, message, 5), mono(10 * SECOND), 5);
      const after = b.world.effects.slice(before);
      expect(after.find((e) => e.kind === "record" && e.record.kind === "rx")).toMatchObject({
        durability: "now",
        record: { table: "event" },
      });
      expect(after.find((e) => e.kind === "write" && e.op.table === "device_state")).toMatchObject({
        durability: "now",
      });
    });
  }

  test("a heartbeat's record and window are routine", () => {
    const b = vectorBench();
    const before = b.world.effects.length;
    b.hear(b.seal(0, heartbeat(), 5), mono(10 * SECOND), 5);
    const after = b.world.effects.slice(before);
    expect(after.find((e) => e.kind === "record" && e.record.kind === "rx")).toMatchObject({
      durability: "routine",
      record: { table: "routine" },
    });
    expect(after.find((e) => e.kind === "write" && e.op.table === "device_state")).toMatchObject({
      durability: "routine",
    });
  });
});

describe("log entries and readings (section 8)", () => {
  const log = (text: string, ageTenths = 0): Message => ({
    type: MessageType.LogEntries,
    entries: [{ ageTenths, level: 2, code: 7, text }],
  });

  test("an entry made again within 15 s ‡ is kept and marked repeat_of the earlier packet's counter; warnings are written now", () => {
    const b = vectorBench();
    b.hear(b.seal(0, log("battery low"), 5), mono(10 * SECOND), 5);
    b.hear(b.seal(0, log("battery low"), 6), mono(25 * SECOND), 5);
    b.hear(b.seal(0, log("battery low"), 7), mono(41 * SECOND), 5);
    const rows = b
      .effects("record")
      .flatMap((e) =>
        e.record.kind === "deviceLog"
          ? [[e.durability, e.record.row.counter, e.record.row.repeatOf]]
          : [],
      );
    expect(rows).toEqual([
      ["now", 5, null],
      ["now", 6, 5],
      ["now", 7, null],
    ]);
  });

  test("readings follow the newest packet only; an older one is recorded and changes nothing else", () => {
    const b = vectorBench();
    b.hear(b.seal(0, heartbeat({ batteryCode: 200 }), 10), mono(10 * SECOND), 5);
    b.hear(b.seal(0, heartbeat({ batteryCode: 50 }), 8), mono(20 * SECOND), 5);
    const accepted = b.messages("accepted");
    expect(accepted.map((a) => a.newest)).toEqual([true, false]);
    const rows = b
      .effects("write")
      .flatMap((e) =>
        e.op.op === "upsert" && e.op.table === "device_state" && e.op.row.reading !== null
          ? [e.op.row.reading]
          : [],
      );
    const battery = rows.map((r) => {
      const decoded = decodeMessage(new Uint8Array([1, ...r]));
      return decoded.ok && decoded.value.type === MessageType.Heartbeat
        ? decoded.value.batteryCode
        : -1;
    });
    expect(battery.at(-1)).toBe(200);
    expect(b.records().filter((r) => r.kind === "rx")).toHaveLength(2);
  });

  test("Started is recorded as a decision with its reset cause and last fatal error (FW5)", () => {
    const b = vectorBench();
    const started: Message = {
      type: MessageType.Started,
      role: 1,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      resetCause: 4,
      lastFatalError: 0xbeef,
      settingsVersion: 1,
    };
    b.hear(b.seal(0, started, 64), mono(10 * SECOND), 5);
    // The reset cause; the last fatal error is in the Started body of the rx row it names (FW5).
    expect(b.decisions("device_started").map((d) => d.value)).toEqual([4]);
    expect(lastOut(b).length).toBeGreaterThan(0);
  });
});

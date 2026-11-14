/**
 * The protocol's vectors from the hub's side of sensors (hub-design.md section 11): every
 * canonical `reply` and `disarmed-notice` case produced byte for byte by the core's reply builder
 * and sealing, with the case's counter and binding (the next-setting cases of D115 included);
 * the door-report reply produced end to end through `step`; and `time-on-air.json` against the
 * airtime and the event listen time the replies are timed by.
 */
import { UNBUILT_CALENDAR } from "../../../src/shell/calendar/unbuilt.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, MessageType, ResumeStep, toHex } from "@hsn/protocol";
import { z } from "zod";
import type { Context } from "../../../src/core/model/handler.ts";
import { ok } from "neverthrow";
import { deviceId, seq } from "../../../src/core/model/ids.ts";
import { ArmState, NEXT_SETTING_STAYS } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES as rules } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import { airtimeMs, eventListenMs } from "../../../src/core/sensors/radio.ts";
import { replyMessage, seal } from "../../../src/core/sensors/reply.ts";
import { encodeHistory } from "../../../src/core/sensors/settings.ts";
import type { SensorEntry } from "../../../src/core/sensors/state.ts";
import { emptyState } from "../../../src/core/step.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { VECTOR_DIRECTORY } from "../../world/vectors.ts";
import { Bench, flags, SECOND, sensorRow, sensorSnapshot } from "../../scenarios/sensors/bench.ts";

const cipher = VectorCipher.fromVectors();

const replyFields = z.object({
  settingsVersion: z.int(),
  flags: z.object({
    armed: z.boolean(),
    countdownStarted: z.boolean(),
    updateAvailable: z.boolean(),
  }),
  countdownSeconds: z.int(),
  countdownRemainingSeconds: z.int(),
  heartbeatIntervalUnits: z.int(),
  linkCheckEvery: z.int(),
  sendDataRate: z.int(),
  replyDataRate: z.int(),
  nextHeartbeatTenths: z.int(),
  clockCorrectionTenPpm: z.int(),
  nextSiteChannel: z.int(),
  nextSendDataRate: z.int(),
});
const caseOf = <F extends z.ZodType>(fields: F) =>
  z.object({
    name: z.string(),
    canonical: z.boolean(),
    address: z.int(),
    counter: z.int(),
    binding: z.string(),
    fields,
    packet: z.string(),
  });

function cases<F extends z.ZodType>(
  file: string,
  fields: F,
): z.infer<ReturnType<typeof caseOf<F>>>[] {
  const json: unknown = JSON.parse(readFileSync(join(VECTOR_DIRECTORY, file), "utf8"));
  return z.object({ cases: z.array(caseOf(fields)) }).parse(json).cases;
}

/** A step's context with the vector cipher, enough for sealing. */
function context(): Context {
  return {
    now: { mono: mono(0), wall: 0, wallTrusted: true },
    view: emptyState(),
    deps: { cipher, rules, calendar: UNBUILT_CALENDAR },
    entropy: entropyCursor(new Uint8Array(32), "frame"),
    records: { take: () => ok(seq(0)) },
    event: "frame",
  };
}

/** A sensor whose hub counter's next is `counter`. */
function entryFor(address: number, counter: number, config: SensorEntry["config"]): SensorEntry {
  const device = cipher.deviceFor(address)?.device ?? deviceId(0);
  return {
    device,
    address,
    name: "front",
    config: { ...config, deviceId: device },
    counter: { step: ResumeStep.Hub, next: counter, resumePoint: ResumeStep.Hub * 2 ** 20 },
    announcing: undefined,
    status: undefined,
    lastCounter: 0,
    snr: [],
    fasterFrom: undefined,
    heardAt: mono(0),
    heardRate: undefined,
    missed: 5,
    silent: false,
    loss: new Map(),
    slotFrom: undefined,
  };
}

/** The counter a 4-byte binding names (§4: little-endian). */
function boundCounter(hex: string): number {
  const bytes = fromHex(hex);
  return new DataView(bytes.buffer).getUint32(0, true);
}

describe("reply.json, byte for byte", () => {
  for (const c of cases("reply.json", replyFields).filter((c) => c.canonical)) {
    test(c.name, () => {
      const f = c.fields;
      const config = {
        ...sensorRow(deviceId(0), f.sendDataRate),
        arm: f.flags.armed ? ArmState.Armed : ArmState.Disarmed,
        version: f.settingsVersion,
        countdownS: f.countdownSeconds,
        heartbeatUnits: f.heartbeatIntervalUnits,
        linkCheckEvery: f.linkCheckEvery,
        sendRate: f.sendDataRate,
        replyRate: f.replyDataRate,
        correctionUnits: f.clockCorrectionTenPpm,
        nextChannel: f.nextSiteChannel,
        nextRate: f.nextSendDataRate,
        versionHistory: encodeHistory([
          { version: f.settingsVersion, replyRate: f.replyDataRate, move: 0 },
        ]),
      };
      const left = f.flags.countdownStarted ? f.countdownRemainingSeconds : undefined;
      const message = replyMessage(config, left, f.nextHeartbeatTenths, f.flags.updateAvailable);
      const sealed = seal(
        context(),
        entryFor(c.address, c.counter, config),
        message,
        boundCounter(c.binding),
      );
      expect(sealed.isOk()).toBe(true);
      expect(sealed.isOk() && toHex(sealed.value.packet)).toBe(c.packet);
      expect(sealed.isOk() && sealed.value.counter).toBe(c.counter);
    });
  }

  test("every canonical case is covered, the next-setting cases of D115 among them", () => {
    const names = cases("reply.json", replyFields)
      .filter((c) => c.canonical)
      .map((c) => c.name);
    expect(names.filter((n) => n.includes("announcing")).length).toBeGreaterThanOrEqual(4);
  });
});

describe("disarmed-notice.json, byte for byte", () => {
  for (const c of cases("disarmed-notice.json", z.object({})).filter((c) => c.canonical)) {
    test(c.name, () => {
      const config = sensorRow(deviceId(0), 5);
      const sealed = seal(
        context(),
        entryFor(c.address, c.counter, config),
        { type: MessageType.DisarmedNotice },
        boundCounter(c.binding),
      );
      expect(sealed.isOk() && toHex(sealed.value.packet)).toBe(c.packet);
    });
  }
});

describe("through step: the reply to the door report that starts a countdown", () => {
  test("is reply.json's first case, bound to the report's counter 41, counter 9, at DR5", () => {
    const vector = cases("reply.json", replyFields)[0];
    const front = cipher.deviceFor(439041101);
    expect(vector).toBeDefined();
    expect(front).toBeDefined();
    if (vector === undefined || front === undefined) return;
    const sensors = [
      { device: front.device, address: front.address, key: front.key, name: "front" },
    ];
    const b = new Bench(sensors);
    const config = sensorRow(front.device, 2, {
      version: 3,
      arm: ArmState.Armed,
      replyRate: 5,
      nextChannel: NEXT_SETTING_STAYS,
    });
    b.boot(sensorSnapshot(sensors, 2, { configs: [config], resumePoint: 9 }));
    b.stand.armed.add(front.device);
    const door = {
      type: MessageType.DoorChanged,
      settingsVersion: 3,
      flags: flags({ doorOpen: true, replyWanted: true }),
      batteryCode: 115,
      temperatureCelsius: 19,
      doorChangeCount: 17,
      eventAgeSeconds: 2,
    } as const;
    b.hear(b.seal(0, door, 41), mono(100 * SECOND), 2);
    const out = b.stand.radioOuts[0];
    expect(out?.counter).toBe(9);
    expect(out?.dataRate).toBe(5);
    expect(out === undefined ? "" : toHex(out.packet)).toBe(vector.packet);
  });
});

describe("time-on-air.json", () => {
  const timeOnAir = z.object({
    cases: z.array(z.object({ dataRate: z.int(), length: z.int(), microseconds: z.int() })),
    eventListen: z.array(z.object({ dataRate: z.int(), milliseconds: z.int() })),
  });
  const vectors = timeOnAir.parse(
    JSON.parse(readFileSync(join(VECTOR_DIRECTORY, "time-on-air.json"), "utf8")),
  );

  test("every case's airtime, as replies and slots compute it, to the microsecond", () => {
    for (const c of vectors.cases) {
      const ms = airtimeMs(c.dataRate, c.length);
      expect(ms.isOk() && Math.round(ms.value * 1000)).toBe(c.microseconds);
    }
    expect(vectors.cases.length).toBeGreaterThan(40);
  });

  test("the event listen times the hub times event replies by", () => {
    for (const e of vectors.eventListen)
      expect(eventListenMs(rules, e.dataRate)).toBe(e.milliseconds);
    expect(eventListenMs(rules, 6)).toBeUndefined();
  });
});

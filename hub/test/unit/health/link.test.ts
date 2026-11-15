/**
 * A poor link (D107): more than a fifth of a sensor's packets lost over the last 7 days, from the
 * sensors module's daily counts (`loss_daily`); too few packets to judge is not poor; a device
 * that is no sensor never is.
 */
import { describe, expect, test } from "bun:test";
import { newSendCounter, ResumeStep } from "@hsn/protocol";
import { handleHealth } from "../../../src/core/health/handle.ts";
import { dayOf, isPoorLink } from "../../../src/core/health/link.ts";
import { poorLink } from "../../../src/core/health/view.ts";
import type { DeviceId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { ArmState } from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { mono } from "../../../src/core/model/time.ts";
import type { SensorEntry } from "../../../src/core/sensors/state.ts";
import {
  accepted,
  boot,
  GATEWAY,
  rec,
  Runner,
  SENSOR,
  SIREN,
  sensorMessage,
  sirenMessage,
  snapshotWith,
  viewWith,
  WALL0,
} from "./support.ts";

const RULES = DEFAULT_RULES;
const TODAY = dayOf(WALL0);

/** Loss over the 7 days before today: `lost` of every 1,000 expected, spread on each day. */
function week(lostPerThousand: number): Map<number, { received: number; expected: number }> {
  return new Map(
    Array.from({ length: 7 }, (_, i) => [
      TODAY - 1 - i,
      { received: 1000 - lostPerThousand, expected: 1000 },
    ]),
  );
}

describe("the rule (D107)", () => {
  test("below, at and above a fifth", () => {
    expect(RULES.silence.poorLinkLoss).toBe(0.2);
    expect(isPoorLink(RULES, week(199), TODAY)).toBe(false);
    expect(isPoorLink(RULES, week(200), TODAY)).toBe(false);
    expect(isPoorLink(RULES, week(201), TODAY)).toBe(true);
  });

  test("too few packets to judge: no whole day before today that expected any", () => {
    expect(isPoorLink(RULES, new Map(), TODAY)).toBe(false);
    expect(isPoorLink(RULES, new Map([[TODAY, { received: 0, expected: 500 }]]), TODAY)).toBe(
      false,
    );
    expect(isPoorLink(RULES, new Map([[TODAY - 1, { received: 0, expected: 0 }]]), TODAY)).toBe(
      false,
    );
  });

  test("only the last 7 days count", () => {
    const old = new Map([
      [TODAY - 8, { received: 0, expected: 10_000 }],
      [TODAY - 1, { received: 950, expected: 1000 }],
    ]);
    expect(isPoorLink(RULES, old, TODAY)).toBe(false);
    expect(isPoorLink(RULES, new Map([[TODAY - 7, { received: 0, expected: 10 }]]), TODAY)).toBe(
      true,
    );
  });
});

function sensorEntry(device: DeviceId, lost: number): SensorEntry {
  return {
    device,
    address: 0x1003,
    name: "front",
    config: {
      deviceId: device,
      arm: ArmState.Disarmed,
      armedBoot: null,
      armedMono: null,
      countdownS: 30,
      heartbeatUnits: 12,
      linkCheckEvery: 5,
      sendRate: 5,
      replyRate: 5,
      replyRateFixed: false,
      correctionUnits: 0,
      correctionFixed: false,
      nextChannel: 0xff,
      nextRate: 0xff,
      moveConfirmed: 0,
      moveFollowed: 0,
      version: 1,
      versionHistory: new Uint8Array(),
    },
    counter: newSendCounter(ResumeStep.Hub),
    announcing: undefined,
    status: undefined,
    lastCounter: 0,
    snr: [],
    fasterFrom: undefined,
    heardAt: mono(0),
    heardRate: undefined,
    missed: 5,
    silent: false,
    loss: week(lost),
    slotFrom: undefined,
  };
}

function withLoss(lost: number, also: readonly DeviceId[] = []): HubState {
  const base = viewWith();
  const entries = [SENSOR, ...also].map((d): [DeviceId, SensorEntry] => [d, sensorEntry(d, lost)]);
  return { ...base, sensors: { ...base.sensors, sensors: new Map(entries) } };
}

describe("the selector, through the sensors module's view", () => {
  test("judged at the start and when the sensor is heard", () => {
    const runner = new Runner("health", handleHealth, withLoss(250));
    runner.run(boot(snapshotWith()));
    const view = () => ({ ...runner.view, health: runner.slice });
    expect(poorLink(view(), SENSOR)).toBe(true);
    runner.view = withLoss(100);
    runner.run(accepted(SENSOR, sensorMessage(3900)));
    expect(poorLink(view(), SENSOR)).toBe(false);
    runner.view = withLoss(300);
    runner.run(accepted(SENSOR, sensorMessage(3900), { newest: false }));
    expect(poorLink(view(), SENSOR)).toBe(true);
  });

  test("a good link at the start is not poor", () => {
    const runner = new Runner("health", handleHealth, withLoss(100));
    runner.run(boot(snapshotWith()));
    expect(poorLink({ ...runner.view, health: runner.slice }, SENSOR)).toBe(false);
  });

  test("the daily poor_link decision marks it", () => {
    const runner = new Runner("health", handleHealth, withLoss(0));
    runner.run(boot(snapshotWith()));
    runner.run({
      kind: "auditRecord",
      durability: "now",
      record: {
        kind: "decision",
        row: {
          seq: rec(9),
          atMs: 0,
          clockOk: true,
          kind: "poor_link",
          deviceId: SENSOR,
          causeSeq: null,
          value: 250,
          detail: null,
        },
      },
    });
    expect(poorLink({ ...runner.view, health: runner.slice }, SENSOR)).toBe(true);
  });

  test("a device that is not a sensor never has one", () => {
    // Even with counts filed under its number, a siren is judged by no sensor's rule.
    const runner = new Runner("health", handleHealth, withLoss(900, [SIREN, GATEWAY]));
    runner.run(boot(snapshotWith()));
    runner.run(accepted(SIREN, sirenMessage(4000)));
    const view = { ...runner.view, health: runner.slice };
    expect(poorLink(view, SIREN)).toBe(false);
    expect(poorLink(view, GATEWAY)).toBe(false);
  });
});

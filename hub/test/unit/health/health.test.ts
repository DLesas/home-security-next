/**
 * The health module (m2-design.md section 7, "Device health"; HB33, D9, D89, D109, HB10): the
 * battery percentage from the interim table, low battery raised once at 10% and cleared above
 * 15%, on the newest packet only, written now and not raised again after a restart; a siren on
 * mains; tamper from cover changed reports; ignored long presses; silence for the device screens.
 */
import { describe, expect, test } from "bun:test";
import { ButtonAction, batteryCode, batteryMillivolts } from "@hsn/protocol";
import { batteryPercent as percent, chargeAt, lowAfter } from "../../../src/core/health/battery.ts";
import { handleHealth } from "../../../src/core/health/handle.ts";
import { batteryLow, batteryPercent, silent, tamperOpen } from "../../../src/core/health/view.ts";
import { bootId, type Seq } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import { BATTERY_CURVE_INTERIM, DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import {
  accepted,
  boot,
  decisions,
  GATEWAY,
  rec,
  Runner,
  SENSOR,
  sensorMessage,
  SIREN,
  sirenMessage,
  snapshotWith,
  viewWith,
  WALL0,
  writes,
} from "./support.ts";

const RULES = DEFAULT_RULES;

function health(snapshot = snapshotWith()): Runner<"health"> {
  const runner = new Runner("health", handleHealth, viewWith());
  runner.run(boot(snapshot));
  return runner;
}

function viewOf(runner: Runner<"health">): HubState {
  return { ...runner.view, health: runner.slice };
}

describe("the battery percentage (HB33, the interim table)", () => {
  test("the table's points, linear between, held at its ends", () => {
    expect(RULES.health.batteryCurve).toBe(BATTERY_CURVE_INTERIM);
    expect(percent(RULES, 3000)).toBe(0);
    expect(percent(RULES, 2500)).toBe(0);
    expect(percent(RULES, 3250)).toBe(5);
    expect(percent(RULES, 3500)).toBe(10);
    expect(percent(RULES, 3550)).toBe(13);
    expect(percent(RULES, 3600)).toBe(15);
    expect(percent(RULES, 3900)).toBe(58);
    expect(percent(RULES, 4200)).toBe(100);
    expect(percent(RULES, 5000)).toBe(100);
  });

  test("10% is exactly the firmware's 3,500 mV: 3,510 mV is not low", () => {
    expect(chargeAt(RULES.health.batteryCurve, 3510)).toBeCloseTo(10.5);
    expect(lowAfter(RULES, false, 3500)).toBe(true);
    expect(lowAfter(RULES, false, 3510)).toBe(false);
  });

  test("between 10% and 15% the state stays; above 15% it clears", () => {
    expect(lowAfter(RULES, true, 3550)).toBe(true);
    expect(lowAfter(RULES, false, 3550)).toBe(false);
    expect(lowAfter(RULES, true, 3600)).toBe(true);
    expect(lowAfter(RULES, true, 3610)).toBe(false);
  });

  test("the battery byte's steps meet the table's points", () => {
    expect(batteryMillivolts(batteryCode(3500))).toBe(3500);
    expect(batteryMillivolts(batteryCode(3600))).toBe(3600);
  });

  test("the view gives the newest reading's percentage, null before any", () => {
    const runner = health();
    expect(batteryPercent(viewOf(runner), RULES, SENSOR)).toBeNull();
    runner.run(accepted(SENSOR, sensorMessage(3900)));
    expect(batteryPercent(viewOf(runner), RULES, SENSOR)).toBe(58);
  });
});

describe("low battery (HB33, D109)", () => {
  test("raised once at 10%, with its row written now, and not again on the way down", () => {
    const runner = health();
    expect(runner.run(accepted(SENSOR, sensorMessage(3510)))).toEqual([]);
    const record: Seq = rec(77);
    const out = runner.run(accepted(SENSOR, sensorMessage(3500), { record }));
    expect(
      decisions(out).map((d) => [
        d.durability,
        d.row.kind,
        d.row.deviceId,
        d.row.causeSeq,
        d.row.value,
      ]),
    ).toEqual([["now", "battery_low", SENSOR, record, 10]]);
    expect(writes(out)).toEqual([
      {
        kind: "write",
        durability: "now",
        op: {
          table: "health_state",
          op: "upsert",
          row: { deviceId: SENSOR, batteryLow: true, tamperOpen: false },
        },
      },
    ]);
    expect(batteryLow(viewOf(runner), SENSOR)).toBe(true);
    expect(runner.run(accepted(SENSOR, sensorMessage(3400)))).toEqual([]);
    expect(runner.run(accepted(SENSOR, sensorMessage(3000)))).toEqual([]);
  });

  test("cleared only above 15%, once", () => {
    const runner = health();
    runner.run(accepted(SENSOR, sensorMessage(3450)));
    expect(runner.run(accepted(SENSOR, sensorMessage(3600)))).toEqual([]);
    const out = runner.run(accepted(SENSOR, sensorMessage(3610)));
    expect(decisions(out).map((d) => [d.row.kind, d.row.value, d.durability])).toEqual([
      ["battery_ok", 16, "now"],
    ]);
    expect(writes(out)).toHaveLength(1);
    expect(runner.run(accepted(SENSOR, sensorMessage(4000)))).toEqual([]);
    expect(batteryLow(viewOf(runner), SENSOR)).toBe(false);
  });

  test("a packet that is not the newest changes no reading", () => {
    const runner = health();
    runner.run(accepted(SENSOR, sensorMessage(3900)));
    expect(runner.run(accepted(SENSOR, sensorMessage(3400), { newest: false }))).toEqual([]);
    expect(batteryPercent(viewOf(runner), RULES, SENSOR)).toBe(58);
  });

  test("not raised again after a restart: the committed state is the start's", () => {
    const runner = health(
      snapshotWith({ healthState: [{ deviceId: SENSOR, batteryLow: true, tamperOpen: false }] }),
    );
    expect(batteryLow(viewOf(runner), SENSOR)).toBe(true);
    expect(runner.run(accepted(SENSOR, sensorMessage(3450)))).toEqual([]);
  });

  test("the percentage after a restart comes from the stored reading", () => {
    const reading = Uint8Array.of(1, 0, batteryCode(3900), 20, 0, 0, 0);
    const snapshot = snapshotWith();
    const runner = health({
      ...snapshot,
      deviceState: [
        {
          deviceId: SENSOR,
          boot: bootId(1),
          lastSeenMono: mono(0),
          lastSeenMs: 0,
          clockOk: true,
          window: null,
          reading,
          rssi: null,
          snrQ: null,
          bestGatewayId: null,
          uptimeS: null,
          estimates: null,
        },
      ],
    });
    expect(batteryPercent(viewOf(runner), RULES, SENSOR)).toBe(58);
  });

  test("a siren counts only on its cell, not on mains (D109)", () => {
    const runner = health();
    expect(runner.run(accepted(SIREN, sirenMessage(3300, { onMains: true })))).toEqual([]);
    expect(batteryPercent(viewOf(runner), RULES, SIREN)).toBe(6);
    const out = runner.run(accepted(SIREN, sirenMessage(3300)));
    expect(decisions(out).map((d) => [d.row.kind, d.row.deviceId])).toEqual([
      ["battery_low", SIREN],
    ]);
    // Back on mains and charging: its readings neither clear nor raise it.
    expect(runner.run(accepted(SIREN, sirenMessage(4100, { onMains: true })))).toEqual([]);
    expect(batteryLow(viewOf(runner), SIREN)).toBe(true);
  });

  test("a siren with no cell fitted has no percentage", () => {
    const runner = health();
    expect(runner.run(accepted(SIREN, sirenMessage(2600, { cellFitted: false })))).toEqual([]);
    expect(batteryPercent(viewOf(runner), RULES, SIREN)).toBeNull();
  });
});

describe("tamper (D9) and long presses (HB10, D89)", () => {
  test("a cover changed report raises tamper_opened once, then tamper_closed, each written now", () => {
    const runner = health();
    const opened = runner.run(
      accepted(SENSOR, sensorMessage(3900, { type: "cover", coverOpen: true })),
    );
    expect(decisions(opened).map((d) => [d.row.kind, d.durability])).toEqual([
      ["tamper_opened", "now"],
    ]);
    expect(writes(opened)[0]?.op).toEqual({
      table: "health_state",
      op: "upsert",
      row: { deviceId: SENSOR, batteryLow: false, tamperOpen: true },
    });
    expect(tamperOpen(viewOf(runner), SENSOR)).toBe(true);
    expect(
      runner.run(accepted(SENSOR, sensorMessage(3900, { type: "cover", coverOpen: true }))),
    ).toEqual([]);
    const closed = runner.run(accepted(SENSOR, sensorMessage(3900, { type: "cover" })));
    expect(decisions(closed).map((d) => d.row.kind)).toEqual(["tamper_closed"]);
  });

  test("a heartbeat showing a cover not expected: cover_state_unexpected once per change, state kept (D114)", () => {
    const runner = health();
    const shown = runner.run(accepted(SENSOR, sensorMessage(3900, { coverOpen: true })));
    expect(decisions(shown).map((d) => [d.row.kind, d.row.value, d.durability])).toEqual([
      ["cover_state_unexpected", 1, "now"],
    ]);
    expect(writes(shown)).toEqual([]);
    expect(tamperOpen(viewOf(runner), SENSOR)).toBe(false);
    expect(runner.run(accepted(SENSOR, sensorMessage(3900, { coverOpen: true })))).toEqual([]);
    // Back as expected, then shown open again: a new change, told again.
    expect(runner.run(accepted(SENSOR, sensorMessage(3900)))).toEqual([]);
    expect(
      decisions(runner.run(accepted(SENSOR, sensorMessage(3900, { coverOpen: true })))).map(
        (d) => d.row.kind,
      ),
    ).toEqual(["cover_state_unexpected"]);
  });

  test("a heartbeat showing the cover closed while the hub knows it open: value 0", () => {
    const runner = health(
      snapshotWith({ healthState: [{ deviceId: SENSOR, batteryLow: false, tamperOpen: true }] }),
    );
    // A door report's flags are no heartbeat's: nothing.
    expect(runner.run(accepted(SENSOR, sensorMessage(3900, { type: "door" })))).toEqual([]);
    expect(
      decisions(runner.run(accepted(SENSOR, sensorMessage(3900)))).map((d) => [
        d.row.kind,
        d.row.value,
      ]),
    ).toEqual([["cover_state_unexpected", 0]]);
    expect(tamperOpen(viewOf(runner), SENSOR)).toBe(true);
  });

  test("a late cover report's opening is told as tamper_opened, late, the state unchanged", () => {
    const runner = health();
    runner.at(100 * 1_000_000);
    const late = runner.run(
      accepted(SENSOR, sensorMessage(3900, { type: "cover", coverOpen: true, ageS: 40 }), {
        newest: false,
      }),
    );
    expect(decisions(late).map((d) => [d.row.kind, d.row.value, d.durability])).toEqual([
      ["tamper_opened", Math.floor((WALL0 + 60_000) / 1000), "now"],
    ]);
    expect(writes(late)).toEqual([]);
    expect(tamperOpen(viewOf(runner), SENSOR)).toBe(false);
    // The same opening again, or an earlier one: told once.
    expect(
      runner.run(
        accepted(SENSOR, sensorMessage(3900, { type: "cover", coverOpen: true, ageS: 50 }), {
          newest: false,
        }),
      ),
    ).toEqual([]);
    // A late report of a closing: nothing.
    expect(
      runner.run(accepted(SENSOR, sensorMessage(3900, { type: "cover" }), { newest: false })),
    ).toEqual([]);
  });

  test("a late opening before the last one told on time is not told again", () => {
    const runner = health();
    runner.at(100 * 1_000_000);
    runner.run(accepted(SENSOR, sensorMessage(3900, { type: "cover", coverOpen: true })));
    expect(
      runner.run(
        accepted(SENSOR, sensorMessage(3900, { type: "cover", coverOpen: true, ageS: 30 }), {
          newest: false,
        }),
      ),
    ).toEqual([]);
  });

  test("gateways have no battery (section 7)", () => {
    const runner = health();
    expect(batteryPercent(viewOf(runner), RULES, GATEWAY)).toBeNull();
    expect(batteryLow(viewOf(runner), GATEWAY)).toBe(false);
  });

  test("an open cover known at the start is not raised again", () => {
    const runner = health(
      snapshotWith({ healthState: [{ deviceId: SENSOR, batteryLow: false, tamperOpen: true }] }),
    );
    expect(
      runner.run(accepted(SENSOR, sensorMessage(3900, { type: "cover", coverOpen: true }))),
    ).toEqual([]);
  });

  test("a pairing or reset hold while armed is long_press_ignored; a short press is nothing", () => {
    const runner = health();
    for (const action of [
      ButtonAction.PairingHoldIgnoredWhileArmed,
      ButtonAction.FactoryResetHoldWhileArmed,
    ]) {
      const out = runner.run(
        accepted(SENSOR, sensorMessage(3900, { type: "button", button: action })),
      );
      expect(decisions(out).map((d) => [d.row.kind, d.row.value, d.durability])).toEqual([
        ["long_press_ignored", action, "now"],
      ]);
    }
    expect(
      runner.run(
        accepted(SENSOR, sensorMessage(3900, { type: "button", button: ButtonAction.ShortPress })),
      ),
    ).toEqual([]);
  });
});

describe("silence and removal", () => {
  test("a silence decision marks the device silent until it is heard", () => {
    const runner = health();
    runner.run({
      kind: "auditRecord",
      durability: "now",
      record: {
        kind: "decision",
        row: {
          seq: rec(5),
          atMs: 0,
          clockOk: true,
          kind: "sensor_silent",
          deviceId: SENSOR,
          causeSeq: null,
          value: 5,
          detail: null,
        },
      },
    });
    expect(silent(viewOf(runner), SENSOR)).toBe(true);
    runner.run(accepted(SENSOR, sensorMessage(3900), { newest: false }));
    expect(silent(viewOf(runner), SENSOR)).toBe(false);
  });

  test("a removed device's row is deleted", () => {
    const runner = health(
      snapshotWith({ healthState: [{ deviceId: SENSOR, batteryLow: true, tamperOpen: false }] }),
    );
    expect(runner.run({ kind: "deviceRemoved", device: SENSOR })).toEqual([
      {
        kind: "write",
        durability: "now",
        op: { table: "health_state", op: "delete", key: { deviceId: SENSOR } },
      },
    ]);
    expect(batteryLow(viewOf(runner), SENSOR)).toBe(false);
  });
});

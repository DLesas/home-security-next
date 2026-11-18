/**
 * The firmware module changes nothing when no image exists (docs/m3-updates-design.md section 4):
 * a site of scripted sensors on one gateway (the sensors scenarios' bench) runs two hours twice,
 * once with the real firmware module in its place in the order and once with a module that
 * ignores every message; every effect of every step is the same, in the same order, and firmware
 * emits nothing at all. Then the same site with an image in the store and no rollout: still the
 * same, since nothing reaches a device until a person approves a rollout (D139).
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import { EMPTY_M3M4_SNAPSHOT } from "../../../src/core/model/events.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import { imageId } from "../../../src/core/model/ids.ts";
import { ImageKind } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { SeededBytes } from "../../world/entropy.ts";
import { ScriptedSensor } from "../../world/scripted-sensor.ts";
import { Bench, benchSensors, SECOND, sensorSnapshot } from "../sensors/bench.ts";
import { RadioSite } from "../sensors/radio-site.ts";
import { standIns } from "../sensors/stand-ins.ts";

const HOUR = 3_600 * SECOND;

const ignore: Handler<"firmware"> = (slice) => ok({ slice, out: [] });

/** Four sensors on one gateway, every module but the stand-ins' real, firmware as given. */
function run(
  firmware: Handler<"firmware"> | undefined,
  withImage: boolean,
): {
  readonly effects: readonly Effect[];
  readonly faults: number;
  readonly replies: number;
} {
  const random = new SeededBytes(5);
  const uniform = (): number => random.next() / 2 ** 32;
  const ids = benchSensors(4);
  const sensors = ids.map(
    (id, i) =>
      new ScriptedSensor({
        key: id.key,
        address: id.address,
        channel: 1,
        rate: 5,
        drift: 0.001 * i,
        random: uniform,
        startAt: mono((1 + 30 * i) * SECOND),
      }),
  );
  const site = new RadioSite(sensors, { channel: 1, rate: 5 });
  const stand = standIns(firmware === undefined ? {} : { firmware }, (channel, rate) => {
    site.listenOn(channel, rate);
  });
  const bench = new Bench(ids, { gateway: site, stand });
  const base = sensorSnapshot(ids, 5);
  const snapshot: DurableSnapshot = withImage
    ? {
        ...base,
        m3m4: {
          ...EMPTY_M3M4_SNAPSHOT,
          firmwareImages: [
            {
              id: imageId(1),
              imageId: new Uint8Array(8).fill(1),
              sha256: new Uint8Array(32).fill(1),
              version: 0x020000,
              kind: ImageKind.Official,
              roles: 0b1110,
              bytes: 1_000_000,
              header: new Uint8Array(128),
              manifest: "{}",
              file: "1.bin",
              addedMs: 0,
              addedBy: "test",
              removedMs: null,
            },
          ],
        },
      }
    : base;
  bench.boot(snapshot);
  expect(bench.world.advanceTo(mono(2 * HOUR)).isOk()).toBe(true);
  return {
    effects: bench.world.effects,
    faults: bench.world.faults.length,
    replies: sensors.reduce((sum, s) => sum + s.replies.length, 0),
  };
}

describe("with no rollout, the hub behaves as without the firmware module", () => {
  test.each([
    ["no image in the store", false],
    ["an image in the store", true],
  ])("%s: every effect the same, none of firmware's", (_name, withImage) => {
    const real = run(undefined, withImage);
    const without = run(ignore, withImage);
    expect(real.faults).toBe(0);
    expect(real.replies).toBeGreaterThan(0);
    expect(real.effects.length).toBe(without.effects.length);
    expect(real.effects).toEqual(without.effects);
    const firmwareKinds = new Set(["transferGrant", "transferRevoke", "bluetoothSession"]);
    expect(real.effects.filter((e) => firmwareKinds.has(e.kind))).toEqual([]);
    expect(
      real.effects.filter(
        (e) =>
          e.kind === "write" &&
          ["firmware_images", "rollouts", "device_updates"].includes(e.op.table),
      ),
    ).toEqual([]);
  });
});

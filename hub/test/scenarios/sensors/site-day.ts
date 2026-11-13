/**
 * A site of scripted sensors in the World (hub-design.md section 11): `count` sensors on one
 * gateway through a `RadioSite`, their clocks drifting by the given amounts, each paired already
 * (the hub holds their rows) and starting with Started at a spread of moments.
 */
import { SeededBytes } from "../../world/entropy.ts";
import { ScriptedSensor } from "../../world/scripted-sensor.ts";
import { mono } from "../../../src/core/model/time.ts";
import type { HubRules } from "../../../src/core/model/rules.ts";
import { Bench, benchSensors, SECOND, sensorSnapshot } from "./bench.ts";
import { RadioSite } from "./radio-site.ts";
import { standIns } from "./stand-ins.ts";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";

export interface SiteDay {
  readonly bench: Bench;
  readonly site: RadioSite;
  readonly sensors: readonly ScriptedSensor[];
  /** What the hub booted from. */
  readonly snapshot: DurableSnapshot;
}

/** Drifts spread evenly from −3% to +3% (section 11: "drifts between −3% and +3%"). */
export function spreadDrifts(count: number, extent = 0.03): readonly number[] {
  return Array.from({ length: count }, (_, i) =>
    count === 1 ? 0 : -extent + (2 * extent * i) / (count - 1),
  );
}

export function siteDay(options: {
  readonly count: number;
  readonly rate: number;
  readonly drifts?: readonly number[];
  readonly seed?: number;
  readonly rules?: HubRules;
  readonly snapshot?: (snapshot: DurableSnapshot) => DurableSnapshot;
  readonly startSpreadS?: number;
}): SiteDay {
  const { count, rate } = options;
  const random = new SeededBytes(options.seed ?? 7);
  const uniform = (): number => random.next() / 2 ** 32;
  const ids = benchSensors(count);
  const drifts = options.drifts ?? spreadDrifts(count);
  const spread = options.startSpreadS ?? 170;
  const sensors = ids.map(
    (id, i) =>
      new ScriptedSensor({
        key: id.key,
        address: id.address,
        channel: 1,
        rate,
        drift: drifts[i] ?? 0,
        random: uniform,
        startAt: mono(Math.round((1 + (spread * i) / Math.max(1, count)) * SECOND)),
      }),
  );
  const site = new RadioSite(sensors, { channel: 1, rate });
  const stand = standIns({}, (channel, newRate) => {
    site.listenOn(channel, newRate);
  });
  const bench = new Bench(ids, {
    gateway: site,
    stand,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  const base = sensorSnapshot(ids, rate);
  const snapshot = options.snapshot === undefined ? base : options.snapshot(base);
  bench.boot(snapshot);
  return { bench, site, sensors, snapshot };
}

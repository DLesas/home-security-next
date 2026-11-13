/**
 * The slot and clock-correction formulas of hub-design.md section 8 at their boundaries: the
 * span, the largest-clearance phase, even replanning, the next heartbeat t ≡ φ (mod I) with
 * t ≥ e + I/2 in tenths, and d = m·I·(1 + c) ÷ G − 1 for clocks from 3 % slow to 3 % fast, the
 * median of 5, the 0.5 s outlier, m from 1 to 4, and a change at 50 ppm with 3 samples, at most
 * every 6 hours, in units of 10 ppm, within ±32 %.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES as rules } from "../../../src/core/model/rules.ts";
import {
  correctionToSend,
  driftOf,
  intervalsIn,
  keepsSample,
  median,
  predictedGapUs,
  withSample,
} from "../../../src/core/slots/correction.ts";
import { decodeEstimates, encodeEstimates } from "../../../src/core/slots/estimates.ts";
import {
  clearanceOf,
  nextOccurrenceAfterUs,
  placeSlot,
  planAll,
  type Slot,
  smallestClearance,
  spanUs,
} from "../../../src/core/slots/plan.ts";

const S = 1_000_000;
const I = 180 * S;
const HOUR = 3600 * S;

const slot = (device: number, phaseUs: number, intervalUs = I, span = 3 * S): Slot => ({
  device,
  order: device,
  intervalUs,
  spanUs: span,
  phaseUs,
});

describe("the span (section 8)", () => {
  test("is the heartbeat's airtime, the reply moment, the reply's airtime and the 2 s ‡ guard", () => {
    expect(spanUs(61.696, 1000, 71.936, 2000)).toBe(3_133_632);
  });
});

describe("placing a slot", () => {
  test("the first sensor takes phase 0", () => {
    expect(placeSlot([], slot(1, 0), HOUR).slot.phaseUs).toBe(0);
  });

  test("a new sensor takes the middle of the widest free stretch over the hour", () => {
    const others = [slot(1, 0), slot(2, 60 * S)];
    // Free: 3 s to 60 s (57 s) and 63 s to 180 s (117 s): the middle of the second.
    const placed = placeSlot(others, slot(3, 0), HOUR);
    expect(placed.slot.phaseUs).toBe(63 * S + (117 * S - 3 * S) / 2);
    expect(placed.clearanceUs).toBe((117 * S - 3 * S) / 2);
  });

  test("spans of another interval are counted at every occurrence over the hour", () => {
    // A 5-minute sensor at 0 lands at 0, 120, 60, ... s of a 3-minute circle over an hour.
    const others = [slot(1, 0, 300 * S)];
    const placed = placeSlot(others, slot(2, 0), HOUR);
    expect(clearanceOf(placed.slot, others, HOUR)).toBe(placed.clearanceUs);
    expect(placed.clearanceUs).toBeGreaterThan(0);
    expect(placed.clearanceUs).toBeLessThan(60 * S);
  });

  test("clearance is edge to edge, around the circle, and overlapping spans are below any", () => {
    expect(clearanceOf(slot(1, 10 * S), [slot(2, 0)], HOUR)).toBe(7 * S);
    expect(clearanceOf(slot(1, 0), [slot(2, 177 * S)], HOUR)).toBe(0);
    expect(clearanceOf(slot(1, 0), [slot(2, 2 * S)], HOUR)).toBeLessThan(0);
  });

  test("planning again spreads one interval evenly in order of pairing", () => {
    const planned = planAll([slot(9, 5), slot(3, 7), slot(5, 1)], HOUR);
    expect(planned.map((s) => [s.device, s.phaseUs])).toEqual([
      [3, 0],
      [5, 60 * S],
      [9, 120 * S],
    ]);
    expect(smallestClearance(planned, HOUR)).toBe(57 * S);
  });

  test("planning again with mixed intervals places each in turn at the largest clearance", () => {
    const planned = planAll([slot(1, 0), slot(2, 0, 300 * S)], HOUR);
    expect(planned[0]?.phaseUs).toBe(0);
    expect(clearanceOf(planned[1] ?? slot(0, 0), [planned[0] ?? slot(0, 0)], HOUR)).toBeGreaterThan(
      0,
    );
  });
});

describe("the next heartbeat (section 8, Telling the sensor)", () => {
  const s = slot(1, 50 * S);
  test("is the first occurrence at least I/2 after the answered end", () => {
    // e = 10 s: earliest 100 s; the slot's next occurrence is 230 s, 220 s after e.
    expect(nextOccurrenceAfterUs(s, 10 * S, I / 2)).toBe(220 * S);
    // e = 140 s: earliest 230 s: exactly on the occurrence, which counts (t ≥ e + I/2).
    expect(nextOccurrenceAfterUs(s, 140 * S, I / 2)).toBe(90 * S);
    // One microsecond later, the occurrence is too soon: the next one, an interval on.
    expect(nextOccurrenceAfterUs(s, 140 * S + 1, I / 2)).toBe(270 * S - 1);
  });

  test("is at least 30 s ‡ after a Started for the early heartbeat", () => {
    expect(nextOccurrenceAfterUs(s, 30 * S, 30 * S)).toBe(410 * S - 30 * S - 180 * S);
    expect(nextOccurrenceAfterUs(s, 21 * S, 30 * S)).toBe(209 * S);
  });
});

describe("clock samples and the correction (section 8, Clock correction)", () => {
  test("d = m·I·(1 + c) ÷ G − 1 recovers clocks from 3 % slow to 3 % fast, for any held c and m", () => {
    for (const d of [-0.03, -0.0123, -0.0005, 0, 0.0005, 0.0123, 0.03]) {
      for (const units of [-3000, -5, 0, 5, 3000]) {
        for (const m of [1, 2, 3, 4]) {
          const gap = predictedGapUs(m, I, units, d);
          expect(intervalsIn(gap, I)).toBe(m);
          expect(driftOf(m, I, units, gap)).toBeCloseTo(d, 12);
        }
      }
    }
  });

  test("m is the gap in whole intervals, rounded, kept from 1 to 4", () => {
    expect(keepsSample(rules, 0, I, 0, 0.4 * I, undefined)).toBe(false);
    expect(keepsSample(rules, 1, I, 0, I, undefined)).toBe(true);
    expect(keepsSample(rules, 4, I, 0, 4 * I, undefined)).toBe(true);
    expect(keepsSample(rules, 5, I, 0, 5 * I, undefined)).toBe(false);
  });

  test("a sample more than 0.5 s ‡ off the estimate's prediction is dropped, one at 0.5 s is kept", () => {
    const estimate = 0.01;
    const predicted = predictedGapUs(1, I, 0, estimate);
    expect(keepsSample(rules, 1, I, 0, predicted + 500_000, estimate)).toBe(true);
    expect(keepsSample(rules, 1, I, 0, predicted - 500_000, estimate)).toBe(true);
    expect(keepsSample(rules, 1, I, 0, predicted + 500_001, estimate)).toBe(false);
    expect(keepsSample(rules, 1, I, 0, predicted - 500_001, estimate)).toBe(false);
  });

  test("the estimate is the median of the last 5 ‡", () => {
    let samples: readonly number[] = [];
    for (const d of [9, 1, 2, 3, 4, 5]) samples = withSample(rules, samples, d);
    expect(samples).toEqual([1, 2, 3, 4, 5]);
    expect(median(samples)).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });

  test("a new correction needs 3 samples, a change of 50 ppm ‡, and 6 hours ‡ since the last", () => {
    const at = (samples: readonly number[], held: number, allowed = true) =>
      correctionToSend(rules, samples, held, allowed)._unsafeUnwrap();
    expect(at([0.001, 0.001], 0)).toBeUndefined();
    expect(at([0.001, 0.001, 0.001], 0)).toBe(100);
    expect(at([0.001, 0.001, 0.001], 0, false)).toBeUndefined();
    // 49.9 ppm off the held 0: stays; 50 ppm off: sent, in units of 10 ppm.
    expect(at([0.0000499, 0.0000499, 0.0000499], 0)).toBeUndefined();
    expect(at([0.00005, 0.00005, 0.00005], 0)).toBe(5);
    // Rounded to 10 ppm, an exact half up (§3): 1,255 ppm is 126 units.
    expect(at([0.001255, 0.001255, 0.001255], 0)).toBe(126);
    // Limited to ±32 % (§6).
    expect(at([0.5, 0.5, 0.5], 0)).toBe(32_000);
    expect(at([-0.5, -0.5, -0.5], 0)).toBe(-32_000);
  });
});

describe("the estimates blob (section 6)", () => {
  test("starts with its format byte and round-trips the slot and samples", () => {
    const blob = encodeEstimates(slot(1, 12_345_678, I, 3_133_632), [-0.03, 0.0001234, 0.03]);
    expect(blob[0]).toBe(1);
    const back = decodeEstimates(blob);
    expect(back?.phaseUs).toBe(12_345_678);
    expect(back?.intervalUs).toBe(I);
    expect(back?.spanUs).toBe(3_133_632);
    expect(back?.samples.map((d) => Math.round(d * 1e8))).toEqual([-3_000_000, 12_340, 3_000_000]);
    expect(decodeEstimates(new Uint8Array([2, 0, 0]))).toBeUndefined();
  });
});

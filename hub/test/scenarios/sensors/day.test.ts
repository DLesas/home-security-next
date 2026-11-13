/**
 * A day of 30 scripted sensors with clocks from 3 % slow to 3 % fast on one gateway at DR5
 * (hub-design.md section 11: "slots and corrections converging for 30 sensors with drifts
 * between −3 % and +3 %"): the hub plans their slots, measures each clock and corrects it, and
 * from the first hour on no heartbeat collides; each heartbeat starts in its slot; every link
 * check is answered; nothing faults.
 */
import { describe, expect, test } from "bun:test";
import { mono } from "../../../src/core/model/time.ts";
import { modulo } from "../../../src/core/slots/plan.ts";
import { SECOND } from "./bench.ts";
import { siteDay } from "./site-day.ts";

const HOUR = 3600 * SECOND;

describe("a day of 30 sensors with drifting clocks", () => {
  const day = siteDay({ count: 30, rate: 5 });
  const advanced = day.bench.world.advanceTo(mono(24 * HOUR));

  test("runs without a fault", () => {
    expect(advanced.isOk()).toBe(true);
    expect(day.bench.world.faults).toEqual([]);
  });

  test("from the second hour on, no heartbeat is lost to a collision", () => {
    const later = day.site.heard.filter((h) => h.transmission.start >= HOUR);
    expect(later.length).toBeGreaterThan(30 * 450);
    expect(later.filter((h) => !h.heard)).toEqual([]);
  });

  test("every clock is corrected to within 50 ppm ‡ of its drift", () => {
    for (const sensor of day.sensors) {
      const heldPpm = sensor.held.correctionUnits * 10;
      expect(Math.abs(heldPpm - (sensor.options.drift ?? 0) * 1e6)).toBeLessThan(50);
    }
  });

  test("in the last 12 hours each heartbeat starts within 1 s of its slot", () => {
    day.bench.sensors.forEach((id, index) => {
      const slot = day.bench.world.state.slots.entries.get(id.device)?.slot;
      expect(slot).toBeDefined();
      if (slot === undefined) return;
      const starts = day.site.heard
        .filter((h) => h.sensor === index && h.transmission.start >= 12 * HOUR)
        .map((h) => h.transmission.start);
      expect(starts.length).toBeGreaterThan(200);
      for (const start of starts) {
        const off =
          modulo(start - slot.phaseUs + slot.intervalUs / 2, slot.intervalUs) - slot.intervalUs / 2;
        expect(Math.abs(off)).toBeLessThan(SECOND);
      }
    });
  });

  test("every link check is answered, and nothing else is: 1 in 5 heartbeats, at the fixed moment", () => {
    for (const sensor of day.sensors) {
      expect(sensor.misses).toBe(0);
      expect(sensor.slotted).toBe(true);
      // About 480 heartbeats a day, a link check every 5th, the Started reply and a version change.
      expect(sensor.replies.length).toBeGreaterThanOrEqual(95);
      expect(sensor.replies.length).toBeLessThanOrEqual(100);
    }
  });
});

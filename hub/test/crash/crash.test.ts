/**
 * Crash tests (hub-design.md section 11, "Crash tests"; section 4, "What a crash leaves
 * behind"): power lost at each point of section 4's table, one targeted case per row, then
 * 500 ‡ seeded random points over a day of home A on the whole hub, each followed by a restart
 * from that file and the rest of the day.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SeededBytes } from "../world/entropy.ts";
import { DAY, HOUR, MINUTE, SECOND } from "../world/home.ts";
import { CRASH_POINTS, type CrashPoint, CrashRun, type PlannedCrash } from "./harness.ts";

/** Section 11: 500 ‡ seeded crash points a run. */
const RANDOM_CRASHES = 500;

let run: CrashRun | undefined;
afterEach(() => {
  run?.close();
  run = undefined;
});

describe("power lost at each point of section 4's table", () => {
  // Each at a turn that stages something written now: while armed by day, as the back door's
  // countdown starts at 23:00, as the alarm runs, and as the board is provisioned at noon.
  test.each(CRASH_POINTS.map((point) => [point]))(
    "%s",
    async (point: CrashPoint) => {
      run = await CrashRun.create(7);
      const crashes: PlannedCrash[] = [
        { at: 8 * HOUR + 30 * SECOND, point, needsNow: true },
        { at: 12 * HOUR + SECOND, point, needsNow: true },
        { at: 23 * HOUR - SECOND, point, needsNow: true },
        { at: 23 * HOUR + 45 * SECOND, point, needsNow: true },
      ];
      expect(run.run(crashes)).toEqual([]);
      expect(run.home.restarts).toBe(4);
      expect(run.sends).toBeGreaterThan(1000);
      // The day still ends as it should: the board paired, the alarm raised, every sensor disarmed.
      expect(run.board.pairing).toBeDefined();
      expect(run.home.decisions("alarm").length).toBeGreaterThan(0);
    },
    30_000,
  );
});

describe("a day of home A with seeded crashes (section 11)", () => {
  test(`${RANDOM_CRASHES} ‡ random points: the seven conditions hold after every restart`, async () => {
    run = await CrashRun.create(2026);
    const random = new SeededBytes(2026);
    const crashes: PlannedCrash[] = Array.from({ length: RANDOM_CRASHES }, () => ({
      at: Math.floor((random.next() / 2 ** 32) * (DAY - MINUTE)),
      point: CRASH_POINTS[random.next() % CRASH_POINTS.length] ?? "afterSends",
      needsNow: random.next() % 2 === 0,
    }));
    expect(run.run(crashes)).toEqual([]);
    // About one planned crash in ten never comes: one that waits for a turn written now is
    // replaced by the next before such a turn. Which ones depends on the database's own bytes
    // (a torn checkpoint keeps some pages of either side), so the count moves a little with the
    // schema: 448 with M2's step 0 tables (m2-design.md section 4).
    expect(run.home.restarts).toBeGreaterThan(RANDOM_CRASHES * 0.88);
  }, 120_000);
});

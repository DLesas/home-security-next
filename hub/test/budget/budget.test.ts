/**
 * The write budget (hub-design.md section 11, "Write budget"; section 5, "Budget"; D112, HB35):
 * a simulated day of home A and of home B on the whole hub (every real module, the loop of
 * section 4, the real writer on a real SQLite file, scripted gateways, sensors and sirens),
 * counting commits and the bytes of every WAL frame, failing above section 5's limits; a second
 * day with a five-minute alarm, allowed 300 more commits; the file's size projected at D57's
 * retention; a faulty device's warnings costing no more than their 60 an hour; and reads that
 * never commit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { DAY, Home, HOME_A, HOME_B, type HomeSpec, HOUR, MINUTE, SECOND } from "../world/home.ts";
import { DAY_TEST_TIMEOUT_MS, DAYS_TEST_TIMEOUT_MS } from "../world/timeouts.ts";
import { bootId } from "../../src/core/model/ids.ts";
import { mono } from "../../src/core/model/time.ts";
import {
  type DayMeasured,
  measureDay,
  type OlderRows,
  WAL_LIMIT_MB,
  writeOlderRows,
} from "./run.ts";

/** Section 5's budget a day: commits, megabytes of WAL frames, the file at D57's retention. */
const BUDGET = {
  A: { commits: 800, megabytes: 20, fileMegabytes: 70 },
  B: { commits: 1400, megabytes: 35, fileMegabytes: 120 },
} as const;
/** An alarm adds a commit a second for its five minutes (section 5). */
const ALARM_EXTRA_COMMITS = 300;
/** Routine and event rows a day, from section 5's "Database size" table. */
const OLDER: Record<"A" | "B" | "C", OlderRows> = {
  A: { routinePerDay: 21_330, eventPerDay: 450 },
  B: { routinePerDay: 32_890, eventPerDay: 1_300 },
  // A 64-sensor home: twice home B's rows and more, laid out as the day's retention deletes them.
  C: { routinePerDay: 70_000, eventPerDay: 2_700 },
};
/** A 64-sensor home with 8 sirens and 3 gateways: the largest site the size guard's marks allow for. */
const HOME_C = { name: "C", sensors: 64, sirens: 8, gateways: 3 } as const;
/**
 * The size guard's lower mark, where trimming stops (section 6): a home at D57's retention stays
 * under it, so it would lose nothing of that retention if trimming ever ran.
 */
const SIZE_GUARD_STOP_MB = 210;

const homes: Home[] = [];
afterAll(() => {
  for (const home of homes) home.close();
});

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

/** Warnings and worse a day, as section 5's "Commits a day" assumes. */
const WARNINGS = { A: 20, B: 30, C: 60 } as const;

/**
 * Section 5's day of `spec`: each sensor's door opens 10 times (20 door events and their
 * retries), by morning (06:00 to 07:55) and evening (18:05 to 21:55) while disarmed; armed at
 * 07:59 and 17:59 with a 30-second countdown each time, disarmed in time (leaving and coming
 * home); the warnings logged by the sirens spread over the day. Heartbeats, link checks and
 * their replies, siren reports on both paths and gateway statuses are the devices' own. With
 * `alarm`, armed again at 22:00 and a five-minute alarm from 23:00.
 */
async function day(spec: HomeSpec, alarm: boolean): Promise<DayMeasured> {
  const name = spec.name as "A" | "B" | "C";
  const home = await Home.create({ ...spec, seed: 5 }, (store) => {
    // Written by the boot before the day's, so their numbers are below every one of the day's.
    writeOlderRows(store, OLDER[name], bootId(store.boot.id - 1));
  });
  homes.push(home);
  home.scriptDesignDoors(10, [
    [6 * HOUR, 7 * HOUR + 55 * MINUTE],
    [18 * HOUR + 5 * MINUTE, 21 * HOUR + 55 * MINUTE],
  ]);
  const actions: { at: number; act: () => void }[] = [];
  for (const at of [8 * HOUR, 18 * HOUR]) {
    actions.push({
      at: at - MINUTE,
      act: () => {
        home.command({ kind: "arm", sensors: "all", continue: true });
      },
    });
    home.sensor("door-1")?.door(mono(at), true);
    home.sensor("door-1")?.door(mono(at + 10 * SECOND), false);
    actions.push({
      at: at + 20 * SECOND,
      act: () => {
        home.command({ kind: "disarm", sensors: "all" });
      },
    });
  }
  const warnings = WARNINGS[name];
  for (let w = 0; w < warnings; w++) {
    actions.push({
      at: Math.floor(((w + 0.5) * DAY) / warnings),
      act: () => {
        home.sirens[w % home.sirens.length]?.siren.log(2, 9, "battery low");
      },
    });
  }
  if (alarm) {
    actions.push({
      at: 22 * HOUR,
      act: () => {
        home.command({ kind: "arm", sensors: "all", continue: false });
      },
    });
    home.sensor("door-1")?.door(mono(23 * HOUR), true);
    home.sensor("door-1")?.door(mono(23 * HOUR + 20 * SECOND), false);
  }
  for (const action of actions.toSorted((a, b) => a.at - b.at)) {
    must(home.advanceTo(action.at));
    action.act();
  }
  must(home.advanceTo(DAY));
  // The two countdowns ended in time; the alarm, if asked for, came.
  expect(home.decisions("countdown_started").length).toBeGreaterThanOrEqual(alarm ? 3 : 2);
  expect(home.decisions("alarm")).toHaveLength(alarm ? 1 : 0);
  const store = home.store;
  expect(store).toBeDefined();
  if (store === undefined) return measureDayless();
  const measured = measureDay(store, store.boot.id);
  console.log(
    `home ${name}${alarm ? " with an alarm" : ""} on the whole hub: ${measured.commits} commits ` +
      `(${JSON.stringify(measured.byReason)}), ${measured.walFrames} WAL frames = ${measured.megabytes.toFixed(1)} MB, ` +
      `${measured.routineRows} routine and ${measured.eventRows} event rows, ` +
      `${measured.projectedFileMegabytes.toFixed(0)} MB at D57's retention; rows by table ${JSON.stringify(measured.rowsByTable)}`,
  );
  return measured;
}

function measureDayless(): DayMeasured {
  return {
    commits: Number.POSITIVE_INFINITY,
    byReason: {} as DayMeasured["byReason"],
    walFrames: 0,
    checkpointedFrames: 0,
    megabytes: Number.POSITIVE_INFINITY,
    routineRows: 0,
    eventRows: 0,
    projectedFileMegabytes: Number.POSITIVE_INFINITY,
    rowsByTable: {},
  };
}

describe.each([HOME_A, HOME_B])("a day of home $name (section 5)", (spec) => {
  const budget = BUDGET[spec.name as "A" | "B"];
  let quiet: DayMeasured;

  test(
    `commits at most ${budget.commits} times`,
    async () => {
      quiet = await day(spec, false);
      expect(quiet.commits).toBeLessThanOrEqual(budget.commits);
      // Every commit is one of section 5's rules; the routine flushes at most one per five minutes.
      expect(quiet.byReason.due).toBeLessThanOrEqual(288);
      expect(quiet.byReason.size).toBe(0);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(`writes at most ${budget.megabytes} MB of WAL frames`, () => {
    expect(quiet.megabytes).toBeLessThanOrEqual(budget.megabytes);
    // The frames counted commit by commit are those the checkpoints report.
    expect(quiet.checkpointedFrames).toBe(quiet.walFrames);
  });

  test(`at D57's retention, the file stays under ${budget.fileMegabytes} MB`, () => {
    expect(quiet.projectedFileMegabytes).toBeLessThanOrEqual(budget.fileMegabytes);
  });

  test(
    `with a five-minute alarm, at most ${ALARM_EXTRA_COMMITS} commits more`,
    async () => {
      const loud = await day(spec, true);
      expect(loud.commits).toBeLessThanOrEqual(budget.commits + ALARM_EXTRA_COMMITS);
      expect(loud.commits - quiet.commits).toBeGreaterThanOrEqual(ALARM_EXTRA_COMMITS - 30);
      expect(loud.megabytes).toBeLessThanOrEqual(budget.megabytes);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("a faulty device (section 5, the warning cap)", () => {
  test(
    "a siren logging a warning every second costs no more than its 60 an hour",
    async () => {
      const home = await Home.create({
        name: "faulty",
        sensors: 0,
        sirens: 1,
        gateways: 1,
        seed: 3,
      });
      homes.push(home);
      must(home.advanceTo(10 * MINUTE));
      const store = home.store;
      if (store === undefined) return;
      const before = store.writer.stats.commits;
      const quietHour = (): void => {
        for (let s = 1; s <= 3600; s++) {
          home.siren("siren-1")?.log(2, 9, "fault");
          must(home.advanceBy(SECOND));
        }
      };
      quietHour();
      const commits = store.writer.stats.commits - before;
      // 60 warnings and the one that says the cap was reached; a routine flush every 5 minutes.
      expect(commits).toBeLessThanOrEqual(61 + 12 + 2);
      // Every warning is kept: those over the cap go with the routine batch.
      store.writer.flush("due")._unsafeUnwrap();
      expect(home.query<{ n: number }>("SELECT count(*) AS n FROM device_log")[0]?.n).toBe(3600);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("reads never commit (sections 3 and 11)", () => {
  test(
    "`hsn status`, `hsn site show` and `hsn devices` every minute for six hours cause no commit",
    async () => {
      const home = await Home.create({ ...HOME_A, seed: 9 });
      homes.push(home);
      const store = home.store;
      if (store === undefined) return;
      let commits = 0;
      let answered = 0;
      const staged: string[] = [];
      for (let minute = 1; minute <= 360; minute++) {
        must(home.advanceTo(minute * MINUTE));
        for (const command of [
          { kind: "status" },
          { kind: "siteShow" },
          { kind: "devices" },
        ] as const) {
          const before = store.writer.stats.commits;
          const records = home.records.length;
          const request = home.command(command);
          if (home.replyTo(request)?.ok === true) answered++;
          commits += store.writer.stats.commits - before;
          staged.push(...home.records.slice(records).map((r) => r.kind));
        }
      }
      expect(answered).toBe(3 * 360);
      expect(commits).toBe(0);
      // Each is recorded in `commands` (section 9), with the routine batch: nothing else.
      expect(new Set(staged)).toEqual(new Set(["command"]));
      expect(staged).toHaveLength(3 * 360);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("the largest site the size guard is set for (section 6)", () => {
  test(
    `a 64-sensor home (8 sirens, 3 gateways) stays under ${SIZE_GUARD_STOP_MB} MB at D57's retention`,
    async () => {
      const day64 = await day(HOME_C, false);
      // The marks measure the database's pages in use; the WAL (at most 8 MB) is a share of its own.
      const database = day64.projectedFileMegabytes - WAL_LIMIT_MB;
      console.log(
        `home C: ${database.toFixed(1)} MB of database pages at D57's retention, ${day64.projectedFileMegabytes.toFixed(1)} MB with the WAL`,
      );
      expect(database).toBeLessThan(SIZE_GUARD_STOP_MB);
    },
    DAYS_TEST_TIMEOUT_MS,
  );
});

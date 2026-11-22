/**
 * The write budget (hub-design.md section 11, "Write budget"; section 5, "Budget"; D112, HB35;
 * m2-design.md sections 3 and 10): a simulated day of homes A, B and C on the whole hub (every
 * real module, the loop of section 4, the real writer on a real SQLite file, scripted gateways,
 * sensors and sirens), counting commits and the bytes of every WAL frame, failing above the
 * limits; a second day with a five-minute alarm, allowed 300 more commits; the file's size
 * projected at D57's retention; the same days with M2's household (`day.ts`), whose sessions,
 * snapshots, history and notification reads never commit; a faulty device's warnings costing no
 * more than their 60 an hour; and `hsn`'s reads that never commit.
 *
 * Every limit is on work (commits, frames, rows, bytes), never on wall time, so a loaded machine
 * cannot make it flake.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { HOME_A, HOME_B, type HomeSpec, MINUTE, SECOND, Home, HOUR } from "../world/home.ts";
import { DAY_TEST_TIMEOUT_MS, DAYS_TEST_TIMEOUT_MS } from "../world/timeouts.ts";
import { type Day, day } from "./day.ts";
import { WAL_LIMIT_MB } from "./run.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";

/** The design's rule for every line (wave 3): the measured figure plus 10%, rounded up ‡. */
const lineOf = (measured: number): number => Math.ceil(measured * 1.1);
/**
 * The budget a day: commits, megabytes of WAL frames, the file at D57's retention (home C: its
 * database pages, the size guard's measure). Each line is the larger of the day without M2 and
 * the day with M2's household, measured on 2026-11-15 (Bun 1.4.2, this file's seeds, the daily
 * `client_sessions` record built, the day run past midnight), plus 10%. The figures before the
 * rule, the design's: A 800, 20, 70; B 1,400, 35, 120; C 2,400 ‡, 60 ‡, 210.
 */
const BUDGET = {
  A: { commits: lineOf(519), megabytes: lineOf(17.42), fileMegabytes: lineOf(69.12) },
  B: { commits: lineOf(939), megabytes: lineOf(29.52), fileMegabytes: lineOf(119.14) },
  // The WAL's line is the designer's 80 MB ‡, not the rule's (68.18 measured).
  C: { commits: lineOf(1680), megabytes: 80, fileMegabytes: lineOf(229.9) },
} as const;
/** An alarm adds a commit a second for its five minutes (section 5). */
const ALARM_EXTRA_COMMITS = 300;
/**
 * What M2's household may add to a day's commits: section 3 counts about 15 (6 actions, 4
 * schedule runs, 5 edits); this household makes 6 switches, 4 runs and 6 edits, and a chosen
 * folder's warning that it is on the data disk. Twice section 3's figure is the line: anything
 * near it means a read, a session or a notification has started to commit.
 */
const M2_EXTRA_COMMITS = 30;
/** The largest site the size guard's marks allow for (section 6): 64 sensors, 8 sirens, 3 gateways. */
const HOME_C: HomeSpec = { name: "C", sensors: 64, sirens: 8, gateways: 3 };
/**
 * The size guard's marks (section 6; D112 as amended by the product owner, in `DEFAULT_RULES`):
 * trimming stops under the lower, starts above the upper, and the database stops at the hard
 * stop. Home C's database at D57's retention, with M2's household, must stay under the lower mark,
 * so trimming never takes any of that retention.
 */
const SIZE_GUARD_MARKS_MB = {
  lower: DEFAULT_RULES.persistence.sizeGuard.stopBytes / (1024 * 1024),
  upper: DEFAULT_RULES.persistence.sizeGuard.startBytes / (1024 * 1024),
  hardStop: DEFAULT_RULES.persistence.sizeGuard.hardStopBytes / (1024 * 1024),
} as const;

const days: Day[] = [];
const homes: Home[] = [];
afterAll(() => {
  for (const d of days) d.home.close();
  for (const home of homes) home.close();
  days.length = 0;
  homes.length = 0;
});

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

async function measured(spec: HomeSpec, options: Parameters<typeof day>[1]): Promise<Day> {
  const d = await day(spec, options);
  days.push(d);
  return d;
}

/** The file's figure the budget limits: home C's database pages, A's and B's file with its WAL. */
function fileMegabytes(spec: HomeSpec, d: Day): number {
  const file = d.measured.projectedFileMegabytes;
  return spec.name === "C" ? file - WAL_LIMIT_MB : file;
}

describe.each([HOME_A, HOME_B, HOME_C])("a day of home $name (section 5)", (spec) => {
  const name = spec.name as "A" | "B" | "C";
  const budget = BUDGET[name];
  const timeout = name === "C" ? DAYS_TEST_TIMEOUT_MS : DAY_TEST_TIMEOUT_MS;
  let quiet: Day;

  test(
    `commits at most ${budget.commits} times`,
    async () => {
      quiet = await measured(spec, {});
      expect(quiet.measured.commits).toBeLessThanOrEqual(budget.commits);
      // Every commit is one of section 5's rules; the routine flushes at most one per five minutes.
      expect(quiet.measured.byReason.due).toBeLessThanOrEqual(288);
      expect(quiet.measured.byReason.size).toBe(0);
    },
    timeout,
  );

  const walLine = budget.megabytes;
  test(`writes at most ${walLine} MB of WAL frames`, () => {
    expect(quiet.measured.megabytes).toBeLessThanOrEqual(walLine);
    // The frames counted commit by commit are those the checkpoints report.
    expect(quiet.measured.checkpointedFrames).toBe(quiet.measured.walFrames);
  });

  test(`at D57's retention, ${name === "C" ? "the database stays under" : "the file stays under"} ${budget.fileMegabytes} MB`, () => {
    expect(fileMegabytes(spec, quiet)).toBeLessThanOrEqual(budget.fileMegabytes);
  });

  test(
    "with M2's household: within the budget, M2 adding at most its share, reads committing nothing",
    async () => {
      const busy = await measured(spec, { m2: true });
      const m2 = busy.m2;
      expect(m2).toBeDefined();
      if (m2 === undefined) return;
      // The household's day happened: every request answered, the four entries run, the switches.
      expect(m2.asked).toBe(13);
      expect(m2.answered).toBe(m2.asked);
      expect(m2.scheduleRuns).toBe(4);
      expect(m2.switches).toBeGreaterThanOrEqual(6 + 2);
      expect(m2.historyReads).toBe(m2.sessions);
      // The day's session records: one for each of the 7 clients that connected, past midnight.
      expect(m2.sessionRecords).toBe(7);
      expect(m2.notifications).toBeGreaterThan(0);
      expect(m2.reads).toBeGreaterThan(0);
      // The backup at the change and the daily one were written, each outside `hub.db`.
      expect(m2.backups.written).toBeGreaterThanOrEqual(2);
      expect(m2.backups.failed).toBe(0);
      // Sessions, snapshots, subscriptions, history, notification reads and `hub.status`: no commit.
      expect(m2.readCosts.length).toBeGreaterThan(6 * m2.sessions);
      expect(m2.readCosts.filter((r) => r.commits !== 0)).toEqual([]);
      // Within the home's budget, and M2 adding no more than its share.
      expect(busy.measured.commits).toBeLessThanOrEqual(budget.commits);
      expect(busy.measured.commits - quiet.measured.commits).toBeLessThanOrEqual(M2_EXTRA_COMMITS);
      expect(busy.measured.byReason.size).toBe(0);
      expect(busy.measured.megabytes).toBeLessThanOrEqual(walLine);
      expect(fileMegabytes(spec, busy)).toBeLessThanOrEqual(budget.fileMegabytes);
      // Home C's database pages stay under the size guard's lower mark: nothing of D57's retention
      // is ever trimmed.
      if (name === "C") expect(fileMegabytes(spec, busy)).toBeLessThan(SIZE_GUARD_MARKS_MB.lower);
      console.log(
        `home ${name}: M2 adds ${busy.measured.commits - quiet.measured.commits} commits, ` +
          `${(busy.measured.megabytes - quiet.measured.megabytes).toFixed(2)} MB of WAL, ` +
          `${(busy.measured.projectedFileMegabytes - quiet.measured.projectedFileMegabytes).toFixed(2)} MB at retention; ` +
          `${m2.notifications} notifications, ${m2.reads} read, ${m2.backups.written} backups; ` +
          (name === "C"
            ? `database ${fileMegabytes(spec, busy).toFixed(1)} MB against the size guard's marks ` +
              `${SIZE_GUARD_MARKS_MB.lower}, ${SIZE_GUARD_MARKS_MB.upper}, ${SIZE_GUARD_MARKS_MB.hardStop}`
            : `${(budget.fileMegabytes - fileMegabytes(spec, busy)).toFixed(1)} MB under the line`),
      );
    },
    timeout,
  );

  test.if(name !== "C")(
    `with a five-minute alarm, at most ${ALARM_EXTRA_COMMITS} commits more`,
    async () => {
      const loud = await measured(spec, { alarm: true });
      expect(loud.measured.commits).toBeLessThanOrEqual(budget.commits + ALARM_EXTRA_COMMITS);
      expect(loud.measured.commits - quiet.measured.commits).toBeGreaterThanOrEqual(
        ALARM_EXTRA_COMMITS - 30,
      );
      expect(loud.measured.megabytes).toBeLessThanOrEqual(budget.megabytes);
    },
    timeout,
  );
});

describe("the warning that no folder is chosen (m2-design.md sections 3 and 9, D112)", () => {
  test(
    "is raised once, at the first change a backup would hold, in one 'now' commit; never again",
    () => {
      const quiet = days.find((d) => d.home.spec.name === "A" && d.m2 === undefined);
      expect(quiet).toBeDefined();
      if (quiet === undefined) return;
      const h = quiet.home;
      // A day with no change a backup holds raises nothing (so section 3's first-day 245 is 244).
      expect(h.decisions("backup_no_folder")).toHaveLength(0);
      const rename = (from: string, to: string): void => {
        const request = h.command({ kind: "deviceRename", from, to });
        expect(h.replyTo(request)?.ok).toBe(true);
      };
      const commits = h.commitLog.length;
      rename("door-1", "front");
      expect(h.decisions("backup_no_folder")).toHaveLength(1);
      // The warning went in the rename's own commit: one "now" commit for both.
      const held = h.commitLog
        .slice(commits)
        .filter((c) =>
          c.items.some(
            (i) =>
              i.kind === "record" &&
              i.record.kind === "decision" &&
              i.record.row.kind === "backup_no_folder",
          ),
        );
      expect(held).toHaveLength(1);
      rename("door-2", "back");
      must(h.advanceBy(10 * MINUTE));
      must(h.restart("clean"));
      rename("door-3", "side");
      must(h.advanceBy(HOUR));
      expect(h.decisions("backup_no_folder")).toHaveLength(1);
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
      for (let s = 1; s <= 3600; s++) {
        home.siren("siren-1")?.log(2, 9, "fault");
        must(home.advanceBy(SECOND));
      }
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

/**
 * The budget's day of a home (hub-design.md section 5's day; m2-design.md section 3's household on
 * top of it), on the whole hub, measured at its end.
 *
 * Section 5's day: each sensor's door opens 10 times by morning (06:00 to 07:55) and evening
 * (18:05 to 21:55) while disarmed; armed at 07:59 and 17:59 by `hsn` with a countdown each time,
 * disarmed in time; the sirens' warnings spread over the day. With `alarm`, armed again at 22:00
 * and a five-minute alarm from 23:00.
 *
 * With `m2`, section 3's household on top: 4 people, 6 browsers and the console; a backup folder
 * chosen (so every change to people is backed up at once, and the daily backup is written);
 * settings edits (a group and four schedule entries at 00:01, a person renamed at 13:00); four
 * schedule runs (Disarmed at 05:30, the group armed at 12:00 and disarmed at 12:30, Away at
 * 23:00); six mode switches from the app (10:00, 10:05, 14:00, 14:05, 16:00, 16:05); and 60
 * sessions between 07:00 and 21:45, each a snapshot, a subscription, a page of history, the
 * notifications listed and the unread ones marked read, `hub.status` for Anna's laptop.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import { bootId } from "../../src/core/model/ids.ts";
import { mono } from "../../src/core/model/time.ts";
import { tempDir } from "../unit/storage/fixtures.ts";
import { DAY, Home, type HomeSpec, HOUR, MINUTE, SECOND } from "../world/home.ts";
import {
  ANNA_LAPTOP,
  BROWSERS,
  CONSOLE,
  homePorts,
  Household,
  type ReadCost,
  seedHousehold,
} from "./household.ts";
import { type DayMeasured, measureDay, type OlderRows, writeOlderRows } from "./run.ts";

/** Routine and event rows a day, from section 5's "Database size" table. */
export const OLDER: Record<"A" | "B" | "C", OlderRows> = {
  A: { routinePerDay: 21_330, eventPerDay: 450 },
  B: { routinePerDay: 32_890, eventPerDay: 1_300 },
  // A 64-sensor home: twice home B's rows and more, laid out as the day's retention deletes them.
  C: { routinePerDay: 70_000, eventPerDay: 2_700 },
};
/** Warnings and worse a day, as section 5's "Commits a day" assumes. */
const WARNINGS = { A: 20, B: 30, C: 60 } as const;

/** What M2's household did in the day, for the checks. */
export interface M2Day {
  readonly readCosts: readonly ReadCost[];
  readonly sessions: number;
  readonly answered: number;
  readonly asked: number;
  readonly reads: number;
  readonly historyReads: number;
  readonly backups: { readonly written: number; readonly failed: number };
  readonly scheduleRuns: number;
  /** The day's `client_sessions` records (one per client that connected). */
  readonly sessionRecords: number;
  readonly switches: number;
  readonly notifications: number;
}

export interface Day {
  readonly measured: DayMeasured;
  readonly home: Home;
  readonly m2: M2Day | undefined;
  /** Commits by the reasons of each "now" commit: those with a "now" item. */
  readonly nowCommits: number;
}

/** A day that could not be measured: every limit fails on it. */
const UNMEASURED: DayMeasured = {
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

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

export async function day(
  spec: HomeSpec,
  options: { readonly alarm?: boolean; readonly m2?: boolean },
): Promise<Day> {
  const name = spec.name as "A" | "B" | "C";
  const alarm = options.alarm ?? false;
  const ports = homePorts();
  const home = await Home.create(
    { ...spec, seed: 5, calendar: ports.calendar, files: ports.files },
    (store) => {
      // Written by the boot before the day's, so their numbers are below every one of the day's.
      writeOlderRows(store, OLDER[name], bootId(store.boot.id - 1));
      if (options.m2 === true) seedHousehold(store);
    },
  );
  ports.attach(home);
  home.scriptDesignDoors(10, [
    [6 * HOUR, 7 * HOUR + 55 * MINUTE],
    [18 * HOUR + 5 * MINUTE, 21 * HOUR + 55 * MINUTE],
  ]);
  const actions: { at: number; act: () => void }[] = [];
  for (const at of [8 * HOUR, 18 * HOUR]) {
    actions.push({
      at: at - MINUTE,
      act: () => home.command({ kind: "arm", sensors: "all", continue: true }),
    });
    home.sensor("door-1")?.door(mono(at), true);
    home.sensor("door-1")?.door(mono(at + 10 * SECOND), false);
    actions.push({
      at: at + 20 * SECOND,
      act: () => home.command({ kind: "disarm", sensors: "all" }),
    });
  }
  const warnings = WARNINGS[name];
  for (let w = 0; w < warnings; w++) {
    actions.push({
      at: Math.floor(((w + 0.5) * DAY) / warnings),
      act: () => home.sirens[w % home.sirens.length]?.siren.log(2, 9, "battery low"),
    });
  }
  if (alarm) {
    actions.push({
      at: 22 * HOUR,
      act: () => home.command({ kind: "arm", sensors: "all", continue: false }),
    });
    home.sensor("door-1")?.door(mono(23 * HOUR), true);
    home.sensor("door-1")?.door(mono(23 * HOUR + 20 * SECOND), false);
  }
  const household = options.m2 === true ? new Household(home) : undefined;
  const m2 = household === undefined ? undefined : m2Script(home, household, actions);
  const sorted = actions.toSorted((a, b) => a.at - b.at);
  for (const action of sorted) {
    must(home.advanceTo(action.at));
    action.act();
  }
  // Past local midnight (Europe/London is UTC in November): the day's `client_sessions` records
  // are written at the first input of the next day, so a day that stopped at 24:00 would hide them.
  must(home.advanceTo(DAY + MINUTE));
  // The two countdowns ended in time; the alarm, if asked for, came.
  expect(home.decisions("countdown_started").length).toBeGreaterThanOrEqual(alarm ? 3 : 2);
  expect(home.decisions("alarm")).toHaveLength(alarm ? 1 : 0);
  const store = home.store;
  expect(store).toBeDefined();
  if (store === undefined) return { measured: UNMEASURED, home, m2: undefined, nowCommits: 0 };
  const nowCommits = home.commitLog.filter((c) =>
    c.items.some((item) => item.durability === "now"),
  ).length;
  const measured = measureDay(store, store.boot.id);
  console.log(
    `home ${name}${alarm ? " with an alarm" : ""}${household === undefined ? "" : " with M2's household"}: ` +
      `${measured.commits} commits (${JSON.stringify(measured.byReason)}; ${nowCommits} holding "now" items), ` +
      `${measured.walFrames} WAL frames = ${measured.megabytes.toFixed(2)} MB, ` +
      `${measured.routineRows} routine and ${measured.eventRows} event rows, ` +
      `${measured.projectedFileMegabytes.toFixed(1)} MB at D57's retention (${(measured.projectedFileMegabytes - 8).toFixed(1)} MB of pages); ` +
      `rows by table ${JSON.stringify(measured.rowsByTable)}`,
  );
  return { measured, home, m2: m2?.(), nowCommits };
}

/** M2's household's day, added to `actions`; what it did, read at the day's end. */
function m2Script(
  home: Home,
  household: Household,
  actions: { at: number; act: () => void }[],
): () => M2Day {
  const folder = tempDir("backups");
  mkdirSync(join(folder.path, "hsn"), { recursive: true });
  let asked = 0;
  let answered = 0;
  let reads = 0;
  const ask = (conn: ReturnType<Household["connect"]>, id: number): void => {
    asked++;
    if (household.reply(conn, id)?.ok === true) answered++;
  };
  actions.push({
    at: SECOND,
    act: () => {
      household.facts();
      const conn = household.connect(CONSOLE);
      ask(
        conn,
        household.request(conn, CONSOLE, {
          op: "backup.settings",
          body: { folder: join(folder.path, "hsn") },
        }),
      );
      const half = home.sensors.slice(0, Math.ceil(home.sensors.length / 2)).map((m) => m.row.id);
      const groupAsk = household.request(conn, CONSOLE, {
        op: "group.create",
        body: { name: "Downstairs", sensors: half, sirens: "all" },
      });
      ask(conn, groupAsk);
      const group = (household.reply(conn, groupAsk)?.ok === true &&
        (household.reply(conn, groupAsk) as { body: { id: number } }).body.id) as number;
      for (const [entry, action, target, at] of [
        ["Morning", "switchMode", { mode: 2 }, "05:30"],
        ["Noon", "arm", { group }, "12:00"],
        ["After noon", "disarm", { group }, "12:30"],
        ["Night", "switchMode", { mode: 1 }, "23:00"],
      ] as const)
        ask(
          conn,
          household.request(conn, CONSOLE, {
            op: "schedule.create",
            body: { name: entry, action, target, at, days: "everyDay", enabled: true },
          }),
        );
      household.close(conn);
    },
  });
  for (const [at, mode] of [
    [10 * HOUR, 1],
    [10 * HOUR + 5 * MINUTE, 2],
    [14 * HOUR, 1],
    [14 * HOUR + 5 * MINUTE, 2],
    [16 * HOUR, 1],
    [16 * HOUR + 5 * MINUTE, 2],
  ] as const)
    actions.push({
      at,
      act: () => {
        const conn = household.connect(ANNA_LAPTOP);
        ask(conn, household.request(conn, ANNA_LAPTOP, { op: "mode.switch", body: { mode } }));
        household.close(conn);
      },
    });
  actions.push({
    at: 13 * HOUR,
    act: () => {
      const conn = household.connect(ANNA_LAPTOP);
      ask(
        conn,
        household.request(conn, ANNA_LAPTOP, {
          op: "person.rename",
          body: { person: 4, name: "Daniel", ifRevision: 0 },
        }),
      );
      household.close(conn);
    },
  });
  const sessions = 60;
  for (let i = 0; i < sessions; i++) {
    const browser = BROWSERS[i % BROWSERS.length];
    if (browser === undefined) continue;
    actions.push({
      at: 7 * HOUR + i * 15 * MINUTE + 7 * SECOND,
      act: () => {
        household.visit(browser.client, (conn) => {
          const list = household.home.app.findLast(
            (e) => e.kind === "appSend" && e.conn === conn && "t" in e.message,
          );
          if (list?.kind !== "appSend" || !("t" in list.message) || list.message.t !== "res")
            return [];
          if (!list.message.ok) return [];
          const body = list.message.body as {
            notifications?: readonly { seq: number; read: boolean }[];
          };
          const unread = (body.notifications ?? []).filter((n) => !n.read).map((n) => n.seq);
          reads += unread.length;
          return unread;
        });
      },
    });
  }
  return () => {
    const result: M2Day = {
      readCosts: household.readCosts,
      sessions,
      answered,
      asked,
      reads,
      historyReads: household.channel("historyRead"),
      backups: household.backups(),
      scheduleRuns: home.decisions("schedule_ran").length,
      sessionRecords: home.hubEvents("client_sessions").length,
      switches: home.decisions("mode_switched").length,
      notifications:
        home.query<{ n: number }>("SELECT count(*) AS n FROM notifications")[0]?.n ?? 0,
    };
    folder.remove();
    return result;
  };
}

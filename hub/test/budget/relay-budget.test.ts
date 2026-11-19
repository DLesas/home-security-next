/**
 * The write budget and the longest turn with the relay in use (docs/m4-design.md section 4, "Write
 * budget": "The budget test (HD 11, M2 section 10) adds them and must show no new commit"; section
 * 11, "Budget and the Pi"). The largest home of the budget (home C: 64 sensors, 8 sirens, 3
 * gateways), section 5's day as `day.ts` runs it, with M2's household's people and browsers, on the
 * whole hub with the real writer, twice: once with no relay, once with a relay in use, the four
 * people's phones registered for push, every notification pushed through a scripted relay client
 * that accepts every push, and an outage of the relay link of 25 minutes over the evening's arming
 * and countdown, with its burst on return. Both days are measured the same way and against the
 * budget's line for home C (`budget.test.ts`: 1,848 commits, 80 MB of WAL frames).
 *
 * The relay client here is the loop's port answered at once: `relayConnect` is answered `relayLink
 * {up}`, each `pushSend` `pushResults {accepted}`, and the outage is `relayLink {down}`, then `up`.
 * The shell's own costs (sealing, the socket) are B6's and not the core's commits.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { bootId } from "../../src/core/model/ids.ts";
import { mono } from "../../src/core/model/time.ts";
import type { OpenedStore } from "../../src/shell/storage/store.ts";
import { DAY, Home, type HomeSpec, HOUR, MINUTE, SECOND } from "../world/home.ts";
import { DAYS_TEST_TIMEOUT_MS } from "../world/timeouts.ts";
import { OLDER } from "./day.ts";
import { homePorts, PEOPLE, seedHousehold } from "./household.ts";
import { ScriptedRelayClient, seedPhones } from "./relay-world.ts";
import { type DayMeasured, measureDay, writeOlderRows } from "./run.ts";

/** Home C, as `budget.test.ts` has it. */
const HOME_C: HomeSpec = { name: "C", sensors: 64, sirens: 8, gateways: 3 };
/** `budget.test.ts`'s line for home C (the measured figure plus 10%, and the designer's 80 MB). */
const BUDGET_C = { commits: Math.ceil(1680 * 1.1), megabytes: 80 } as const;
/**
 * M2's limit a turn ‡ (m2-design.md section 3): reported against, not asserted, since a turn's
 * time is this machine's (asserted only with `HSN_TIMING=1` in `loop-limit.test.ts`).
 */
const TURN_LIMIT_MS = 20;
/** The phones: one per person of the household, client ids after the browsers'. */
const PHONES = PEOPLE.map((person, i) => ({ client: 13 + i, person: person.id }));
const OUTAGE = { from: 17 * HOUR + 45 * MINUTE, to: 18 * HOUR + 10 * MINUTE } as const;

/** A record's kind and code, for the histogram of "now" commits. */
function recordName(record: unknown): string {
  const r = record as {
    readonly kind?: string;
    readonly row?: { readonly code?: string; readonly kind?: string };
  };
  return `${r.kind ?? ""}:${r.row?.code ?? r.row?.kind ?? ""}`;
}

/** The relay module's own tables and records: a commit of these alone is one the relay added. */
const RELAY_ITEMS = new Set([
  "push_outbox",
  "push_targets",
  "push_keys",
  "relay_settings",
  "hubEvent:relay_link",
  "hubEvent:relay_unreachable",
  "hubEvent:relay_reachable",
  "hubEvent:relay_identity_in_use",
  "hubEvent:push_dropped",
]);

/** A day that could not be measured: every expectation on it fails. */
const UNMEASURED: RelayDay = {
  measured: {
    commits: Number.POSITIVE_INFINITY,
    byReason: { now: 0, due: 0, size: 0, cadence: 0, log: 0, stop: 0 },
    walFrames: 0,
    checkpointedFrames: 0,
    megabytes: Number.POSITIVE_INFINITY,
    routineRows: 0,
    eventRows: 0,
    rowsByTable: {},
    projectedFileMegabytes: Number.POSITIVE_INFINITY,
  },
  longestTurnMs: Number.POSITIVE_INFINITY,
  pushed: 0,
  outbox: -1,
  countdowns: -1,
  unreachable: -1,
  overdue: -1,
  relayRecords: {},
  nowByTables: {},
  relayOnlyNow: -1,
  longest: [],
};

interface RelayDay {
  readonly measured: DayMeasured;
  readonly longestTurnMs: number;
  readonly pushed: number;
  readonly outbox: number;
  readonly countdowns: number;
  readonly unreachable: number;
  readonly overdue: number;
  readonly relayRecords: Readonly<Record<string, number>>;
  /** Commits holding a "now" item, by the tables of their "now" items. */
  readonly nowByTables: Readonly<Record<string, number>>;
  /** "Now" commits whose "now" items are all the relay's: commits the relay added. */
  readonly relayOnlyNow: number;
  /** The three longest turns after the start, with the home's time of each. */
  readonly longest: readonly string[];
}

const homes: Home[] = [];
afterAll(() => {
  for (const home of homes) home.close();
});

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

/** Section 5's day of home C with the household's people, with or without the relay. */
async function relayDay(withRelay: boolean): Promise<RelayDay> {
  const ports = homePorts();
  const relay = new ScriptedRelayClient();
  // The loop reads the stopwatch at a turn's start and at its end: each pair is one turn's time,
  // kept with the home's true time, so the longest turns can be named.
  const turns: { readonly ms: number; readonly atUs: number }[] = [];
  let started: number | undefined;
  const homeRef: { home: Home | undefined } = { home: undefined };
  const stopwatch = (): number => {
    const now = performance.now();
    if (started === undefined) started = now;
    else {
      turns.push({ ms: now - started, atUs: homeRef.home?.now ?? 0 });
      started = undefined;
    }
    return now;
  };
  const home = await Home.create(
    {
      ...HOME_C,
      seed: 5,
      calendar: ports.calendar,
      files: ports.files,
      stopwatch,
      ...(withRelay ? { relay } : {}),
    },
    (store) => {
      writeOlderRows(store, OLDER.C, bootId(store.boot.id - 1));
      seedHousehold(store);
      if (withRelay) seedPhones(store, PHONES);
    },
  );
  homes.push(home);
  homeRef.home = home;
  relay.home = home;
  ports.attach(home);
  // Started before the port knew its home: the link the boot asked for, now.
  if (withRelay) relay.connectNow();
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
  for (let w = 0; w < 60; w++)
    actions.push({
      at: Math.floor(((w + 0.5) * DAY) / 60),
      act: () => {
        home.sirens[w % home.sirens.length]?.siren.log(2, 9, "battery low");
      },
    });
  if (withRelay) {
    actions.push({
      at: OUTAGE.from,
      act: () => {
        relay.cut();
      },
    });
    actions.push({
      at: OUTAGE.to,
      act: () => {
        relay.mend();
      },
    });
  }
  for (const action of actions.toSorted((a, b) => a.at - b.at)) {
    must(home.advanceTo(action.at));
    action.act();
  }
  must(home.advanceTo(DAY + MINUTE));
  // The start's turns, opening the database and the first links, are exempt (section 3).
  const day = turns.filter((t) => t.atUs > MINUTE);
  const longestTurnMs = Math.max(...day.map((t) => t.ms));
  const longest = day
    .toSorted((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((t) => `${t.ms.toFixed(1)} ms at ${(t.atUs / HOUR).toFixed(3)} h`);
  const store: OpenedStore | undefined = home.store;
  expect(store).toBeDefined();
  if (store === undefined) return UNMEASURED;
  const measured = measureDay(store, store.boot.id);
  const count = (sql: string) => home.query<{ n: number }>(sql)[0]?.n ?? 0;
  const relayRecords: Record<string, number> = {};
  for (const code of ["relay_link", "relay_unreachable", "relay_reachable", "push_dropped"])
    relayRecords[code] = home.hubEvents(code).length;
  const nowByTables: Record<string, number> = {};
  let relayOnlyNow = 0;
  for (const commit of home.commitLog) {
    const now = commit.items.filter((item) => item.durability === "now");
    if (now.length === 0) continue;
    const names = [
      ...new Set(
        now.map((item) => (item.kind === "write" ? item.op.table : recordName(item.record))),
      ),
    ].toSorted();
    if (names.every((name) => RELAY_ITEMS.has(name))) relayOnlyNow += 1;
    const key = names.join("+");
    nowByTables[key] = (nowByTables[key] ?? 0) + 1;
  }
  return {
    longest,
    nowByTables,
    relayOnlyNow,
    measured,
    longestTurnMs,
    pushed: relay.sent.length,
    outbox: count("SELECT count(*) AS n FROM push_outbox"),
    countdowns: home.decisions("countdown_started").length,
    unreachable: home.hubEvents("relay_unreachable").length,
    overdue: home.loop?.overdue.length ?? 0,
    relayRecords,
  };
}

describe("the write budget with the relay in use (home C's day)", () => {
  test(
    "phones registered, every notification pushed, an outage and its burst: no new commit, within M2's limits",
    async () => {
      const without = await relayDay(false);
      const withRelay = await relayDay(true);
      const line = (name: string, d: RelayDay) =>
        `${name}: ${d.measured.commits} commits (${JSON.stringify(d.measured.byReason)}), ` +
        `${d.measured.megabytes.toFixed(2)} MB of WAL frames, longest turn ${d.longestTurnMs.toFixed(1)} ms (${d.longest.join(", ")}); ` +
        `${d.pushed} pushes, ${d.outbox} rows left in the outbox, records ${JSON.stringify(d.relayRecords)}`;
      console.log(
        `home C's day, against its line of ${BUDGET_C.commits} commits and ${BUDGET_C.megabytes} MB, and M2's ${TURN_LIMIT_MS} ms a turn ‡:\n` +
          `  ${line("without the relay", without)}\n  ${line("with the relay", withRelay)}\n` +
          `  the relay's difference: ${withRelay.measured.commits - without.measured.commits} commits, ` +
          `${(withRelay.measured.megabytes - without.measured.megabytes).toFixed(2)} MB\n` +
          `  "now" commits by their tables, without: ${JSON.stringify(without.nowByTables)}\n` +
          `  with: ${JSON.stringify(withRelay.nowByTables)}`,
      );
      // The day ran as the budget's does, with its countdowns, and the relay was used.
      expect(withRelay.countdowns).toBe(without.countdowns);
      expect(withRelay.pushed).toBeGreaterThan(0);
      expect(withRelay.outbox).toBe(0);
      // The outage was long enough to be one (180 s ‡), once.
      expect(withRelay.unreachable).toBe(1);
      // Within M2's limits for this home.
      expect(withRelay.measured.commits).toBeLessThanOrEqual(BUDGET_C.commits);
      expect(withRelay.measured.megabytes).toBeLessThanOrEqual(BUDGET_C.megabytes);
      // No new commit: the outbox rides on its notifications' commits, and its deletes and the
      // routine records on the writer's own flushes (as many on both days); the one "now" commit
      // the design adds is the outage's `relay_unreachable` warning (section 4, "Records"). The
      // days' other counts differ by a few commits of device traffic, the home's random draws
      // falling differently once the relay's inputs take their entropy.
      expect(withRelay.relayOnlyNow).toBe(withRelay.unreachable);
      expect(without.relayOnlyNow).toBe(0);
      expect(withRelay.measured.byReason.due).toBe(without.measured.byReason.due);
      expect(withRelay.measured.byReason.cadence).toBe(without.measured.byReason.cadence);
      // The loop's guard never engaged.
      expect(withRelay.overdue).toBe(0);
      expect(without.overdue).toBe(0);
    },
    DAYS_TEST_TIMEOUT_MS,
  );
});

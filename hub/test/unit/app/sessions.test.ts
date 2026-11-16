/**
 * Session records (m2-design.md section 3, "Session records", corrected in wave 3; section 4): one
 * `client_sessions` hub event per client per day, info, routine, `{client, sessions, firstMs,
 * lastMs}`, written when the hub's local day ends; nothing per session, and no commit of its own.
 */
import { describe, expect, test } from "bun:test";
import type { Effect } from "../../../src/core/model/effects.ts";
import { MODULES } from "../../../src/core/step.ts";
import { makeCalendar } from "../../../src/shell/calendar/calendar.ts";
import {
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN_LAPTOP,
  household,
  Hub,
  MINUTE,
  SECOND,
  testModules,
  WALL_AT_START,
} from "../people/support/hub.ts";

const HOUR = 60 * MINUTE;

function sessionRecords(effects: readonly Effect[]) {
  return effects.flatMap((e) =>
    e.kind === "record" &&
    e.record.kind === "hubEvent" &&
    (e.record.row.code === "client_sessions" ||
      e.record.row.code === "client_connected" ||
      e.record.row.code === "client_closed")
      ? [
          {
            code: e.record.row.code,
            level: e.record.row.level,
            durability: e.durability,
            detail: JSON.parse(e.record.row.detail ?? "{}") as Record<string, number>,
          },
        ]
      : [],
  );
}

function booted(): Hub {
  const hub = new Hub();
  hub.boot(household());
  return hub;
}

/** Hours later on the hub's clocks. */
function later(hub: Hub, micros: number): void {
  hub.at = (hub.at + micros) as typeof hub.at;
}

/** A session of `client`, opened and closed. */
function session(hub: Hub, client: typeof ANNA_LAPTOP): readonly Effect[] {
  const conn = hub.connect(client);
  const opened = hub.steps.at(-1) ?? [];
  later(hub, SECOND);
  const closed = hub.input({ kind: "clientClosed", conn, reason: "remote" });
  return [...opened, ...closed];
}

describe("one record per client per day (section 3)", () => {
  test("many sessions of one client in a day: one record, its count, first and last moment", () => {
    const hub = booted();
    const all: Effect[] = [];
    const first = hub.wall();
    for (let i = 0; i < 5; i++) {
      all.push(...session(hub, ANNA_LAPTOP));
      later(hub, HOUR);
    }
    expect(sessionRecords(all)).toEqual([]);
    const lastClose = WALL_AT_START + Math.floor((hub.at - HOUR) / 1000);
    later(hub, 24 * HOUR);
    const effects = hub.input({ kind: "tick" });
    expect(sessionRecords(effects)).toEqual([
      {
        code: "client_sessions",
        level: "info",
        durability: "routine",
        detail: { client: ANNA_LAPTOP, sessions: 5, firstMs: first, lastMs: lastClose },
      },
    ]);
    // Written once: the next input writes nothing more.
    expect(sessionRecords(hub.input({ kind: "tick" }))).toEqual([]);
  });

  test("two clients: two records, in client order", () => {
    const hub = booted();
    session(hub, BEN_LAPTOP);
    session(hub, ANNA_LAPTOP);
    session(hub, BEN_LAPTOP);
    later(hub, 24 * HOUR);
    expect(
      sessionRecords(hub.input({ kind: "tick" })).map((r) => [r.detail.client, r.detail.sessions]),
    ).toEqual([
      [ANNA_LAPTOP, 1],
      [BEN_LAPTOP, 2],
    ]);
  });

  test("the day's boundary: sessions after midnight are the next day's record", () => {
    const hub = booted();
    // The hub starts at 00:00:01 UTC; the test calendar's day is UTC's.
    later(hub, 23 * HOUR);
    session(hub, ANNA_LAPTOP);
    later(hub, 2 * HOUR);
    const at = hub.steps.length;
    session(hub, ANNA_LAPTOP);
    const written = hub.steps.slice(at).flat();
    expect(sessionRecords(written).map((r) => r.detail.sessions)).toEqual([1]);
    later(hub, 24 * HOUR);
    expect(sessionRecords(hub.input({ kind: "tick" })).map((r) => r.detail.sessions)).toEqual([1]);
  });

  test("the hub's own time zone decides its midnight (here New York's, at 05:00 UTC)", () => {
    const calendar = makeCalendar();
    expect(calendar.isOk()).toBe(true);
    if (calendar.isErr()) return;
    const hub = new Hub(testModules({ schedules: MODULES.schedules }), calendar.value);
    hub.boot(household());
    hub.input({ kind: "timeZone", zone: "America/New_York" });
    // 00:00 UTC on 14 November is 19:00 the day before in New York.
    session(hub, ANNA_LAPTOP);
    later(hub, 4 * HOUR);
    expect(sessionRecords(hub.input({ kind: "tick" }))).toEqual([]);
    later(hub, 2 * HOUR);
    expect(sessionRecords(hub.input({ kind: "tick" })).map((r) => r.detail.client)).toEqual([
      ANNA_LAPTOP,
    ]);
  });

  test("a client removed during the day still has its record of the day's sessions", () => {
    const hub = booted();
    session(hub, ANNA_PHONE);
    const anna = hub.connect(ANNA_LAPTOP);
    hub.request(anna, ANNA_LAPTOP, { op: "client.remove", body: { client: ANNA_PHONE, also: [] } });
    later(hub, 24 * HOUR);
    expect(
      sessionRecords(hub.input({ kind: "tick" })).map((r) => [r.detail.client, r.detail.sessions]),
    ).toEqual([
      [ANNA_LAPTOP, 1],
      [ANNA_PHONE, 1],
    ]);
  });
});

describe("no commit of its own (section 3's budget)", () => {
  test("a connect, a snapshot, a subscription and a close write nothing now", () => {
    const hub = booted();
    const from = hub.steps.length;
    const conn = hub.connect(ANNA_LAPTOP);
    hub.request(conn, ANNA_LAPTOP, { op: "snapshot", body: {} });
    hub.request(conn, ANNA_LAPTOP, { op: "subscribe", body: { topics: ["arming"] } });
    hub.input({ kind: "clientClosed", conn, reason: "remote" });
    const now = hub.steps
      .slice(from)
      .flat()
      .filter((e) => (e.kind === "write" || e.kind === "record") && e.durability === "now");
    expect(now).toEqual([]);
  });
});

describe("a restart in the middle of a day (section 3: a crash loses that day's count)", () => {
  test("the sessions before it are lost, those after it written once at the day's end", () => {
    const hub = booted();
    session(hub, ANNA_LAPTOP);
    session(hub, ANNA_LAPTOP);
    later(hub, HOUR);
    const restarted = new Hub();
    restarted.at = hub.at;
    restarted.boot(household(), 2);
    session(restarted, ANNA_LAPTOP);
    later(restarted, 24 * HOUR);
    expect(sessionRecords(restarted.input({ kind: "tick" })).map((r) => r.detail.sessions)).toEqual(
      [1],
    );
  });
});

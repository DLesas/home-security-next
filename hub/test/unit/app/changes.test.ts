/**
 * Live events made from the state they report (`core/app/changes.ts`; m2-design.md section 5,
 * "Live updates"): a countdown's end, however it ends, and the site's settings, however they
 * change. Each transition is made on the alarm's or the site's state between two inputs, as any
 * module's handling would leave it, so no path that changes them can go unseen.
 */
import { describe, expect, test } from "bun:test";
import type { AppEvent } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { ConnId, DeviceId } from "../../../src/core/model/ids.ts";
import { ArmState, type SiteRow } from "../../../src/core/model/rows.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  BEN,
  BEN_LAPTOP,
  FRONT,
  GARAGE,
  household,
  Hub,
  permission,
  role,
  siteRow,
} from "../people/support/hub.ts";

function managed(row: SiteRow = siteRow()): { hub: Hub; anna: ConnId; ben: ConnId } {
  const hub = new Hub();
  const base = household({
    userManagement: true,
    roles: [role(ANNA, true, true), role(BEN, false, false)],
    permissions: [
      permission(ANNA, FRONT, true, true),
      permission(ANNA, GARAGE, true, true),
      permission(BEN, FRONT, true, true),
    ],
  });
  hub.boot({ ...base, site: row });
  const sub = (client: typeof ANNA_LAPTOP) => {
    const conn = hub.connect(client);
    hub.request(conn, client, { op: "subscribe", body: { topics: ["arming", "config"] } });
    return conn;
  };
  return { hub, anna: sub(ANNA_LAPTOP), ben: sub(BEN_LAPTOP) };
}

function events(effects: readonly Effect[], conn: ConnId, ev: string): readonly AppEvent[] {
  return effects.flatMap((e) =>
    e.kind === "appSend" &&
    e.conn === conn &&
    "t" in e.message &&
    e.message.t === "evt" &&
    e.message.ev === ev
      ? [e.message]
      : [],
  );
}

/** The alarm's state as a module would leave it: these sensors counting, each armed or not. */
function alarm(hub: Hub, counting: readonly DeviceId[], arm: ReadonlyMap<DeviceId, number>): void {
  const sensors = new Map(hub.state.alarm.sensors);
  for (const [sensor, state] of arm) {
    const was = sensors.get(sensor);
    if (was !== undefined) sensors.set(sensor, { ...was, arm: state as never });
  }
  const countdowns = new Map(counting.map((sensor) => [sensor, {} as never]));
  hub.state = { ...hub.state, alarm: { ...hub.state.alarm, sensors, countdowns } };
}

describe("a countdown's end, however it ends, told once (section 6: cancelled, ended)", () => {
  test.each([
    ["it runs out into the alarm (still armed)", ArmState.Armed, "ended"],
    ["the alarm took it, the door left waiting", ArmState.WaitsForCloseAfterAlarm, "ended"],
    ["a disarm or a mode switch that disarms it", ArmState.Disarmed, "cancelled"],
  ] as const)("%s: %s → %s", (_how, after, what) => {
    const { hub, anna, ben } = managed();
    alarm(
      hub,
      [GARAGE, FRONT],
      new Map([
        [GARAGE, ArmState.Armed],
        [FRONT, ArmState.Armed],
      ]),
    );
    hub.input({ kind: "tick" });
    alarm(
      hub,
      [],
      new Map([
        [GARAGE, after],
        [FRONT, after],
      ]),
    );
    const effects = hub.input({ kind: "tick" });
    const told = (conn: ConnId) =>
      events(effects, conn, "countdown").map((e) => {
        const body = e.body as { sensor: number; what: string };
        return [body.sensor, body.what];
      });
    expect(told(anna)).toEqual([
      [FRONT, what],
      [GARAGE, what],
    ]);
    // Ben may view the front door only.
    expect(told(ben)).toEqual([[FRONT, what]]);
    // Once: the next input tells nothing more.
    expect(events(hub.input({ kind: "tick" }), anna, "countdown")).toEqual([]);
  });

  test("a countdown still running is not ended", () => {
    const { hub, anna } = managed();
    alarm(hub, [GARAGE, FRONT], new Map());
    hub.input({ kind: "tick" });
    alarm(hub, [FRONT], new Map([[GARAGE, ArmState.Armed]]));
    const effects = hub.input({ kind: "tick" });
    expect(
      events(effects, anna, "countdown").map((e) => (e.body as { sensor: number }).sensor),
    ).toEqual([GARAGE]);
  });
});

describe("the site's settings, however they change (config {site})", () => {
  function changed(row: (r: SiteRow) => SiteRow, from: SiteRow = siteRow()) {
    const { hub, anna, ben } = managed(from);
    hub.state = { ...hub.state, site: { ...hub.state.site, row: row(hub.state.site.row) } };
    const effects = hub.input({ kind: "tick" });
    return {
      anna: events(effects, anna, "config").map((e) => e.body),
      ben: events(effects, ben, "config").map((e) => e.body),
    };
  }

  test("a survey choosing the channel (the hub's own choice): to every subscriber", () => {
    const told = changed((r) => ({ ...r, channel: 2 }), siteRow({ channel: null }));
    expect(told.anna).toMatchObject([{ site: { channel: 2 } }]);
    expect(told.ben).toMatchObject([{ site: { channel: 2 } }]);
  });

  test.each([
    ["the rate", (r: SiteRow) => ({ ...r, rateMask: 1 << 3 })],
    ["the countdown", (r: SiteRow) => ({ ...r, countdownDefaultS: 45 })],
    ["the Wi-Fi name", (r: SiteRow) => ({ ...r, wifiName: new TextEncoder().encode("attic") })],
    ["a retention", (r: SiteRow) => ({ ...r, retentionRoutineDays: 10 })],
  ] as const)("%s: one config {site} event", (_what, row) => {
    expect(changed(row).anna).toHaveLength(1);
  });

  test("a change of what the site does not show (the Wi-Fi password, a move's stage): none", () => {
    expect(
      changed((r) => ({ ...r, wifiPassword: new TextEncoder().encode("new secret") })).anna,
    ).toEqual([]);
    expect(changed((r) => ({ ...r, moveId: 3, moveStage: 1 })).anna).toEqual([]);
  });

  test("hsn site set: announced to the apps too", () => {
    const { hub, anna } = managed();
    const effects = hub.command({ kind: "siteSet", countdown: 50 });
    expect(events(effects, anna, "config")).toMatchObject([{ body: { site: { countdownS: 50 } } }]);
  });
});

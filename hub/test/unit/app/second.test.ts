/**
 * What section 11's "Step 1's questions" settled for app (owner A3, second pass): `hub.status` and
 * `usb.list`, the M1a refusal table, device removal, `backup.key`'s record, and the `config`,
 * `site`, `health`, `hub`, `record` and `notification` events.
 */
import { describe, expect, test } from "bun:test";
import type { AppEvent, NotificationObject } from "@hsn/protocol/app";
import type { Effect } from "../../../src/core/model/effects.ts";
import { clientId, scheduleId, seq } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { ScheduleAction } from "../../../src/core/model/rows.ts";
import { MODULES } from "../../../src/core/step.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import { ok } from "neverthrow";
import {
  ANNA,
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN,
  BEN_LAPTOP,
  codeOf,
  commandRows,
  CONSOLE_CLIENT,
  emitter,
  eventsTo,
  FRONT,
  GARAGE,
  household,
  Hub,
  onlyReply,
  permission,
  role,
  testModules,
} from "../people/support/hub.ts";

const UM = {
  userManagement: true,
  roles: [role(ANNA, true, true), role(BEN, false, false)],
  permissions: [
    permission(ANNA, FRONT, true, true),
    permission(ANNA, GARAGE, true, true),
    permission(BEN, FRONT, true, true),
  ],
} as const;

function hubWith(modules = testModules()): Hub {
  const hub = new Hub(modules);
  hub.boot(household(UM));
  return hub;
}

function subscribe(hub: Hub, client: typeof ANNA_LAPTOP, topics: readonly string[]) {
  const conn = hub.connect(client);
  hub.request(conn, client, { op: "subscribe", body: { topics: topics as never } });
  return conn;
}

function evs(
  effects: readonly Effect[],
  conn: Parameters<typeof eventsTo>[1],
): readonly AppEvent[] {
  return eventsTo(effects, conn);
}

function decision(kind: string, device: number | null, value: number | null = null): Internal {
  return {
    kind: "auditRecord",
    durability: "now",
    record: {
      kind: "decision",
      row: {
        seq: seq(2 ** 32 + 500),
        atMs: 1_000,
        clockOk: true,
        kind: kind as never,
        deviceId: device as never,
        causeSeq: null,
        value,
        detail: null,
      },
    },
  };
}

describe("operations the shell or a view answers (section 6)", () => {
  test("hub.status: manage system, then the shell's hubStatusRead with the request's id", () => {
    const hub = hubWith();
    const anna = hub.connect(ANNA_LAPTOP);
    const { id, effects } = hub.request(anna, ANNA_LAPTOP, { op: "hub.status", body: {} });
    expect(effects.filter((e) => e.kind === "hubStatusRead")).toEqual([
      { kind: "hubStatusRead", conn: anna, id },
    ]);
    const ben = hub.connect(BEN_LAPTOP);
    const refused = hub.request(ben, BEN_LAPTOP, { op: "hub.status", body: {} });
    expect(codeOf(onlyReply(refused.effects, ben))).toBe("unauthorized");
    expect(refused.effects.some((e) => e.kind === "hubStatusRead")).toBe(false);
  });

  test("usb.list on the console: the setup module's boards", () => {
    const hub = hubWith();
    const console = hub.connect(CONSOLE_CLIENT, "console");
    const reply = onlyReply(
      hub.request(console, CONSOLE_CLIENT, { op: "usb.list", body: {} }).effects,
      console,
    );
    expect(reply).toMatchObject({ ok: true, body: { ports: [] } });
  });

  test("site.show: the site, channel and all", () => {
    const hub = hubWith();
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, { op: "site.show", body: {} }).effects,
      anna,
    );
    expect(reply).toMatchObject({ ok: true, body: { channel: 1, rate: 5, wifiName: "home" } });
  });

  test("an M1a refusal by section 11's table: a survey once the site is paired is invalid {fixed}", () => {
    const hub = hubWith();
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, { op: "site.survey", body: {} }).effects,
      anna,
    );
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { field: "channel", reason: "fixed" } },
    });
  });

  test("a device a schedule names is not removed: invalid {inUse} with the entries", () => {
    const hub = new Hub(testModules({ schedules: MODULES.schedules }));
    const base = household(UM);
    hub.boot({
      ...base,
      m2: {
        ...base.m2,
        schedules: [
          {
            id: scheduleId(4),
            name: "Garage at night",
            action: ScheduleAction.Arm,
            modeId: null,
            groupId: null,
            sensorId: GARAGE,
            localTime: 22 * 60,
            days: 0b111_1111,
            date: null,
            enabled: true,
            createdBy: "Anna (client 7)",
            lastRunMs: null,
            lastRunLocalDate: null,
            missedDueMs: null,
            missedWhy: null,
            missedCount: 0,
            revision: 0,
          },
        ],
      },
    });
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, { op: "device.remove", body: { device: GARAGE } }).effects,
      anna,
    );
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { field: "device", reason: "inUse", refs: [4] } },
    });
    expect(hub.state.registry.devices.get(GARAGE)?.removedMs).toBeNull();
  });

  test("backup.key, a read, is still a commands row (it hands out the key)", () => {
    const hub = hubWith();
    const phone = hub.connect(ANNA_PHONE);
    const { effects } = hub.request(phone, ANNA_PHONE, { op: "backup.key", body: {} });
    expect(commandRows(effects).map((c) => c.row.kind)).toEqual(["backup.key"]);
    const other = hub.request(phone, ANNA_PHONE, { op: "device.list", body: {} });
    expect(commandRows(other.effects)).toEqual([]);
  });
});

describe("the live stream's events from other modules (section 6)", () => {
  test("config: a group made by `hsn` is announced to sessions subscribed to config", () => {
    // A layout that makes groups (A4's is not built yet): answers with the group, revision 0.
    const layout: Handler<"layout"> = (slice, message) =>
      ok(
        message.kind === "opRequest" && message.op.op === "group.create"
          ? {
              slice,
              out: [
                {
                  kind: "opAnswer",
                  answerTo: message.answerTo,
                  outcome: {
                    ok: true,
                    body: { id: 5, ...message.op.body, revision: 0 },
                  },
                },
              ],
            }
          : { slice, out: [] },
      );
    const hub = hubWith(testModules({ layout: { ...MODULES.layout, handle: layout } }));
    const anna = subscribe(hub, ANNA_LAPTOP, ["config"]);
    const other = subscribe(hub, BEN_LAPTOP, ["arming"]);
    const effects = hub.command({
      kind: "op",
      operation: { op: "group.create", body: { name: "Ground", sensors: [FRONT], sirens: "all" } },
    });
    expect(evs(effects, anna).map((e) => [e.ev, Object.keys(e.body as object)])).toEqual([
      ["config", ["group"]],
    ]);
    expect(evs(effects, other)).toEqual([]);
  });

  test("health: from a decision, to those who may view the device", () => {
    const hub = hubWith(
      testModules({ health: emitter("health", [decision("battery_low", GARAGE)]) }),
    );
    const anna = subscribe(hub, ANNA_LAPTOP, ["devices"]);
    const ben = subscribe(hub, BEN_LAPTOP, ["devices"]);
    const effects = hub.input({ kind: "tick" });
    expect(evs(effects, anna).map((e) => e.body)).toEqual([
      { device: GARAGE, what: "batteryLow", sinceMs: 1_000 },
    ]);
    expect(evs(effects, ben)).toEqual([]);
  });

  test("hub: an update staged, to those with manage system only", () => {
    const hub = hubWith(
      testModules({ upkeep: emitter("upkeep", [decision("update_staged", null, 2)]) }),
    );
    const anna = subscribe(hub, ANNA_LAPTOP, ["hub"]);
    const ben = subscribe(hub, BEN_LAPTOP, ["hub"]);
    const effects = hub.input({ kind: "tick" });
    expect(evs(effects, anna).map((e) => [e.ev, (e.body as { what: string }).what])).toEqual([
      ["hub", "updateStaged"],
    ]);
    expect(evs(effects, ben)).toEqual([]);
  });

  test("site: the move's stage, to those with manage system", () => {
    const move: Internal = {
      kind: "siteMove",
      move: 1,
      stage: "announcing",
      channel: 2,
      rate: undefined,
      forced: false,
    };
    const hub = hubWith(testModules({ upkeep: emitter("upkeep", [move]) }));
    const anna = subscribe(hub, ANNA_LAPTOP, ["hub"]);
    const ben = subscribe(hub, BEN_LAPTOP, ["hub"]);
    const effects = hub.input({ kind: "tick" });
    expect(evs(effects, anna).map((e) => e.ev)).toEqual(["site"]);
    expect(evs(effects, ben)).toEqual([]);
  });

  test("record: each record to history's subscribers, filtered as history is", () => {
    const hub = hubWith();
    const anna = subscribe(hub, ANNA_LAPTOP, ["history"]);
    const ben = subscribe(hub, BEN_LAPTOP, ["history"]);
    const effects = hub.command({ kind: "arm", sensors: ["garage"], continue: false });
    const kinds = (conn: typeof anna) =>
      evs(effects, conn).map((e) => {
        const row = e.body as { kind: string; row: { row: { kind?: string; deviceId?: number } } };
        return [row.kind, row.row.row.kind ?? null, row.row.row.deviceId ?? null];
      });
    expect(kinds(anna)).toContainEqual(["decision", "armed", GARAGE]);
    // Ben may not view the garage, and has no manage system for the hub's own rows.
    expect(kinds(ben).filter(([, , device]) => device === GARAGE)).toEqual([]);
    expect(kinds(ben).filter(([kind]) => kind === "command")).toEqual([]);
  });

  test("notification: notify's notice to every session of the clients it names", () => {
    const notice: NotificationObject = {
      seq: 2 ** 32 + 9,
      atMs: 1_000,
      clockOk: true,
      kind: "alarm",
      category: "alarm",
      critical: true,
      device: FRONT,
      cause: null,
      read: false,
      delayed: false,
    };
    const raised: Internal = {
      kind: "notificationRaised",
      notification: notice,
      clients: [BEN_LAPTOP],
    };
    const hub = hubWith(testModules({ notify: emitter("notify", [raised]) }));
    const ben = hub.connect(BEN_LAPTOP);
    const anna = subscribe(hub, ANNA_LAPTOP, ["notifications"]);
    const effects = hub.input({ kind: "tick" });
    expect(evs(effects, ben).map((e) => [e.ev, e.body])).toEqual([["notification", notice]]);
    expect(evs(effects, anna)).toEqual([]);
    expect(clientId(9)).toBe(BEN_LAPTOP);
  });
});

describe("hub events for upkeep's backup decisions, and a session ended by liveness", () => {
  test.each([
    "backup_no_folder",
    "backup_overdue",
    "backup_key_replaced",
    "backup_folder_on_data_disk",
  ])("%s: a hub `backup` event, to those with manage system only", (kind) => {
    const hub = hubWith(testModules({ upkeep: emitter("upkeep", [decision(kind, null, 2)]) }));
    const anna = subscribe(hub, ANNA_LAPTOP, ["hub"]);
    const ben = subscribe(hub, BEN_LAPTOP, ["hub"]);
    const effects = hub.input({ kind: "tick" });
    expect(evs(effects, anna).map((e) => [e.ev, e.body])).toContainEqual([
      "hub",
      { what: "backup", detail: { kind, value: 2 } },
    ]);
    expect(evs(effects, ben).filter((e) => e.ev === "hub")).toEqual([]);
  });

  test("clientClosed {liveness}: the session, its subscriptions and its waiting retries go", () => {
    const hub = hubWith();
    const anna = subscribe(hub, ANNA_LAPTOP, ["arming"]);
    const other = subscribe(hub, ANNA_PHONE, ["arming"]);
    // A retry of a pending change waits on each connection (as `routing.test.ts` makes one).
    const retry = (conn: typeof anna) => ({
      kind: "app" as const,
      conn,
      client: ANNA_LAPTOP,
      id: 3,
      seq: 5,
    });
    hub.state = {
      ...hub.state,
      app: { ...hub.state.app, waiting: new Map([["7:5", [retry(anna), retry(other)]]]) },
    };
    hub.input({ kind: "clientClosed", conn: anna, reason: "liveness" });
    expect([...hub.state.app.waiting.values()].flat().map((r) => r.conn)).toEqual([other]);
    expect(hub.state.app.sessions.has(anna)).toBe(false);
    expect([...hub.state.app.waiting.values()].flat().some((retry) => retry.conn === anna)).toBe(
      false,
    );
    const effects = hub.command({ kind: "arm", sensors: ["front"], continue: false });
    expect(evs(effects, anna)).toEqual([]);
  });
});

describe("hub events for update refusals and the database failing and recovering (section 5)", () => {
  const updateRefused: Internal = {
    kind: "auditRecord",
    durability: "routine",
    record: {
      kind: "hubEvent",
      row: {
        seq: seq(2 ** 32 + 600),
        atMs: 1_000,
        clockOk: true,
        level: "warning",
        origin: "core/upkeep",
        code: "update_refused",
        message: "not a release",
        detail: '{"reason":"badSignature"}',
      },
    },
  };

  test("update_refused: a hub `updateRefused` event, manage system only", () => {
    const hub = hubWith(testModules({ upkeep: emitter("upkeep", [updateRefused]) }));
    const anna = subscribe(hub, ANNA_LAPTOP, ["hub"]);
    const ben = subscribe(hub, BEN_LAPTOP, ["hub"]);
    const effects = hub.input({ kind: "tick" });
    expect(
      evs(effects, anna).flatMap((e) =>
        e.ev === "hub" ? [(e.body as { what: string }).what] : [],
      ),
    ).toEqual(["updateRefused"]);
    expect(evs(effects, ben).filter((e) => e.ev === "hub")).toEqual([]);
  });

  test("databaseFailing at the first failed commit of a run, databaseRecovered at the first after", () => {
    const hub = hubWith();
    const anna = subscribe(hub, ANNA_LAPTOP, ["hub"]);
    const ben = subscribe(hub, BEN_LAPTOP, ["hub"]);
    const whats = (effects: readonly Effect[], conn: typeof anna) =>
      evs(effects, conn).flatMap((e) =>
        e.ev === "hub" ? [(e.body as { what: string }).what] : [],
      );
    const failed = {
      kind: "commit",
      outcome: { kind: "failed", message: "disk I/O error" },
    } as const;
    expect(whats(hub.input(failed), anna)).toEqual(["databaseFailing"]);
    expect(whats(hub.input(failed), anna)).toEqual([]);
    const recovered = hub.input({ kind: "commit", outcome: { kind: "recovered" } });
    expect(whats(recovered, anna)).toEqual(["databaseRecovered"]);
    expect(whats(hub.input({ kind: "commit", outcome: { kind: "recovered" } }), anna)).toEqual([]);
    expect(whats(hub.input(failed), ben)).toEqual([]);
  });
});

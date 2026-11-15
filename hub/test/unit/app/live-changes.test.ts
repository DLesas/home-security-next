/**
 * Each change section 5 lists as live ("Live updates": a door, a cover, silence, a path, arming, a
 * countdown, the alarm, and readings at most once a minute) reaches a subscribed session as its
 * event, filtered by who may view the device: Anna may view both doors, Ben the front one only.
 */
import { describe, expect, test } from "bun:test";
import { MessageType } from "@hsn/protocol";
import { ok } from "neverthrow";
import type { AppEvent } from "@hsn/protocol/app";
import { handleApp } from "../../../src/core/app/handle.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { Context } from "../../../src/core/model/handler.ts";
import { seq, type ConnId, type DeviceId } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { MODULES } from "../../../src/core/step.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  BEN,
  BEN_LAPTOP,
  CONSOLE_CLIENT,
  emitter,
  FRONT,
  GARAGE,
  HALL_SIREN,
  household,
  Hub,
  permission,
  role,
  SECOND,
  testModules,
} from "../people/support/hub.ts";

const PERMISSIONS = {
  userManagement: true,
  roles: [role(ANNA, true, true), role(BEN, false, false)],
  permissions: [
    permission(ANNA, FRONT, true, true),
    permission(ANNA, GARAGE, true, true),
    permission(BEN, FRONT, true, true),
  ],
} as const;

function subscribed(hub: Hub, client: typeof ANNA_LAPTOP, topics: readonly string[]): ConnId {
  const conn = hub.connect(client);
  hub.request(conn, client, { op: "subscribe", body: { topics: topics as never } });
  return conn;
}

function events(effects: readonly Effect[], conn: ConnId): readonly AppEvent[] {
  return effects.flatMap((e) =>
    e.kind === "appSend" && e.conn === conn && "t" in e.message && e.message.t === "evt"
      ? [e.message]
      : [],
  );
}

function decision(kind: string, device: DeviceId | null, value: number | null = null): Internal {
  return {
    kind: "auditRecord",
    durability: "now",
    record: {
      kind: "decision",
      row: {
        seq: seq(2 ** 32 + 400),
        atMs: 1_000,
        clockOk: true,
        kind: kind as never,
        deviceId: device,
        causeSeq: null,
        value,
        detail: null,
      },
    },
  };
}

describe("a mode switch is an arming event with the new mode (section 6)", () => {
  test("from Disarmed to Away and back: each viewer gets its sensors and the mode", () => {
    const hub = new Hub(MODULES);
    hub.boot(household(PERMISSIONS));
    const anna = subscribed(hub, ANNA_LAPTOP, ["arming"]);
    const ben = subscribed(hub, BEN_LAPTOP, ["arming"]);
    const console = hub.connect(CONSOLE_CLIENT, "console");
    const away = hub.request(console, CONSOLE_CLIENT, { op: "mode.switch", body: { mode: 1 } });
    const shown = (conn: ConnId) =>
      events(away.effects, conn).flatMap((e) =>
        e.ev === "arming" ? [[e.body.sensors.map((s) => s.sensor), e.body.mode.mode]] : [],
      );
    expect(shown(anna)).toContainEqual([[], 1]);
    expect(shown(anna).flatMap(([sensors]) => sensors)).toEqual(
      expect.arrayContaining([FRONT, GARAGE]) as unknown as number[],
    );
    expect(shown(ben).flatMap(([sensors]) => sensors)).toEqual([FRONT]);
    expect(shown(ben)).toContainEqual([[], 1]);
    const back = hub.request(console, CONSOLE_CLIENT, { op: "mode.switch", body: { mode: 2 } });
    expect(
      events(back.effects, ben).flatMap((e) => (e.ev === "arming" ? [e.body.mode.mode] : [])),
    ).toContain(2);
  });
});

describe("the device changes of section 5, each to those who may view the device", () => {
  function tick(kind: string, device: DeviceId, value: number | null = null) {
    const hub = new Hub(
      testModules({ health: emitter("health", [decision(kind, device, value)]) }),
    );
    hub.boot(household(PERMISSIONS));
    const anna = subscribed(hub, ANNA_LAPTOP, ["arming", "alarm", "devices"]);
    const ben = subscribed(hub, BEN_LAPTOP, ["arming", "alarm", "devices"]);
    const effects = hub.input({ kind: "tick" });
    return { anna: events(effects, anna), ben: events(effects, ben) };
  }

  test.each([
    ["tamper_opened", "health", "tamperOpen"],
    ["sensor_silent", "health", "silent"],
    ["countdown_started", "countdown", "started"],
  ] as const)("%s on the garage: an event to Anna, none to Ben", (kind, ev, what) => {
    const { anna, ben } = tick(kind, GARAGE, 30);
    expect(anna.map((e) => [e.ev, (e.body as { what: string }).what])).toEqual([[ev, what]]);
    expect(ben).toEqual([]);
  });

  test("a siren's path lost: to everyone ‡ (sirens are everyone's)", () => {
    const { anna, ben } = tick("siren_wifi_lost", HALL_SIREN);
    expect(anna.map((e) => e.ev)).toEqual(["health"]);
    expect(ben.map((e) => e.ev)).toEqual(["health"]);
  });

  test("the alarm: to everyone, its triggers by view", () => {
    const { anna, ben } = tick("alarm", GARAGE);
    expect(anna.map((e) => [e.ev, (e.body as { what: string }).what])).toEqual([
      ["alarm", "started"],
    ]);
    expect(ben.map((e) => e.ev)).toEqual(["alarm"]);
  });
});

describe("door reports and readings (section 5)", () => {
  /** app's handler alone, given a sensor's accepted report, over a booted hub's state. */
  function accepted(hub: Hub, sensor: DeviceId, type: number, newest: boolean) {
    const message: Internal = {
      kind: "accepted",
      device: sensor,
      role: 1,
      counter: 9,
      message: {
        type,
        settingsVersion: 1,
        flags: { doorOpen: true },
        batteryCode: 200,
        temperatureCelsius: 21,
        doorChangeCount: 3,
        eventAgeSeconds: 2,
      } as never,
      arrival: { path: "wifi", link: 1 as never },
      record: seq(2 ** 32 + 9),
      newest,
    };
    const ctx: Context = {
      now: { mono: hub.at, wall: hub.wall(), wallTrusted: true },
      view: hub.state,
      deps: hub.deps,
      entropy: entropyCursor(new Uint8Array(32), "tick"),
      records: { take: () => ok(seq(2 ** 32 + 10)) },
      event: "tick",
    };
    const handled = handleApp(hub.state.app, message, ctx);
    expect(handled.isErr() ? handled.error.message : "ok").toBe("ok");
    if (handled.isErr()) return [];
    hub.state = { ...hub.state, app: handled.value.slice };
    return handled.value.out.filter((e): e is Effect => e.kind === "appSend");
  }

  test("a door report: a door event dated by its age, to those who may view the door", () => {
    const hub = new Hub();
    hub.boot(household(PERMISSIONS));
    const anna = subscribed(hub, ANNA_LAPTOP, ["devices"]);
    const ben = subscribed(hub, BEN_LAPTOP, ["devices"]);
    const out = accepted(hub, GARAGE, MessageType.DoorChanged, true);
    expect(
      events(out, anna)
        .filter((e) => e.ev === "door")
        .map((e) => e.body),
    ).toEqual([{ sensor: GARAGE, open: true, atMs: hub.wall() - 2000 }]);
    expect(events(out, ben)).toEqual([]);
  });

  test("a reading at most once a minute per device, and only from the newest packet", () => {
    const hub = new Hub();
    hub.boot(household(PERMISSIONS));
    const ben = subscribed(hub, BEN_LAPTOP, ["devices"]);
    const readings = (out: readonly Effect[]) => events(out, ben).filter((e) => e.ev === "reading");
    expect(readings(accepted(hub, FRONT, MessageType.Heartbeat, false))).toEqual([]);
    expect(readings(accepted(hub, FRONT, MessageType.Heartbeat, true)).map((e) => e.body)).toEqual([
      { device: FRONT, batteryPercent: null, signal: null, temperatureC: 21 },
    ]);
    hub.at = (hub.at + 59 * SECOND) as typeof hub.at;
    expect(readings(accepted(hub, FRONT, MessageType.Heartbeat, true))).toEqual([]);
    hub.at = (hub.at + 1 * SECOND) as typeof hub.at;
    expect(readings(accepted(hub, FRONT, MessageType.Heartbeat, true))).toHaveLength(1);
    expect(readings(accepted(hub, GARAGE, MessageType.Heartbeat, true))).toEqual([]);
  });
});

describe("arming events on every arming action, and layout's operations (section 6)", () => {
  function hub(): { hub: Hub; anna: ConnId; ben: ConnId; console: ConnId } {
    const h = new Hub(MODULES);
    h.boot(household(PERMISSIONS));
    return {
      hub: h,
      anna: subscribed(h, ANNA_LAPTOP, ["arming", "config"]),
      ben: subscribed(h, BEN_LAPTOP, ["arming", "config"]),
      console: h.connect(CONSOLE_CLIENT, "console"),
    };
  }

  const modesShown = (effects: readonly Effect[], conn: ConnId) =>
    events(effects, conn).flatMap((e) =>
      e.ev === "arming" && e.body.sensors.length === 0 ? [e.body.mode] : [],
    );

  test("a switch that changes no sensor still tells the mode", () => {
    const { hub: h, ben, console } = hub();
    const { effects } = h.request(console, CONSOLE_CLIENT, {
      op: "mode.switch",
      body: { mode: 2 },
    });
    expect(modesShown(effects, ben)).toEqual([{ mode: 2, modified: false }]);
    expect(events(effects, ben).filter((e) => e.ev === "arming")).toHaveLength(1);
  });

  test("arming a group, not a switch: the sensors by view, and the mode marked changed", () => {
    const { hub: h, anna, ben, console } = hub();
    const made = h.request(console, CONSOLE_CLIENT, {
      op: "group.create",
      body: { name: "Garage", sensors: [GARAGE], sirens: "all" },
    });
    const group = made.effects.flatMap((e) =>
      e.kind === "appSend" &&
      e.conn === console &&
      "t" in e.message &&
      e.message.t === "res" &&
      e.message.ok
        ? [(e.message.body as { id: number }).id]
        : [],
    )[0];
    const { effects } = h.request(console, CONSOLE_CLIENT, {
      op: "arm",
      body: { target: { group: group ?? 0 } },
    });
    expect(
      events(effects, anna).flatMap((e) =>
        e.ev === "arming" ? e.body.sensors.map((s) => s.sensor) : [],
      ),
    ).toEqual([GARAGE]);
    expect(modesShown(effects, anna).at(-1)?.modified).toBe(true);
    expect(modesShown(effects, ben).at(-1)?.modified).toBe(true);
    expect(events(effects, ben).flatMap((e) => (e.ev === "arming" ? e.body.sensors : []))).toEqual(
      [],
    );
  });

  test("group.create, group.update, mode.create, mode.update: manage system, then made and announced", () => {
    const { hub: h, anna, ben } = hub();
    const asBen = h.request(ben, BEN_LAPTOP, {
      op: "group.create",
      body: { name: "Front", sensors: [FRONT], sirens: "all" },
    });
    expect(events(asBen.effects, anna).filter((e) => e.ev === "config")).toEqual([]);
    const reply = (effects: readonly Effect[], conn: ConnId) =>
      effects.flatMap((e) =>
        e.kind === "appSend" && e.conn === conn && "t" in e.message && e.message.t === "res"
          ? [e.message]
          : [],
      )[0];
    expect(reply(asBen.effects, ben)).toMatchObject({
      ok: false,
      error: { code: "unauthorized", detail: { permission: "manageSystem" } },
    });
    const group = h.request(anna, ANNA_LAPTOP, {
      op: "group.create",
      body: { name: "Front", sensors: [FRONT], sirens: "all" },
    });
    const made = reply(group.effects, anna);
    expect(made).toMatchObject({ ok: true, body: { name: "Front", revision: 0 } });
    const id = made?.ok === true ? (made.body as { id: number }).id : 0;
    const updated = h.request(anna, ANNA_LAPTOP, {
      op: "group.update",
      body: { group: id, name: "Front door", sensors: [FRONT], sirens: "all", ifRevision: 0 },
    });
    expect(reply(updated.effects, anna)).toMatchObject({ ok: true, body: { name: "Front door" } });
    const mode = h.request(anna, ANNA_LAPTOP, {
      op: "mode.create",
      body: { name: "Night", groups: [id] },
    });
    const night = reply(mode.effects, anna);
    expect(night).toMatchObject({ ok: true, body: { name: "Night", groups: [id] } });
    const modeId = night?.ok === true ? (night.body as { id: number }).id : 0;
    const renamed = h.request(anna, ANNA_LAPTOP, {
      op: "mode.update",
      body: { mode: modeId, name: "Sleep", groups: [id], ifRevision: 0 },
    });
    expect(reply(renamed.effects, anna)).toMatchObject({ ok: true, body: { name: "Sleep" } });
    for (const step of [group, updated, mode, renamed])
      expect(events(step.effects, ben).map((e) => e.ev)).toContain("config");
    const asBenMode = h.request(ben, BEN_LAPTOP, {
      op: "mode.update",
      body: { mode: modeId, name: "Mine", groups: [], ifRevision: 1 },
    });
    expect(reply(asBenMode.effects, ben)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  });
});

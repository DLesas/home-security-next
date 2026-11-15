/**
 * The snapshot, subscriptions and live events (m2-design.md section 5, "Live updates"; section 6,
 * the events table; HB14, HB5a), with the permissions as they are when each event is made.
 * Owner A3's step 4.
 */
import { describe, expect, test } from "bun:test";
import { appIdentityBytes, formatIdentity, type AppEvent } from "@hsn/protocol/app";
import { nodeSha256 } from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  BEN,
  BEN_LAPTOP,
  bodyOf,
  codeOf,
  eventsTo,
  FRONT,
  GARAGE,
  HALL_SIREN,
  household,
  Hub,
  onlyReply,
  permission,
  role,
  APP_STATIC_PUBLIC,
  FACTS,
} from "../people/support/hub.ts";

function managed(): Hub {
  const hub = new Hub();
  hub.boot(
    household({
      userManagement: true,
      roles: [role(ANNA, true, true), role(BEN, false, false)],
      permissions: [
        permission(ANNA, FRONT, true, true),
        permission(ANNA, GARAGE, true, false),
        permission(BEN, FRONT, true, true),
      ],
    }),
  );
  return hub;
}

function subscribed(hub: Hub, client: typeof ANNA_LAPTOP, topics: readonly string[]) {
  const conn = hub.connect(client);
  hub.request(conn, client, { op: "snapshot", body: {} });
  hub.request(conn, client, { op: "subscribe", body: { topics: topics as never } });
  return conn;
}

function evs(
  effects: readonly Effect[],
  conn: Parameters<typeof eventsTo>[1],
): readonly AppEvent[] {
  return eventsTo(effects, conn);
}

describe("snapshot (section 6)", () => {
  test("holds only what the person may see: sensors by view, every siren", () => {
    const hub = managed();
    const ben = hub.connect(BEN_LAPTOP);
    const snapshot = bodyOf(
      onlyReply(hub.request(ben, BEN_LAPTOP, { op: "snapshot", body: {} }).effects, ben),
    );
    expect((snapshot.devices as { id: number }[]).map((d) => d.id)).toEqual([FRONT, HALL_SIREN]);
    expect((snapshot.sensors as { id: number }[]).map((s) => s.id)).toEqual([FRONT]);
    expect((snapshot.sirens as { id: number }[]).map((s) => s.id)).toEqual([HALL_SIREN]);
    const anna = hub.connect(ANNA_LAPTOP);
    const all = bodyOf(
      onlyReply(hub.request(anna, ANNA_LAPTOP, { op: "snapshot", body: {} }).effects, anna),
    );
    expect((all.sensors as { id: number }[]).map((s) => s.id)).toEqual([FRONT, GARAGE]);
    expect(all).toMatchObject({
      rev: 0,
      hub: {
        hub: FACTS.version,
        proto: 1,
        boot: 1,
        identity: formatIdentity(appIdentityBytes(nodeSha256, APP_STATIC_PUBLIC)),
        fingerprint: Array(32).fill("AB").join(":"),
      },
    });
  });

  test("is built from the core's state: it writes nothing", () => {
    const hub = managed();
    const ben = hub.connect(BEN_LAPTOP);
    const { effects } = hub.request(ben, BEN_LAPTOP, { op: "snapshot", body: {} });
    expect(effects.filter((e) => e.kind === "write" || e.kind === "record")).toEqual([]);
  });

  test("before the shell's facts (`hubFacts`) it is answered unavailable", () => {
    const hub = new Hub();
    hub.boot(household(), 1, false);
    const conn = hub.connect(ANNA_LAPTOP);
    expect(
      codeOf(onlyReply(hub.request(conn, ANNA_LAPTOP, { op: "snapshot", body: {} }).effects, conn)),
    ).toBe("unavailable");
  });

  test("subscribe answers the topics accepted", () => {
    const hub = managed();
    const conn = hub.connect(BEN_LAPTOP);
    const reply = onlyReply(
      hub.request(conn, BEN_LAPTOP, { op: "subscribe", body: { topics: ["arming", "people"] } })
        .effects,
      conn,
    );
    expect(bodyOf(reply)).toEqual({ topics: ["arming", "people"] });
  });
});

describe("events, checked when made (section 5)", () => {
  test("an arming event goes only to sessions whose person may view the sensor", () => {
    const hub = managed();
    const anna = subscribed(hub, ANNA_LAPTOP, ["arming"]);
    const ben = subscribed(hub, BEN_LAPTOP, ["arming"]);
    const garage = hub.command({ kind: "arm", sensors: ["garage"], continue: false });
    expect(evs(garage, anna).map((e) => e.ev)).toEqual(["arming"]);
    expect(evs(garage, ben)).toEqual([]);
    const front = hub.command({ kind: "arm", sensors: ["front"], continue: false });
    expect(evs(front, ben).map((e) => [e.ev, e.body])).toEqual([
      [
        "arming",
        { sensors: [{ sensor: FRONT, arm: "armed" }], mode: { mode: null, modified: false } },
      ],
    ]);
  });

  test("only to sessions subscribed to the event's topic", () => {
    const hub = managed();
    const anna = subscribed(hub, ANNA_LAPTOP, ["people"]);
    expect(evs(hub.command({ kind: "arm", sensors: ["front"], continue: false }), anna)).toEqual(
      [],
    );
  });

  test("a permission taken away takes effect on the next event, and the person is told to forget", () => {
    const hub = managed();
    const ben = subscribed(hub, BEN_LAPTOP, ["arming"]);
    const anna = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(anna, ANNA_LAPTOP, {
      op: "permissions.set",
      body: { person: 2, devices: [], manageUsers: false, manageSystem: false, ifRevision: 0 },
    });
    expect(evs(effects, ben).map((e) => [e.ev, e.body])).toEqual([["forget", { device: FRONT }]]);
    expect(evs(hub.command({ kind: "arm", sensors: ["front"], continue: false }), ben)).toEqual([]);
  });

  test("rev rises by one at each step that sends events, shared by every event of the step", () => {
    const hub = managed();
    const anna = subscribed(hub, ANNA_LAPTOP, ["arming"]);
    const both = hub.command({ kind: "arm", sensors: ["front", "garage"], continue: false });
    const first = evs(both, anna);
    expect(first.length).toBe(2);
    expect(new Set(first.map((e) => e.rev)).size).toBe(1);
    const next = evs(hub.command({ kind: "disarm", sensors: ["front"] }), anna);
    expect(next.map((e) => e.rev)).toEqual([(first[0]?.rev ?? 0) + 1]);
    // A step that sends nothing leaves rev where it was.
    hub.advance(1);
    const later = evs(hub.command({ kind: "disarm", sensors: ["garage"] }), anna);
    expect(later.map((e) => e.rev)).toEqual([(first[0]?.rev ?? 0) + 2]);
  });

  test("people events: to manage users all, to anyone else their own person and clients only", () => {
    const hub = managed();
    const anna = subscribed(hub, ANNA_LAPTOP, ["people"]);
    const ben = subscribed(hub, BEN_LAPTOP, ["people"]);
    const created = hub.request(anna, ANNA_LAPTOP, { op: "person.create", body: { name: "Cleo" } });
    expect(evs(created.effects, anna).map((e) => e.body)).toMatchObject([
      { person: { id: 3, name: "Cleo" } },
    ]);
    expect(evs(created.effects, ben)).toEqual([]);
    const renamed = hub.request(ben, BEN_LAPTOP, {
      op: "client.rename",
      body: { client: 9, name: "Mine" },
    });
    expect(evs(renamed.effects, ben).map((e) => e.body)).toMatchObject([
      { client: { id: 9, name: "Mine" } },
    ]);
  });

  test("a removed client's sessions are told `session`, then closed", () => {
    const hub = managed();
    const ben = subscribed(hub, BEN_LAPTOP, []);
    const anna = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(anna, ANNA_LAPTOP, {
      op: "client.remove",
      body: { client: 9, also: [] },
    });
    const order = effects.flatMap((e) =>
      (e.kind === "appSend" && e.conn === ben) || e.kind === "closeClient" ? [e.kind] : [],
    );
    expect(order).toEqual(["appSend", "closeClient"]);
    expect(evs(effects, ben).map((e) => e.ev)).toEqual(["session"]);
    expect(hub.state.app.sessions.has(ben)).toBe(false);
  });

  test("a device renamed is a device event to those who may see it", () => {
    const hub = managed();
    const anna = subscribed(hub, ANNA_LAPTOP, ["devices"]);
    const ben = subscribed(hub, BEN_LAPTOP, ["devices"]);
    const effects = hub.command({ kind: "deviceRename", from: "garage", to: "shed" });
    expect(evs(effects, anna).map((e) => [e.ev, (e.body as { what: string }).what])).toEqual([
      ["device", "renamed"],
    ]);
    expect(evs(effects, ben)).toEqual([]);
  });
});

/**
 * Channel version 2's objects, replies and events, as `app` makes them (docs/m3-m4-plan.md; H1):
 * each checked against its strict version 2 schema in every state it can take, a version 1 and a
 * version 2 session side by side receiving the same event each in its own form, and the events
 * only version 2 names (`hub`'s `relay` and `updateOffered`, `deviceUpdate`) reaching version 2
 * sessions of people with manage system and no other.
 */
import { describe, expect, test } from "bun:test";
import { MessageType, Role, UpdateStage } from "@hsn/protocol";
import {
  APP_EVENTS,
  APP_OPS,
  APP_OPS_V2,
  appReply,
  appReplyV2,
  type AppEventV2,
  deviceObjectV2,
  hubInfoV2,
  parseEventV2,
  snapshotObjectV2,
} from "@hsn/protocol/app";
import {
  DeviceUpdateState,
  DeviceState,
  UpdateHeld,
  UpdateMethod,
} from "../../../src/core/model/rows.ts";
import { bootId, deviceId, type DeviceId, linkId, seq } from "../../../src/core/model/ids.ts";
import { EMPTY_M3M4_SNAPSHOT } from "../../../src/core/model/events.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { MODULES } from "../../../src/core/step.ts";
import { deviceToV2 } from "../../../src/core/app/versions.ts";
import { deviceObject } from "../../../src/core/app/objects.ts";
import { G1, LORA, ON_TRIAL, imageRow, siteSnapshot, wifi } from "../firmware/support.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN,
  BEN_LAPTOP,
  CONSOLE_CLIENT,
  emitter,
  FACTS,
  FRONT,
  HALL_SIREN,
  permission,
  role,
  testModules,
  WALL_AT_START,
} from "../people/support/hub.ts";
import { Disk, eventsOn, framesTo, okBody, PhoneHub, replyTo } from "./support/phone-hub.ts";

const ALL = ["arming", "devices", "alarm", "notifications", "history", "config", "people", "hub"];

function subscribed(hub: PhoneHub, client: Parameters<PhoneHub["connect"]>[0], proto: 1 | 2) {
  const conn = hub.connect(client, proto, client === CONSOLE_CLIENT ? "console" : "lan");
  hub.request(conn, client, { op: "subscribe", body: { topics: ALL as never } });
  return conn;
}

/** User management on: Anna has manage system, Ben has nothing. */
function managedDisk(): Disk {
  const disk = new Disk();
  disk.people.userManagement = true;
  disk.people.roles.set(ANNA, role(ANNA, true, true));
  disk.people.roles.set(BEN, role(BEN, false, false));
  return disk;
}

function strictEvent(event: unknown): AppEventV2 {
  const parsed = parseEventV2(event);
  expect(parsed.ok ? "ok" : parsed.issues.join("; ")).toBe("ok");
  return parsed.ok ? parsed.value : expect.unreachable();
}

describe("hub.info and the snapshot in version 2", () => {
  test("hub.info: version 1's, with the addresses apps are given, the apps' port and the relay", () => {
    const hub = new PhoneHub().boot();
    hub.input({
      kind: "hubFacts",
      ...FACTS,
      addresses: ["fe80::1c2b:3cff:fe4d:5e6f", "fd00:0:0:0:0:0:0:10", "192.168.1.10"],
    });
    const v2 = hub.connect(ANNA_PHONE, 2);
    const v1 = hub.connect(ANNA_LAPTOP, 1);
    const info2 = okBody(
      replyTo(hub.request(v2, ANNA_PHONE, { op: "hub.info", body: {} }).effects, v2),
    );
    expect(hubInfoV2.safeParse(info2).success).toBe(true);
    expect(info2).toMatchObject({
      proto: 2,
      addresses: ["192.168.1.10", "fd00::10"],
      appsPort: 8444,
      relay: null,
    });
    const info1 = okBody(
      replyTo(hub.request(v1, ANNA_LAPTOP, { op: "hub.info", body: {} }).effects, v1),
    );
    expect(APP_OPS["hub.info"].reply.safeParse(info1).success).toBe(true);
    expect(info1.proto).toBe(1);
    expect("addresses" in info1).toBe(false);
  });

  test("hub.info names the relay a person set (relay.set, routed to relay)", () => {
    const hub = new PhoneHub().boot();
    const console2 = hub.connect(CONSOLE_CLIENT, 2, "console");
    const set = hub.request(console2, CONSOLE_CLIENT, {
      op: "relay.set",
      body: { url: "wss://relay.example.org" },
    });
    expect(
      APP_OPS_V2["relay.set"].reply.safeParse(okBody(replyTo(set.effects, console2))).success,
    ).toBe(true);
    const info = okBody(
      replyTo(
        hub.request(console2, CONSOLE_CLIENT, { op: "hub.info", body: {} }).effects,
        console2,
      ),
    );
    expect(info.relay).toEqual({ url: "wss://relay.example.org" });
  });

  test("the snapshot of a phone: push and the backup key's epoch; of a browser and the console, null", () => {
    const hub = new PhoneHub().boot();
    for (const [client, phone] of [
      [ANNA_PHONE, true],
      [ANNA_LAPTOP, false],
      [CONSOLE_CLIENT, false],
    ] as const) {
      const conn = hub.connect(client, 2, client === CONSOLE_CLIENT ? "console" : "lan");
      const snap = okBody(
        replyTo(hub.request(conn, client, { op: "snapshot", body: {} }).effects, conn),
      );
      const parsed = snapshotObjectV2.safeParse(snap);
      expect(parsed.success ? "ok" : JSON.stringify(parsed.error.issues)).toBe("ok");
      if (phone) {
        expect(snap.push).toEqual({ registered: false, valid: false });
        expect(typeof snap.backupKeyEpoch).toBe("number");
      } else {
        expect(snap.push).toBeNull();
        expect(snap.backupKeyEpoch).toBeNull();
      }
      expect((snap.hub as Record<string, unknown>).appsPort).toBe(8444);
      for (const device of snap.devices as Record<string, unknown>[])
        expect(device.update).toBeNull();
    }
  });

  test("a version 1 session's snapshot is version 1's, strictly", () => {
    const hub = new PhoneHub().boot();
    const conn = hub.connect(ANNA_PHONE, 1);
    const snap = okBody(
      replyTo(hub.request(conn, ANNA_PHONE, { op: "snapshot", body: {} }).effects, conn),
    );
    expect(APP_OPS.snapshot.reply.safeParse(snap).success).toBe(true);
  });
});

describe("device objects in version 2, in every state", () => {
  const STATES = [
    DeviceState.Provisioning,
    DeviceState.Paired,
    DeviceState.Contacted,
    DeviceState.ResetByOwner,
    DeviceState.Removed,
    DeviceState.LeftBehind,
  ];
  const UPDATES = Object.values(DeviceUpdateState);

  function withUpdate(
    hub: PhoneHub,
    device: DeviceId,
    state: number,
    held: number,
    method: number,
  ) {
    const entry = {
      row: {
        deviceId: device,
        rolloutId: null,
        state,
        method,
        held,
        bytes: 0,
        attempts: 0,
        lastReason: null,
        sinceMs: 0,
        bleNonce: null,
        bleExpiresMs: null,
        remindedMs: null,
      },
      told: undefined,
      event: undefined,
      eventAt: undefined,
      busyHolds: 0,
      armedSince: undefined,
      forced: false,
    } as never;
    hub.state = {
      ...hub.state,
      firmware: { ...hub.state.firmware, updates: new Map([[device, entry]]) },
    };
  }

  test.each(STATES)("state %d, with no update and with each update", (state) => {
    const hub = new PhoneHub().boot();
    const front = deviceId(11);
    const row = { ...(hub.device(11) ?? expect.unreachable()), state };
    const object = deviceObject(hub.state, hub.deps, row) ?? expect.unreachable();
    const none = deviceToV2(hub.state, object);
    expect(deviceObjectV2.safeParse(none).success).toBe(true);
    expect(none.update).toBeNull();
    for (const update of UPDATES)
      for (const held of Object.values(UpdateHeld))
        for (const method of Object.values(UpdateMethod)) {
          withUpdate(hub, front, update, held, method);
          const v2 = deviceToV2(hub.state, object);
          const parsed = deviceObjectV2.safeParse(v2);
          expect(parsed.success).toBe(true);
          expect(v2.update === null).toBe(update === DeviceUpdateState.None);
        }
  });
});

describe("one event, each session in its own version", () => {
  test.each([
    ["sensor", FRONT, Role.Sensor, LORA],
    ["siren", HALL_SIREN, Role.Siren, wifi(600)],
    ["gateway", G1, Role.Gateway, { path: "usb", link: linkId(1) }],
  ] as const)(
    "a subscribed app sees %s firmware on Started and its update on confirmation",
    (_name, device, role, arrival) => {
      const disk = managedDisk().withSettings(1, 1);
      disk.people.permissions.set(`${ANNA}:${FRONT}`, permission(ANNA, FRONT, true, true));
      disk.people.permissions.set(`${BEN}:${FRONT}`, permission(BEN, FRONT, false, true));
      const gateway = siteSnapshot().devices.find((row) => row.id === G1) ?? expect.unreachable();
      disk.rows.devices.set(G1, gateway);
      const image = imageRow(1, 0x010400);
      const packet = {
        kind: "accepted",
        device,
        role,
        arrival,
        newest: true,
      } as const;
      const started: Internal = {
        ...packet,
        counter: 100,
        record: seq(2 ** 32 + 100),
        message: {
          type: MessageType.Started,
          role,
          firmwareVersion: { major: 1, minor: 4, patch: 0 },
          resetCause: 3,
          lastFatalError: 0,
          settingsVersion: 1,
        },
        startedImage: ON_TRIAL,
      };
      const confirmed: Internal = {
        ...packet,
        counter: 101,
        record: seq(2 ** 32 + 101),
        message: {
          type: MessageType.UpdateStatus,
          stage: UpdateStage.Confirmed,
          imageId: image.imageId,
          reason: 0,
          bytesWritten: image.bytes + 128,
        },
      };
      const reports = [started, confirmed];
      const base = MODULES.intake;
      const hub = new PhoneHub(disk, {
        ...MODULES,
        intake: {
          ...base,
          // Feed decoded packets into the same dispatcher the real intake uses.
          handle: (slice, message, ctx) =>
            base.handle(slice, message, ctx).map((handled) => {
              const report = message.kind === "tick" ? reports.shift() : undefined;
              return report === undefined ? handled : { ...handled, out: [...handled.out, report] };
            }),
        },
      });
      hub.input({
        kind: "boot",
        snapshot: {
          ...disk.snapshot(),
          m3m4: { ...EMPTY_M3M4_SNAPSHOT, firmwareImages: [image] },
        },
        boot: { id: bootId(1), previousExit: "clean", cause: undefined },
      });
      hub.input({ kind: "hubFacts", ...FACTS });
      const v1 = subscribed(hub, ANNA_LAPTOP, 1);
      const v2 = subscribed(hub, ANNA_PHONE, 2);
      const viewer = subscribed(hub, BEN_LAPTOP, 2);
      const rollout = hub.request(v2, ANNA_PHONE, {
        op: "rollout.start",
        body: { image: image.id, devices: [device] },
      });
      expect(replyTo(rollout.effects, v2).ok).toBe(true);

      /** Takes only the device objects on this session, in their delivery order. */
      const objects = (effects: ReturnType<PhoneHub["advance"]>, conn: typeof v1) =>
        eventsOn(effects, conn).flatMap((event) =>
          event.ev === "device" && event.body.device.id === device ? [event.body.device] : [],
        );
      const report = hub.advance(1);
      const finish = hub.advance(1);
      expect(objects(report, v1).map((object) => object.firmware)).toEqual(["1.4.0"]);
      expect(objects(finish, v1)).toEqual([]);
      expect(objects(finish, v2).map(({ firmware, update }) => [firmware, update?.state])).toEqual([
        ["1.4.0", "confirmed"],
      ]);
      expect(objects(finish, viewer)).toEqual(objects(finish, v2));
      expect(eventsOn(finish, viewer).some((event) => event.ev === "deviceUpdate")).toBe(false);
      expect(objects(report, v2).at(-1)).toMatchObject({
        firmware: "1.4.0",
        update: { state: "onTrial", held: null },
      });
    },
  );

  test("device: a rename seen by a version 1 and a version 2 session, same rev, own schemas", () => {
    const hub = new PhoneHub().boot();
    const v1 = subscribed(hub, ANNA_LAPTOP, 1);
    const v2 = subscribed(hub, ANNA_PHONE, 2);
    const renamed = hub.request(v1, ANNA_LAPTOP, {
      op: "device.rename",
      body: { device: 11, name: "front-door" },
    });
    const one = eventsOn(renamed.effects, v1).filter((e) => e.ev === "device");
    const two = eventsOn(renamed.effects, v2).filter((e) => e.ev === "device");
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
    expect(one[0]?.rev).toBe(two[0]?.rev);
    expect(APP_EVENTS.device.safeParse(one[0]?.body).success).toBe(true);
    expect(APP_EVENTS.device.safeParse(two[0]?.body).success).toBe(false);
    strictEvent(two[0]);
    expect((two[0]?.body as { device: { update: unknown } }).device.update).toBeNull();
    // The rename's own reply on version 1 is version 1's object.
    expect(
      APP_OPS["device.rename"].reply.safeParse(okBody(replyTo(renamed.effects, v1))).success,
    ).toBe(true);
  });

  test("device.rename's reply on a version 2 session is version 2's object, kept so for a retry", () => {
    const hub = new PhoneHub().boot();
    const v2 = hub.connect(ANNA_PHONE, 2);
    const renamed = hub.request(v2, ANNA_PHONE, {
      op: "device.rename",
      body: { device: 11, name: "front-door" },
    });
    const body = okBody(replyTo(renamed.effects, v2));
    expect(APP_OPS_V2["device.rename"].reply.safeParse(body).success).toBe(true);
    const retry = hub.request(
      v2,
      ANNA_PHONE,
      { op: "device.rename", body: { device: 11, name: "front-door" } },
      { seq: renamed.seq ?? 0 },
    );
    const again = replyTo(retry.effects, v2);
    expect(again.repeat).toBe(true);
    expect(okBody(again)).toEqual(body);
    // device.list and device.show in version 2.
    const list = okBody(
      replyTo(hub.request(v2, ANNA_PHONE, { op: "device.list", body: {} }).effects, v2),
    );
    expect(APP_OPS_V2["device.list"].reply.safeParse(list).success).toBe(true);
    const show = okBody(
      replyTo(hub.request(v2, ANNA_PHONE, { op: "device.show", body: { device: 21 } }).effects, v2),
    );
    expect(APP_OPS_V2["device.show"].reply.safeParse(show).success).toBe(true);
  });

  test("notification: version 1's object, and version 2's with happenedAtMs as notify gave it", () => {
    const notification = {
      seq: 2 ** 32 + 77,
      atMs: WALL_AT_START + 1_000,
      clockOk: true,
      kind: "armed_door_opened",
      category: "countdown",
      critical: false,
      device: 11,
      cause: null,
      read: false,
      delayed: true,
    } as const;
    const raised: Internal = {
      kind: "notificationRaised",
      notification,
      clients: [ANNA_LAPTOP, ANNA_PHONE],
      happenedAtMs: WALL_AT_START - 90_000,
    };
    const hub = new PhoneHub(
      new Disk(),
      testModules({ ...MODULES, notify: emitter("notify", [raised]) }),
    ).boot();
    const v1 = hub.connect(ANNA_LAPTOP, 1);
    const v2 = hub.connect(ANNA_PHONE, 2);
    const ticked = hub.advance(5);
    const one = eventsOn(ticked, v1);
    const two = eventsOn(ticked, v2);
    expect(one.map((e) => e.body)).toEqual([notification]);
    expect(APP_EVENTS.notification.safeParse(one[0]?.body).success).toBe(true);
    expect(two.map((e) => e.body)).toEqual([
      { ...notification, happenedAtMs: WALL_AT_START - 90_000 },
    ]);
    strictEvent(two[0]);
    expect(one[0]?.rev).toBe(two[0]?.rev);
  });

  test("a notification raised as it happened: happenedAtMs null", () => {
    const raised: Internal = {
      kind: "notificationRaised",
      notification: {
        seq: 2 ** 32 + 78,
        atMs: WALL_AT_START,
        clockOk: true,
        kind: "alarm",
        category: "alarm",
        critical: true,
        device: null,
        cause: null,
        read: false,
        delayed: false,
      },
      clients: [ANNA_PHONE],
      happenedAtMs: null,
    };
    const hub = new PhoneHub(
      new Disk(),
      testModules({ ...MODULES, notify: emitter("notify", [raised]) }),
    ).boot();
    const v2 = hub.connect(ANNA_PHONE, 2);
    const [event] = eventsOn(hub.advance(5), v2);
    expect((strictEvent(event).body as { happenedAtMs: unknown }).happenedAtMs).toBeNull();
  });
});

describe("events only version 2 names", () => {
  test("hub {relay}: to version 2 sessions with manage system, never to version 1", () => {
    const hub = new PhoneHub(managedDisk()).boot();
    const annaV2 = subscribed(hub, ANNA_PHONE, 2);
    const annaV1 = subscribed(hub, ANNA_LAPTOP, 1);
    const benV2 = subscribed(hub, BEN_LAPTOP, 2);
    const set = hub.request(annaV2, ANNA_PHONE, {
      op: "relay.set",
      body: { url: "wss://relay.example.org" },
    });
    const told = eventsOn(set.effects, annaV2).filter((e) => e.ev === "hub");
    const bodies = told.map((e) => strictEvent(e).body as { what: string; detail: unknown });
    expect(bodies.map((b) => b.what)).toEqual(["relay"]);
    expect(bodies[0]?.detail).toMatchObject({ url: "wss://relay.example.org", isDefault: false });
    expect(eventsOn(set.effects, annaV1).filter((e) => e.ev === "hub")).toEqual([]);
    expect(eventsOn(set.effects, benV2).filter((e) => e.ev === "hub")).toEqual([]);
    // The same again changes nothing, so nothing is told.
    const same = hub.request(annaV2, ANNA_PHONE, {
      op: "relay.set",
      body: { url: "wss://relay.example.org" },
    });
    expect(eventsOn(same.effects, annaV2).filter((e) => e.ev === "hub")).toEqual([]);
  });

  test("hub {updateOffered}: from upkeep's update_offered decision, version 2 only", () => {
    const offered: Internal = {
      kind: "auditRecord",
      durability: "routine",
      record: {
        kind: "decision",
        row: {
          seq: seq(2 ** 32 + 990),
          atMs: WALL_AT_START,
          clockOk: true,
          kind: "update_offered",
          deviceId: null,
          causeSeq: null,
          value: null,
          detail: null,
        },
      },
    };
    const hub = new PhoneHub(
      managedDisk(),
      testModules({ ...MODULES, upkeep: emitter("upkeep", [offered]) }),
    ).boot();
    const annaV2 = subscribed(hub, ANNA_PHONE, 2);
    const annaV1 = subscribed(hub, ANNA_LAPTOP, 1);
    const benV2 = subscribed(hub, BEN_LAPTOP, 2);
    const ticked = hub.advance(5);
    const hubEvents = (conn: typeof annaV2) => eventsOn(ticked, conn).filter((e) => e.ev === "hub");
    expect(hubEvents(annaV2).map((e) => (strictEvent(e).body as { what: string }).what)).toEqual([
      "updateOffered",
    ]);
    expect(hubEvents(annaV1)).toEqual([]);
    expect(hubEvents(benV2)).toEqual([]);
  });

  test("deviceUpdate: firmware's body as made, to version 2 sessions in devices with manage system", () => {
    const body = {
      device: 21,
      image: 1,
      state: "fetching",
      held: null,
      method: "ownLink",
      bytes: 64,
      of: 1128,
    } as const;
    const hub = new PhoneHub(
      managedDisk(),
      testModules({ ...MODULES, notify: emitter("notify", [{ kind: "deviceUpdateEvent", body }]) }),
    ).boot();
    const annaV2 = subscribed(hub, ANNA_PHONE, 2);
    const annaV1 = subscribed(hub, ANNA_LAPTOP, 1);
    const benV2 = subscribed(hub, BEN_LAPTOP, 2);
    const ticked = hub.advance(5);
    expect(eventsOn(ticked, annaV2).map((e) => strictEvent(e).body)).toEqual([body]);
    expect(eventsOn(ticked, annaV1)).toEqual([]);
    expect(eventsOn(ticked, benV2)).toEqual([]);
  });
});

describe("every frame a version 2 session receives passes the strict version 2 schemas", () => {
  test("a household's requests and the events they cause", () => {
    const hub = new PhoneHub().boot();
    const conn = subscribed(hub, ANNA_PHONE, 2);
    const other = hub.connect(ANNA_LAPTOP, 1);
    const ops = [
      { op: "snapshot", body: {} },
      { op: "hub.info", body: {} },
      { op: "device.list", body: {} },
      { op: "device.show", body: { device: 21 } },
      { op: "site.show", body: {} },
      { op: "people.list", body: {} },
      { op: "clients.list", body: {} },
      { op: "notifications.list", body: { limit: 10 } },
      { op: "arm", body: { target: { sensor: 11 } } },
      { op: "disarm", body: { target: "mine" } },
      { op: "group.create", body: { name: "Down", sensors: [11, 12], sirens: "all" } },
      { op: "device.rename", body: { device: 12, name: "garage-door" } },
      { op: "relay.status", body: {} },
      { op: "update.offers", body: {} },
      { op: "presence.set", body: { away: true } },
      { op: "link.create", body: { kind: "ownDevice", form: "qr" } },
    ] as const;
    const frames: unknown[] = [];
    for (const op of ops) {
      const asked = hub.request(conn, ANNA_PHONE, op);
      const reply = replyTo(asked.effects, conn);
      expect(appReplyV2.safeParse(reply).success).toBe(true);
      if (reply.ok) {
        const parsed = APP_OPS_V2[op.op].reply.safeParse(reply.body);
        expect(parsed.success ? op.op : `${op.op}: ${JSON.stringify(parsed.error.issues)}`).toBe(
          op.op,
        );
      }
      frames.push(...eventsOn(asked.effects, conn));
      // A version 1 session beside it is sent only version 1's frames.
      for (const frame of framesTo(asked.effects, other))
        if ("t" in frame && frame.t === "res") expect(appReply.safeParse(frame).success).toBe(true);
    }
    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) strictEvent(frame);
  });
});

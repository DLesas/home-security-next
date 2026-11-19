/** Device removal through the app and control channel, using the real hub modules. */
import { expect, test } from "bun:test";
import { APP_OPS_V2 } from "@hsn/protocol/app";
import { ok } from "neverthrow";
import { type DurableSnapshot, EMPTY_M3M4_SNAPSHOT } from "../../../src/core/model/events.ts";
import { DeviceState, DeviceUpdateState } from "../../../src/core/model/rows.ts";
import { historyPage } from "../../../src/shell/history-page.ts";
import { imageRow, Runner } from "../firmware/support.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN,
  BEN_LAPTOP,
  DEVICES,
  FRONT,
  GARAGE,
  HALL_SIREN,
  permission,
  role,
} from "../people/support/hub.ts";
import { rxRecord, seqOf } from "../storage/fixtures.ts";
import { Disk, errorOf, eventsOn, okBody, PhoneHub, replyTo } from "./support/phone-hub.ts";

class DiskWithFirmware extends Disk {
  /** Starts the hub with an image the owner can roll out. */
  override snapshot(): DurableSnapshot {
    return {
      ...super.snapshot(),
      m3m4: { ...EMPTY_M3M4_SNAPSHOT, firmwareImages: [imageRow()] },
    };
  }
}

test("a disarmed sensor in an open rollout can be removed and its update is cancelled", () => {
  const hub = new PhoneHub(new DiskWithFirmware().withSettings(1, 1)).boot();
  const conn = hub.connect(ANNA_PHONE);
  const rollout = hub.request(conn, ANNA_PHONE, {
    op: "rollout.start",
    body: { image: 1, devices: [FRONT] },
  });
  expect(replyTo(rollout.effects, conn).ok).toBe(true);
  expect(hub.state.firmware.updates.get(FRONT)?.row.state).toBe(DeviceUpdateState.Planned);
  expect(hub.state.alarm.countdowns.size).toBe(0);

  const removing = hub.request(conn, ANNA_PHONE, {
    op: "device.remove",
    body: { device: FRONT },
  });
  expect(errorOf(replyTo(removing.effects, conn))).toBeUndefined();
  expect(hub.device(FRONT)?.state).toBe(DeviceState.Removed);
  expect(hub.state.firmware.updates.get(FRONT)?.row.state).toBe(DeviceUpdateState.Cancelled);
});

test("a sensor with a running entry countdown still refuses removal", () => {
  const hub = new PhoneHub(new Disk().withSettings(1, 1)).boot();
  const conn = hub.connect(ANNA_PHONE);
  const house = new Runner(hub.state);
  house.countdown(FRONT);
  hub.state = house.view;

  const removing = hub.request(conn, ANNA_PHONE, {
    op: "device.remove",
    body: { device: FRONT },
  });
  expect(errorOf(replyTo(removing.effects, conn))).toEqual({
    code: "busy",
    detail: { because: "countdown" },
  });
});

test("removal preserves a sensor's history for the viewer and keeps it hidden from others", () => {
  const disk = new Disk().withSettings(1, 1);
  disk.people.userManagement = true;
  disk.people.roles.set(ANNA, role(ANNA, true, false));
  disk.people.roles.set(BEN, role(BEN, false, false));
  disk.people.permissions.set(`${ANNA}:${FRONT}`, permission(ANNA, FRONT, false, true));
  const hub = new PhoneHub(disk).boot();
  const recorded = rxRecord(seqOf(1, 1), FRONT, hub.wall(), "event");
  const source = { rows: () => ok([recorded]), staged: () => [] };
  const anna = hub.connect(ANNA_LAPTOP);
  const ben = hub.connect(BEN_LAPTOP);

  /** Runs the app request and applies its permission filter to the shell's history page. */
  const historyFor = (conn: typeof anna, client: typeof ANNA_LAPTOP) => {
    const { effects } = hub.request(conn, client, {
      op: "history.query",
      body: { limit: 10 },
    });
    const read = effects.find((effect) => effect.kind === "historyRead") ?? expect.unreachable();
    return historyPage(source, read.query, read.allowed)._unsafeUnwrap().rows;
  };

  expect(historyFor(anna, ANNA_LAPTOP)).toHaveLength(1);
  expect(historyFor(ben, BEN_LAPTOP)).toEqual([]);
  hub.command({ kind: "deviceRemove", name: "front" });
  expect(hub.device(FRONT)?.state).toBe(DeviceState.Removed);
  expect(historyFor(ben, BEN_LAPTOP)).toEqual([]);
  expect(historyFor(anna, ANNA_LAPTOP)).toHaveLength(1);
});

test.each([1, 2] as const)("version %d announces removal without a forget event", (proto) => {
  const hub = new PhoneHub().boot();
  const conn = hub.connect(ANNA_PHONE, proto);
  const subscribed = hub.request(conn, ANNA_PHONE, {
    op: "subscribe",
    body: { topics: ["devices"] },
  });
  expect(replyTo(subscribed.effects, conn).ok).toBe(true);

  const removed = hub.command({ kind: "deviceRemove", name: "front" });
  expect(hub.device(FRONT)?.state).toBe(DeviceState.Removed);
  expect(
    eventsOn(removed, conn)
      .filter((event) => event.ev === "device" || event.ev === "forget")
      .map((event) =>
        event.ev === "device" ? [event.ev, event.body.what, event.body.device.id] : [event.ev],
      ),
  ).toEqual([["device", "removed", FRONT]]);
});

test.each(["snapshot", "device.list"] as const)(
  "%s keeps reset and left-behind devices but omits removed ones",
  (op) => {
    const disk = new Disk();
    for (const row of DEVICES) {
      const state =
        row.id === FRONT
          ? DeviceState.ResetByOwner
          : row.id === GARAGE
            ? DeviceState.LeftBehind
            : DeviceState.Removed;
      disk.rows.devices.set(row.id, { ...row, state });
    }
    const hub = new PhoneHub(disk).boot();
    const conn = hub.connect(ANNA_PHONE, 2);
    expect(hub.device(HALL_SIREN)?.state).toBe(DeviceState.Removed);
    const reply = replyTo(hub.request(conn, ANNA_PHONE, { op, body: {} }).effects, conn);
    const parsed = APP_OPS_V2[op].reply.safeParse(okBody(reply));
    const devices = parsed.success ? parsed.data.devices : expect.unreachable();
    expect(devices.map((row) => [row.id, row.state])).toEqual([
      [FRONT, "resetByOwner"],
      [GARAGE, "leftBehind"],
    ]);
  },
);

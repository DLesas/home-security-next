/** Device removal through the app and control channel, using the real hub modules. */
import { expect, test } from "bun:test";
import { type DurableSnapshot, EMPTY_M3M4_SNAPSHOT } from "../../../src/core/model/events.ts";
import { DeviceState, DeviceUpdateState } from "../../../src/core/model/rows.ts";
import { imageRow, Runner } from "../firmware/support.ts";
import { ANNA_PHONE, FRONT } from "../people/support/hub.ts";
import { Disk, errorOf, PhoneHub, replyTo } from "./support/phone-hub.ts";

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

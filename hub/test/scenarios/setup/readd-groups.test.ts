/**
 * The reset-device rule's two other parts (hub-design.md section 9, from M3; the coordinator's
 * follow-up 4), through a real reset (the board shows on USB with no pairing, so the registry
 * retires it) and a real re-add, over USB (`hsn usb add`) and from a phone (`pair.prepare`,
 * `pair.finish`):
 *
 * - **Groups.** A device its owner reset keeps its group membership through the reset, so it is
 *   back in its groups when it is added again. Meanwhile it is no ghost: arming a group takes only
 *   the sensors the alarm knows, and a group's sirens only those still named, a list left with
 *   none sounding every siren. Removed for good, it leaves its groups.
 * - **Settings versions.** A re-added sensor's and siren's first settings version is above its
 *   last, not 1, so the device does not take settings it believes it already holds.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { encodeSetupMessage, ProvisionResultCode, Role, SetupType, toHex } from "@hsn/protocol";
import { type DeviceId, deviceId, groupId, linkId } from "../../../src/core/model/ids.ts";
import { DeviceState } from "../../../src/core/model/rows.ts";
import { triggerSirens } from "../../../src/core/layout/view.ts";
import { ANNA_LAPTOP, ANNA_PHONE, entropy } from "../../unit/people/support/hub.ts";
import { identityFrame } from "../../unit/setup/support/driver.ts";
import { expectNoKeyLeaks, noteEffects } from "../../unit/setup/support/leak-guard.ts";
import { Disk, errorOf, okBody, PhoneHub, replyTo } from "../../unit/app/support/phone-hub.ts";

afterAll(() => {
  expectNoKeyLeaks();
});

const FRONT = deviceId(11);
const GARAGE = deviceId(12);
const HALL = deviceId(21);
const SENSOR_VERSION = 7;
const SIREN_VERSION = 9;

/** A household whose group "Down" holds both sensors and sounds the hall siren only. */
function household(): { hub: PhoneHub; group: number } {
  const hub = new PhoneHub(new Disk().withSettings(SENSOR_VERSION, SIREN_VERSION)).boot();
  const conn = hub.connect(ANNA_LAPTOP);
  const made = hub.request(conn, ANNA_LAPTOP, {
    op: "group.create",
    body: { name: "Down", sensors: [FRONT, GARAGE], sirens: [HALL] },
  });
  return { hub, group: Number(okBody(replyTo(made.effects, conn)).id) };
}

function groupOf(hub: PhoneHub, id: number) {
  return hub.state.layout.groups.get(groupId(id)) ?? expect.unreachable();
}

let nextLink = 30;

/** The board shows on USB with no pairing: its owner reset it (registry, HD 6 state 3). */
function resetOnUsb(hub: PhoneHub, device: DeviceId): ReturnType<typeof linkId> {
  const row = hub.device(device) ?? expect.unreachable();
  const link = linkId(nextLink++);
  hub.input({ kind: "linkOpened", link, linkKind: "usb", label: `/dev/ttyACM${link}` });
  hub.input({
    kind: "frame",
    link,
    bytes: identityFrame({ role: row.role, chipId: row.chipId, development: false }),
  });
  expect(hub.device(device)?.state).toBe(DeviceState.ResetByOwner);
  return link;
}

function result(code: number): Uint8Array {
  return encodeSetupMessage({ type: SetupType.ProvisionResult, result: code });
}

/** Added again over USB, as `hsn usb add` does, and accepted. */
function readdOverUsb(
  hub: PhoneHub,
  device: DeviceId,
  link: ReturnType<typeof linkId>,
  name: string,
) {
  noteEffects(hub.command({ kind: "usbAdd", port: `/dev/ttyACM${link}`, name }, entropy([0x33])));
  noteEffects(hub.input({ kind: "frame", link, bytes: result(ProvisionResultCode.Accepted) }));
  expect(hub.device(device)?.state).toBe(DeviceState.Paired);
}

/** Added again from a phone, `pair.prepare` then `pair.finish`, accepted. */
function readdFromPhone(hub: PhoneHub, device: DeviceId, name: string) {
  const row = hub.device(device) ?? expect.unreachable();
  const phone = hub.connect(ANNA_PHONE);
  const identity = toHex(identityFrame({ role: row.role, chipId: row.chipId, development: false }));
  const prepared = hub.request(
    phone,
    ANNA_PHONE,
    { op: "pair.prepare", body: { identity, name } },
    { bytes: entropy([0x44]) },
  );
  noteEffects(prepared.effects);
  expect(okBody(replyTo(prepared.effects, phone)).device).toBe(device);
  const finished = hub.request(phone, ANNA_PHONE, {
    op: "pair.finish",
    body: { device, result: toHex(result(ProvisionResultCode.Accepted)) },
  });
  expect(errorOf(replyTo(finished.effects, phone))).toBeUndefined();
}

describe("groups through a reset and a re-add", () => {
  test("a sensor keeps its groups through the reset and is in them again once added (USB)", () => {
    const { hub, group } = household();
    const link = resetOnUsb(hub, FRONT);
    expect(groupOf(hub, group).sensors).toEqual([FRONT, GARAGE]);
    readdOverUsb(hub, FRONT, link, "front");
    expect(groupOf(hub, group).sensors).toEqual([FRONT, GARAGE]);
  });

  test("a siren keeps its groups through the reset and is in them again once added (phone)", () => {
    const { hub, group } = household();
    resetOnUsb(hub, HALL);
    expect(groupOf(hub, group).sirens).toEqual([HALL]);
    readdFromPhone(hub, HALL, "hall");
    expect(groupOf(hub, group).sirens).toEqual([HALL]);
    expect(triggerSirens(hub.state, FRONT)).toEqual([HALL]);
  });

  test("while reset it is no ghost: the group arms its other sensors, and sounds every siren", () => {
    const { hub, group } = household();
    resetOnUsb(hub, FRONT);
    resetOnUsb(hub, HALL);
    // The group's only siren is reset: a trigger sounds every siren, never none (section 7).
    expect(triggerSirens(hub.state, GARAGE)).toBe("all");
    const conn = hub.connect(ANNA_LAPTOP);
    const armed = hub.request(conn, ANNA_LAPTOP, { op: "arm", body: { target: { group } } });
    expect(okBody(replyTo(armed.effects, conn)).armed).toEqual([GARAGE]);
    // Editing the group, its kept member named again, is not refused.
    const edited = hub.request(conn, ANNA_LAPTOP, {
      op: "group.update",
      body: {
        group,
        name: "Downstairs",
        sensors: [FRONT, GARAGE],
        sirens: [HALL],
        ifRevision: groupOf(hub, group).revision,
      },
    });
    expect(errorOf(replyTo(edited.effects, conn))).toBeUndefined();
  });

  test("removed for good (a reset device may be removed), it leaves its groups", () => {
    const { hub, group } = household();
    resetOnUsb(hub, FRONT);
    const conn = hub.connect(ANNA_LAPTOP);
    const removed = hub.request(conn, ANNA_LAPTOP, {
      op: "device.remove",
      body: { device: FRONT },
    });
    expect(errorOf(replyTo(removed.effects, conn))).toBeUndefined();
    expect(hub.device(FRONT)?.state).toBe(DeviceState.Removed);
    expect(hub.device(FRONT)?.name).toBe("#11-front");
    expect(groupOf(hub, group).sensors).toEqual([GARAGE]);
  });
});

describe("settings versions of a re-added device start above its last", () => {
  test("a sensor over USB: its last version + 1, its settings sent as that version", () => {
    const { hub } = household();
    expect(hub.state.sensors.sensors.get(FRONT)?.config.version).toBe(SENSOR_VERSION);
    const link = resetOnUsb(hub, FRONT);
    readdOverUsb(hub, FRONT, link, "front");
    expect(hub.state.sensors.sensors.get(FRONT)?.config.version).toBe(SENSOR_VERSION + 1);
    expect(hub.disk.sensorConfig.get(FRONT)?.version).toBe(SENSOR_VERSION + 1);
  });

  test("a siren from a phone: its last version + 1", () => {
    const { hub } = household();
    resetOnUsb(hub, HALL);
    readdFromPhone(hub, HALL, "hall");
    expect(hub.state.sirens.sirens.get(HALL)?.settings.version).toBe(SIREN_VERSION + 1);
    expect(hub.disk.sirenConfig.get(HALL)?.version).toBe(SIREN_VERSION + 1);
  });

  test("after a restart between the reset and the re-add, too", () => {
    const { hub } = household();
    resetOnUsb(hub, FRONT);
    resetOnUsb(hub, HALL);
    const again = hub.restart();
    readdFromPhone(again, FRONT, "front");
    readdFromPhone(again, HALL, "hall");
    expect(again.state.sensors.sensors.get(FRONT)?.config.version).toBe(SENSOR_VERSION + 1);
    expect(again.state.sirens.sirens.get(HALL)?.settings.version).toBe(SIREN_VERSION + 1);
  });

  test("the version wraps: after 255 comes 1, never 0", () => {
    const hub = new PhoneHub(new Disk().withSettings(255, 255)).boot();
    resetOnUsb(hub, FRONT);
    resetOnUsb(hub, HALL);
    readdFromPhone(hub, FRONT, "front");
    readdFromPhone(hub, HALL, "hall");
    expect(hub.state.sensors.sensors.get(FRONT)?.config.version).toBe(1);
    expect(hub.state.sirens.sirens.get(HALL)?.settings.version).toBe(1);
  });

  test("a new device, never seen before, starts at 1", () => {
    const hub = new PhoneHub().boot();
    const phone = hub.connect(ANNA_PHONE);
    const prepared = hub.request(
      phone,
      ANNA_PHONE,
      {
        op: "pair.prepare",
        body: {
          identity: toHex(
            identityFrame({
              role: Role.Siren,
              chipId: new Uint8Array([9, 9, 9, 9, 9, 9]),
              development: false,
            }),
          ),
          name: "attic",
        },
      },
      { bytes: entropy([0x01, 0x00, 0x00, 0x7f]) },
    );
    noteEffects(prepared.effects);
    const device = deviceId(Number(okBody(replyTo(prepared.effects, phone)).device));
    expect(hub.state.sirens.sirens.get(device)?.settings.version).toBe(1);
  });
});

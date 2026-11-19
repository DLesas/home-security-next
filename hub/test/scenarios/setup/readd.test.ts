/**
 * A device its owner reset, added again (docs/m3-design.md section 5, "A chip the hub holds as
 * reset by its owner"; hub-design.md section 9, from M3), over USB (`hsn usb add`) and from a
 * phone (`pair.prepare`, `pair.finish`): it keeps its row (its number, its address, the people's
 * permissions on it, its history), takes the name given now and a new key, and comes back paired.
 * A refusal returns it to "reset by its owner", also after a restart; a removed device (state 4)
 * is a new row; one left behind by a forced move (state 5) keeps its row too.
 */
import { describe, expect, test } from "bun:test";
import { encodeSetupMessage, ProvisionResultCode, Role, SetupType, toHex } from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import { deviceId, linkId, personId } from "../../../src/core/model/ids.ts";
import { type DeviceRow, DeviceState } from "../../../src/core/model/rows.ts";
import { ANNA_PHONE, BEN, entropy } from "../../unit/people/support/hub.ts";
import { identityFrame } from "../../unit/setup/support/driver.ts";
import { expectNoKeyLeaks, noteEffects } from "../../unit/setup/support/leak-guard.ts";
import { Disk, okBody, PhoneHub, replyTo, seededKey } from "../../unit/app/support/phone-hub.ts";
import { afterAll } from "bun:test";

afterAll(() => {
  expectNoKeyLeaks();
});

const HALL = deviceId(21);

/** The disk of a household whose hall siren its owner reset: retired, its key deleted. */
function resetDisk(state: DeviceState = DeviceState.ResetByOwner): Disk {
  const disk = new Disk();
  const hall = disk.rows.devices.get(HALL) ?? expect.unreachable();
  const retired: DeviceRow =
    state === DeviceState.LeftBehind
      ? { ...hall, state }
      : { ...hall, state, name: "#21-hall", removedMs: hall.addedMs + 1 };
  disk.rows.devices.set(HALL, retired);
  if (state !== DeviceState.LeftBehind) disk.rows.keys.delete(HALL);
  // Ben's permission on the siren, which the people's tables keep.
  disk.people.permissions.set(`${BEN}:${HALL}`, {
    personId: personId(BEN),
    deviceId: HALL,
    manage: true,
    view: true,
  });
  return disk;
}

function hallIdentity(hub: PhoneHub): string {
  const hall = hub.device(HALL) ?? expect.unreachable();
  return toHex(identityFrame({ role: Role.Siren, chipId: hall.chipId, development: false }));
}

function result(code: number): string {
  return toHex(encodeSetupMessage({ type: SetupType.ProvisionResult, result: code }));
}

const KEY = Array.from({ length: 16 }, (_, i) => 0xc0 + i);

function prepare(hub: PhoneHub, name = "hall-2") {
  const phone = hub.connect(ANNA_PHONE);
  const asked = hub.request(
    phone,
    ANNA_PHONE,
    { op: "pair.prepare", body: { identity: hallIdentity(hub), name } },
    { bytes: entropy(KEY) },
  );
  noteEffects(asked.effects);
  return { phone, asked, body: okBody(replyTo(asked.effects, phone)) };
}

function finish(hub: PhoneHub, code: number) {
  const phone = hub.connect(ANNA_PHONE);
  const done = hub.request(phone, ANNA_PHONE, {
    op: "pair.finish",
    body: { device: HALL, result: result(code) },
  });
  return okBody(replyTo(done.effects, phone));
}

function deviceWrites(effects: readonly Effect[]): readonly DeviceRow[] {
  return effects.flatMap((e) =>
    e.kind === "write" && e.op.table === "devices" && e.op.op === "upsert" ? [e.op.row] : [],
  );
}

describe("from a phone", () => {
  test("keeps its row: number, address, permissions; the name given; a new key; then paired", () => {
    const hub = new PhoneHub(resetDisk()).boot();
    const before = hub.device(HALL) ?? expect.unreachable();
    const { body, asked } = prepare(hub);
    expect(body.device).toBe(HALL);
    const row = hub.device(HALL) ?? expect.unreachable();
    expect(row).toMatchObject({
      id: HALL,
      address: before.address,
      addedMs: before.addedMs,
      name: "hall-2",
      state: DeviceState.Provisioning,
    });
    expect(deviceWrites(asked.effects).map((r) => r.id)).toEqual([HALL]);
    expect([...(hub.disk.rows.keys.get(HALL) ?? [])]).toEqual(KEY);
    expect(hub.disk.rows.resumePoints.get(HALL)).toBe(1024);
    expect(finish(hub, ProvisionResultCode.Accepted).device).toMatchObject({
      id: HALL,
      name: "hall-2",
      state: "paired",
    });
    const paired = hub.device(HALL) ?? expect.unreachable();
    expect(paired.state).toBe(DeviceState.Paired);
    expect(paired.removedMs).toBeNull();
    // Ben's permission on it is still there: people's rows were never touched.
    expect(hub.state.people.permissions.get(personId(BEN))?.get(HALL)).toMatchObject({
      manage: true,
    });
  });

  test("the old name comes back when it is given again", () => {
    const hub = new PhoneHub(resetDisk()).boot();
    prepare(hub, "hall");
    expect(hub.device(HALL)?.name).toBe("hall");
  });

  test("a refusal returns it to reset by its owner, its new key deleted", () => {
    const hub = new PhoneHub(resetDisk()).boot();
    prepare(hub);
    expect(finish(hub, ProvisionResultCode.Refused)).toEqual({ device: null });
    expect(hub.device(HALL)).toMatchObject({
      state: DeviceState.ResetByOwner,
      name: "#21-hall-2",
    });
    expect(hub.disk.rows.keys.has(HALL)).toBe(false);
  });

  test("also after a restart between prepare and finish", () => {
    const hub = new PhoneHub(resetDisk()).boot();
    prepare(hub);
    const again = hub.restart();
    expect(again.device(HALL)?.state).toBe(DeviceState.Provisioning);
    expect(finish(again, ProvisionResultCode.NotValid)).toEqual({ device: null });
    expect(again.device(HALL)?.state).toBe(DeviceState.ResetByOwner);
    expect(again.device(HALL)?.address).toBe(hub.device(HALL)?.address);
  });

  test("a removed device is a new row", () => {
    const hub = new PhoneHub(resetDisk(DeviceState.Removed)).boot();
    const { body } = prepare(hub);
    expect(body.device).not.toBe(HALL);
    expect(hub.device(HALL)?.state).toBe(DeviceState.Removed);
  });

  test("one left behind by a forced move keeps its row; its old state is dropped first", () => {
    const hub = new PhoneHub(resetDisk(DeviceState.LeftBehind)).boot();
    const { body, asked } = prepare(hub);
    expect(body.device).toBe(HALL);
    const order = asked.effects.flatMap((e) =>
      e.kind === "write" && e.op.table === "devices" ? [e.op.op] : [],
    );
    expect(order).toEqual(["upsert"]);
    expect(hub.device(HALL)?.state).toBe(DeviceState.Provisioning);
    expect([...(hub.disk.rows.keys.get(HALL) ?? [])]).toEqual(KEY);
    expect([...(hub.disk.rows.keys.get(HALL) ?? [])]).not.toEqual([...seededKey(HALL)]);
    // The sirens module took it as new: settings version 1 under the new key.
    expect(hub.state.sirens.sirens.has(HALL)).toBe(true);
  });
});

describe("over USB, `hsn usb add`", () => {
  test("keeps its row too, with a new key", () => {
    const hub = new PhoneHub(resetDisk()).boot();
    const before = hub.device(HALL) ?? expect.unreachable();
    const usb = linkId(9);
    hub.input({ kind: "linkOpened", link: usb, linkKind: "usb", label: "/dev/ttyACM0" });
    hub.input({
      kind: "frame",
      link: usb,
      bytes: identityFrame({ role: Role.Siren, chipId: before.chipId, development: false }),
    });
    const added = hub.command({ kind: "usbAdd", port: "/dev/ttyACM0", name: "hall" }, entropy(KEY));
    noteEffects(added);
    expect(hub.device(HALL)).toMatchObject({
      address: before.address,
      name: "hall",
      state: DeviceState.Provisioning,
    });
    expect([...(hub.disk.rows.keys.get(HALL) ?? [])]).toEqual(KEY);
    const answered = hub.input({
      kind: "frame",
      link: usb,
      bytes: encodeSetupMessage({
        type: SetupType.ProvisionResult,
        result: ProvisionResultCode.Accepted,
      }),
    });
    noteEffects(answered);
    expect(hub.device(HALL)?.state).toBe(DeviceState.Paired);
    expect([...hub.state.registry.devices.keys()].filter((id) => id > HALL)).toEqual([]);
  });
});

/**
 * The registry (hub-design.md section 2, module 2; sections 6 and 9): the rule for names, unique
 * names and addresses, renaming, removal that deletes the key and keeps the history, contact,
 * firmware versions from Started, a reset by the owner (button or USB), and the boot.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  ButtonAction,
  decodeMessage,
  type Message,
  MessageType,
  ProvisionResultCode,
  toHex,
} from "@hsn/protocol";
import { ok } from "neverthrow";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { Context } from "../../../src/core/model/handler.ts";
import { entropyCursor } from "../../../src/core/util/entropy.ts";
import { deviceId, type DeviceId, linkId, seq } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { type DeviceRow, DeviceState } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import { ADVERTISE_SERVED_PORT, handleRegistry } from "../../../src/core/registry/handle.ts";
import {
  gatewayName,
  MAX_NAME_LENGTH,
  nameProblem,
  retiredName,
} from "../../../src/core/registry/names.ts";
import { firmwareText, newNameProblem } from "../../../src/core/registry/view.ts";
import {
  CHIP_A,
  CHIP_B,
  deviceNamed,
  Driver,
  errorCode,
  hubEvents,
  HUB_IDENTITY,
  identityFrame,
  nowWrites,
  onlyReply,
  OTHER_HUB_IDENTITY,
  Role,
  sends,
  snapshot,
  writes,
} from "../setup/support/driver.ts";
import { expectNoKeyLeaks, noteEffects, noteValue } from "../setup/support/leak-guard.ts";

afterAll(() => {
  expectNoKeyLeaks();
});

function row(id: number, overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: deviceId(id),
    address: 0x5e000000 + id,
    role: Role.Sensor,
    name: `dev${id}`,
    chipId: new Uint8Array([0, 0, 0, 0, 0, id]),
    firmware: 0x010000,
    development: false,
    state: DeviceState.Contacted,
    addedMs: 1,
    removedMs: null,
    ...overrides,
  };
}

function booted(devices: readonly DeviceRow[]): Driver {
  const hub = new Driver();
  hub.boot(snapshot({ devices }));
  return hub;
}

/** Runs the registry handler alone on the driver's state, as the dispatcher would. */
function deliver(hub: Driver, message: Internal): readonly (Internal | Effect)[] {
  let n = 0;
  const ctx: Context = {
    now: { mono: mono(5_000_000), wall: 1_800_000_000_000, wallTrusted: true },
    view: hub.state,
    deps: hub.deps,
    entropy: entropyCursor(new Uint8Array(32), "frame"),
    records: { take: () => ok(seq(2 ** 32 + n++)) },
    event: "frame",
  };
  const result = handleRegistry(hub.state.registry, message, ctx);
  expect(result.isOk()).toBe(true);
  if (result.isErr()) return [];
  hub.state = { ...hub.state, registry: result.value.slice };
  noteEffects(result.value.out.filter((item): item is Effect => item.kind === "write"));
  for (const item of result.value.out) if (item.kind === "auditRecord") noteValue(item.record);
  return result.value.out;
}

function effectsOf(out: readonly (Internal | Effect)[]): readonly Effect[] {
  return out.filter((item): item is Effect => item.kind === "write" || item.kind === "advertise");
}

function accepted(device: DeviceId, message: Message, newest = true): Internal {
  return {
    kind: "accepted",
    device,
    role: Role.Sensor,
    counter: 70,
    message,
    arrival: { path: "usb", link: linkId(1) },
    record: seq(2 ** 32),
    newest,
  };
}

const STARTED: Message = {
  type: MessageType.Started,
  role: Role.Sensor,
  firmwareVersion: { major: 2, minor: 3, patch: 4 },
  resetCause: 1,
  lastFatalError: 0,
  settingsVersion: 1,
};

/** A button report (§6) with this action, decoded from its plaintext. */
function button(action: number): Message {
  const decoded = decodeMessage(
    new Uint8Array([MessageType.Button, 1, 0x10, 100, 20, 0, 0, 0, action]),
  );
  expect(decoded.ok).toBe(true);
  return decoded.ok ? decoded.value : STARTED;
}

describe("the rule for names (section 9)", () => {
  test("1 to 64 characters, no white space, no control characters, not starting with #", () => {
    expect(nameProblem("")).toBe("empty");
    expect(nameProblem("a")).toBeUndefined();
    expect(nameProblem("x".repeat(MAX_NAME_LENGTH))).toBeUndefined();
    expect(nameProblem("x".repeat(MAX_NAME_LENGTH + 1))).toBe("tooLong");
    expect(nameProblem("front door")).toBe("whiteSpace");
    expect(nameProblem("front door")).toBe("whiteSpace");
    expect(nameProblem("front\u0007")).toBe("control");
    expect(nameProblem("front\u007f")).toBe("control");
    expect(nameProblem("front\u009f")).toBe("control");
    expect(nameProblem("front\u001b[31m")).toBe("control");
    expect(nameProblem("#front")).toBe("reserved");
    expect(nameProblem("front#2")).toBeUndefined();
    expect(nameProblem("Küche-tür")).toBeUndefined();
  });

  test("a retired name is #<id>-<name>, at most 64 characters, never splitting a character", () => {
    expect(retiredName(deviceId(3), "front")).toBe("#3-front");
    const long = retiredName(deviceId(12345), "😀".repeat(40));
    expect(long.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(long.startsWith("#12345-")).toBe(true);
    expect(nameProblem(long)).toBe("reserved");
    expect(Array.from(long.slice(7)).every((c) => c === "😀")).toBe(true);
  });

  test("an automatically added gateway is gateway-<chip>", () => {
    expect(gatewayName(CHIP_A)).toBe(`gateway-${toHex(CHIP_A)}`);
    expect(nameProblem(gatewayName(CHIP_A))).toBeUndefined();
  });

  test("a name is taken by any row, retired ones included, except the device's own", () => {
    const hub = booted([
      row(2, { name: "front" }),
      row(3, { name: "#3-back", state: DeviceState.Removed }),
    ]);
    expect(newNameProblem(hub.state, "front")).toBe("taken");
    expect(newNameProblem(hub.state, "front", deviceId(2))).toBeUndefined();
    expect(newNameProblem(hub.state, "back")).toBeUndefined();
    expect(newNameProblem(hub.state, "Front")).toBeUndefined();
  });
});

describe("boot", () => {
  test("rows come from the snapshot, and mDNS is asked to advertise the identity (§10)", () => {
    const hub = new Driver();
    const effects = hub.boot(snapshot({ devices: [row(7)] }));
    expect(effects).toContainEqual({
      kind: "advertise",
      identity: HUB_IDENTITY,
      port: ADVERTISE_SERVED_PORT,
    });
    expect(hub.state.registry.highestId).toBe(7);
    expect(hub.state.registry.devices.get(deviceId(7))?.name).toBe("dev7");
  });

  test("with no signing key yet, nothing is advertised", () => {
    const hub = new Driver();
    expect(
      hub.boot(snapshot({ hubKeys: undefined })).filter((e) => e.kind === "advertise"),
    ).toEqual([]);
  });
});

describe("rename (section 9)", () => {
  test("a free name that keeps the rule: the row is written now and the CLI answered", () => {
    const hub = booted([row(2, { name: "front" })]);
    const { effects } = hub.command({ kind: "deviceRename", from: "front", to: "porch" });
    expect(onlyReply(effects)).toEqual({
      ok: true,
      result: { kind: "deviceRename", name: "porch" },
    });
    expect(nowWrites(effects)).toEqual([
      { table: "devices", op: "upsert", row: { ...row(2), name: "porch" } },
    ]);
  });

  test("a taken name, a reserved one, an unknown device, a retired device are refused", () => {
    const hub = booted([
      row(2, { name: "front" }),
      row(3, { name: "back" }),
      row(4, { name: "#4-old", state: DeviceState.Removed }),
    ]);
    expect(
      errorCode(
        onlyReply(hub.command({ kind: "deviceRename", from: "front", to: "back" }).effects),
      ),
    ).toBe("nameTaken");
    expect(
      errorCode(onlyReply(hub.command({ kind: "deviceRename", from: "front", to: "#x" }).effects)),
    ).toBe("badRequest");
    expect(
      errorCode(onlyReply(hub.command({ kind: "deviceRename", from: "nobody", to: "x" }).effects)),
    ).toBe("unknownDevice");
    expect(
      errorCode(onlyReply(hub.command({ kind: "deviceRename", from: "#4-old", to: "x" }).effects)),
    ).toBe("unknownDevice");
    expect(writes(hub.all)).toEqual([]);
  });

  test("renaming to the same name changes nothing", () => {
    const hub = booted([row(2, { name: "front" })]);
    const { effects } = hub.command({ kind: "deviceRename", from: "front", to: "front" });
    expect(errorCode(onlyReply(effects))).toBe("ok");
    expect(writes(effects)).toEqual([]);
  });
});

describe("removal: the key is deleted, the history kept (section 9)", () => {
  test("the row stays as removed under a retired name; key and resume point are deleted now", () => {
    const hub = booted([row(2, { name: "front" })]);
    const { effects } = hub.command({ kind: "deviceRemove", name: "front" });
    expect(onlyReply(effects)).toEqual({
      ok: true,
      result: { kind: "deviceRemove", name: "front" },
    });
    const ops = nowWrites(effects);
    expect(ops).toContainEqual({
      table: "device_keys",
      op: "delete",
      key: { deviceId: deviceId(2) },
    });
    expect(ops).toContainEqual({
      table: "send_counters",
      op: "delete",
      key: { deviceId: deviceId(2) },
    });
    const kept = hub.state.registry.devices.get(deviceId(2));
    expect(kept).toMatchObject({
      state: DeviceState.Removed,
      name: "#2-front",
      address: row(2).address,
    });
    expect(kept?.removedMs).not.toBeNull();
    expect(ops.some((op) => op.op === "delete" && op.table === "devices")).toBe(false);
    expect(hubEvents(effects).map((e) => [e.row.code, e.durability])).toEqual([
      ["device_removed", "now"],
    ]);
  });

  test("the name can be given again; the address is never given again", () => {
    const hub = booted([row(2, { name: "front" })]);
    hub.command({ kind: "deviceRemove", name: "front" });
    expect(newNameProblem(hub.state, "front")).toBeUndefined();
    expect([...hub.state.registry.devices.values()].some((r) => r.address === row(2).address)).toBe(
      true,
    );
  });

  test("a device already removed, or no device, is refused", () => {
    const hub = booted([row(2, { name: "#2-front", state: DeviceState.Removed })]);
    expect(
      errorCode(onlyReply(hub.command({ kind: "deviceRemove", name: "#2-front" }).effects)),
    ).toBe("unknownDevice");
    expect(errorCode(onlyReply(hub.command({ kind: "deviceRemove", name: "front" }).effects))).toBe(
      "unknownDevice",
    );
  });
});

describe("contact, firmware and resets from packets", () => {
  test("the first authentic packet makes a paired or provisioning device contacted, written now", () => {
    for (const state of [DeviceState.Paired, DeviceState.Provisioning]) {
      const hub = booted([row(2, { state })]);
      const out = effectsOf(
        deliver(
          hub,
          accepted(deviceId(2), { ...STARTED, firmwareVersion: { major: 1, minor: 0, patch: 0 } }),
        ),
      );
      expect(out).toEqual([
        {
          kind: "write",
          durability: "now",
          op: { table: "devices", op: "upsert", row: { ...row(2), state: DeviceState.Contacted } },
        },
      ]);
    }
  });

  test("a later packet of a contacted device with nothing new writes nothing", () => {
    const hub = booted([row(2)]);
    expect(effectsOf(deliver(hub, accepted(deviceId(2), button(ButtonAction.ShortPress))))).toEqual(
      [],
    );
  });

  test("Started gives the firmware version; one that is not the newest does not", () => {
    const hub = booted([row(2)]);
    expect(effectsOf(deliver(hub, accepted(deviceId(2), STARTED, false)))).toEqual([]);
    const out = effectsOf(deliver(hub, accepted(deviceId(2), STARTED)));
    expect(out).toEqual([
      {
        kind: "write",
        durability: "now",
        op: { table: "devices", op: "upsert", row: { ...row(2), firmware: 0x020304 } },
      },
    ]);
    expect(firmwareText(0x020304)).toBe("2.3.4");
  });

  test("a button report 'factory reset going ahead' resets the device: key deleted, name freed", () => {
    const hub = booted([row(2, { name: "front" })]);
    const out = deliver(hub, accepted(deviceId(2), button(ButtonAction.FactoryResetGoingAhead)));
    expect(hub.state.registry.devices.get(deviceId(2))).toMatchObject({
      state: DeviceState.ResetByOwner,
      name: "#2-front",
    });
    expect(out).toContainEqual({ kind: "deviceRemoved", device: deviceId(2) });
    expect(
      effectsOf(out).map((e) => (e.kind === "write" ? `${e.op.table} ${e.op.op}` : e.kind)),
    ).toEqual(["devices upsert", "device_keys delete", "send_counters delete"]);
  });

  test("other button actions, and a reset report that is not the newest, reset nothing", () => {
    for (const action of [
      ButtonAction.ShortPress,
      ButtonAction.FactoryResetHoldWhileArmed,
      ButtonAction.PairingHoldIgnoredWhileArmed,
    ]) {
      const hub = booted([row(2)]);
      deliver(hub, accepted(deviceId(2), button(action)));
      expect(hub.state.registry.devices.get(deviceId(2))?.state).toBe(DeviceState.Contacted);
    }
    const hub = booted([row(2)]);
    deliver(hub, accepted(deviceId(2), button(ButtonAction.FactoryResetGoingAhead), false));
    expect(hub.state.registry.devices.get(deviceId(2))?.state).toBe(DeviceState.Contacted);
  });

  test("a gateway's proven session makes it contacted", () => {
    const hub = booted([row(2, { role: Role.Gateway, state: DeviceState.Paired })]);
    deliver(hub, { kind: "gatewayUp", gateway: deviceId(2), link: linkId(3) });
    expect(hub.state.registry.devices.get(deviceId(2))?.state).toBe(DeviceState.Contacted);
  });

  test("provisionAnswered: accepted gives paired; any other answer deletes the rows", () => {
    const hub = booted([
      row(2, { state: DeviceState.Provisioning }),
      row(3, { state: DeviceState.Provisioning }),
    ]);
    deliver(hub, {
      kind: "provisionAnswered",
      device: deviceId(2),
      result: ProvisionResultCode.Accepted,
    });
    expect(hub.state.registry.devices.get(deviceId(2))?.state).toBe(DeviceState.Paired);
    const out = deliver(hub, {
      kind: "provisionAnswered",
      device: deviceId(3),
      result: ProvisionResultCode.Refused,
    });
    expect(hub.state.registry.devices.has(deviceId(3))).toBe(false);
    expect(hub.state.registry.highestId).toBe(3);
    expect(out).toContainEqual({ kind: "deviceRemoved", device: deviceId(3) });
  });
});

describe("a board on USB that is no longer paired to this hub", () => {
  for (const [what, hubIdentity] of [
    ["unpaired", undefined],
    ["paired to another hub", OTHER_HUB_IDENTITY],
  ] as const) {
    test(`a working device whose board shows ${what} is reset by its owner`, () => {
      const hub = booted([row(2, { name: "front", chipId: CHIP_B })]);
      const { link } = hub.openUsb("/dev/ttyACM0");
      const effects = hub.frame(
        link,
        identityFrame({
          role: Role.Sensor,
          chipId: CHIP_B,
          development: false,
          ...(hubIdentity === undefined ? {} : { hubIdentity }),
        }),
      );
      expect(hub.state.registry.devices.get(deviceId(2))).toMatchObject({
        state: DeviceState.ResetByOwner,
        name: "#2-front",
      });
      expect(nowWrites(effects)).toContainEqual({
        table: "device_keys",
        op: "delete",
        key: { deviceId: deviceId(2) },
      });
      expect(
        hubEvents(effects).find((e) => e.row.code === "device_reset_by_owner")?.durability,
      ).toBe("now");
    });
  }

  test("a board that shows it is ours, or a device still provisioning, is not reset", () => {
    const hub = booted([
      row(2, { chipId: CHIP_B }),
      row(3, { chipId: CHIP_A, state: DeviceState.Provisioning }),
    ]);
    const { link } = hub.openUsb("/dev/ttyACM0");
    hub.frame(
      link,
      identityFrame({
        role: Role.Sensor,
        chipId: CHIP_B,
        development: false,
        hubIdentity: HUB_IDENTITY,
      }),
    );
    hub.frame(link, identityFrame({ role: Role.Sensor, chipId: CHIP_A, development: false }));
    expect(hub.state.registry.devices.get(deviceId(2))?.state).toBe(DeviceState.Contacted);
    expect(hub.state.registry.devices.get(deviceId(3))?.state).toBe(DeviceState.Provisioning);
  });

  test("a factory-reset gateway is added again at once, under its own name, as a new device (D100)", () => {
    const old = row(2, { role: Role.Gateway, name: gatewayName(CHIP_A), chipId: CHIP_A });
    const hub = booted([old]);
    const { link } = hub.openUsb("/dev/ttyACM0");
    const effects = hub.frame(
      link,
      identityFrame({ role: Role.Gateway, chipId: CHIP_A, development: false }),
    );
    expect(hub.state.registry.devices.get(deviceId(2))?.state).toBe(DeviceState.ResetByOwner);
    expect(deviceNamed(hub.state, gatewayName(CHIP_A))?.id).toBe(deviceId(3));
    // The old row's new name is staged before the new row takes the name (unique key, section 6).
    const deviceWrites = writes(effects).flatMap((op) =>
      op.table === "devices" && op.op === "upsert" ? [op.row.id] : [],
    );
    expect(deviceWrites).toEqual([deviceId(2), deviceId(3)]);
    expect(sends(effects).some((s) => s.bytes[1] === 0x03)).toBe(true);
  });
});

describe("the hub's own row", () => {
  test("device 0 is never listed, named or removed", () => {
    const hub = booted([row(0, { name: "hub", role: 0 })]);
    expect(errorCode(onlyReply(hub.command({ kind: "deviceRemove", name: "hub" }).effects))).toBe(
      "unknownDevice",
    );
    const devices = onlyReply(hub.command({ kind: "devices" }).effects);
    expect(
      devices.ok && devices.result.kind === "devices" ? devices.result.devices : ["x"],
    ).toEqual([]);
  });
});

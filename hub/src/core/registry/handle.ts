/**
 * The registry module's handler (hub-design.md section 2, module 2; sections 6 and 9).
 *
 * - `boot`: the devices and the hub's signing identity from the snapshot; mDNS starts (§10).
 * - `deviceAdded` (from setup): a row in state provisioning, written now with the key and the
 *   resume point setup writes, before the Provision message goes (section 9).
 * - `provisionAnswered`: accepted gives paired; any other answer setup passes on deletes the
 *   rows (section 9, "Refused or not valid").
 * - The first authentic packet (`accepted`, or a gateway's proven session) gives contacted; a
 *   Started gives the firmware version; a button report "factory reset going ahead" (§6) and a
 *   USB Identity showing the board no longer paired to this hub give "reset by its owner".
 * - `deviceRenameRequest` and `deviceRemoveRequest`, answered here. Removal and reset delete the
 *   key and keep the row, so the history keeps its device; the name is freed (`names.ts`).
 *
 * Every change to a row is written now (section 5: "Device registry, keys, pairing data").
 * SPEC-QUESTION: the module table has the registry handle `deviceRemoved`; here the registry is
 * the one that emits it, for a removal, a reset and a refused provisioning, so the modules that
 * keep a device's settings drop them.
 */
import { ButtonAction, MessageType, ProvisionResultCode } from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import { answerError, answerOk } from "../control/view.ts";
import type { Effect } from "../model/effects.ts";
import { type CoreFault, coreFault } from "../model/errors.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import type { DeviceId, RequestId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { type DeviceRow, DeviceState } from "../model/rows.ts";
import { belonging, identityIn, provisionedIdentity } from "../setup/view.ts";
import { retiredName } from "./names.ts";
import { DEVICE_STATE_NAMES, deviceFields, hubEventRecord } from "./records.ts";
import type { RegistrySlice } from "./state.ts";
import {
  deviceById,
  devicesByChip,
  firmwareNumber,
  isNamed,
  NAME_PROBLEM_TEXT,
  newNameProblem,
} from "./view.ts";

const ORIGIN = "core/registry";

/**
 * The port the `advertise` effect names. SPEC-QUESTION: §10 has devices connect to the app port,
 * which the core is never told (neither `BootInfo` nor `HubRules` carries it); 0 asks the shell's
 * advertiser for the port it serves on (shell/advertise).
 */
export const ADVERTISE_SERVED_PORT = 0;

/** Rows a USB Identity that is not ours retires: a device that was working with this hub. */
const RESETTABLE: ReadonlySet<DeviceState> = new Set([
  DeviceState.Paired,
  DeviceState.Contacted,
  DeviceState.LeftBehind,
]);

/** Rows the first authentic packet moves to contacted. */
const AWAITING_CONTACT: ReadonlySet<DeviceState> = new Set([
  DeviceState.Provisioning,
  DeviceState.Paired,
]);

type Out = Internal | Effect;
type Step = Result<Handled<"registry">, CoreFault>;

function unchanged(slice: RegistrySlice): Step {
  return ok({ slice, out: [] });
}

function withRow(slice: RegistrySlice, row: DeviceRow): RegistrySlice {
  const devices = new Map(slice.devices);
  devices.set(row.id, row);
  return { ...slice, devices, highestId: Math.max(slice.highestId, row.id) };
}

function withoutRow(slice: RegistrySlice, id: DeviceId): RegistrySlice {
  const devices = new Map(slice.devices);
  devices.delete(id);
  return { ...slice, devices };
}

/**
 * A device row written, with the record of the change (section 6, the `device_*` hub events):
 * the device's fields as they are now, and what they were where they changed.
 */
function change(
  ctx: Context,
  code: "device_added" | "device_renamed" | "device_state" | "device_not_added",
  row: DeviceRow,
  previous: DeviceRow | undefined,
  message: string,
): Result<Internal, CoreFault> {
  const before = {
    ...(previous !== undefined && previous.name !== row.name
      ? { previousName: previous.name }
      : {}),
    ...(previous !== undefined && previous.state !== row.state
      ? { previousState: DEVICE_STATE_NAMES[previous.state] ?? String(previous.state) }
      : {}),
  };
  return hubEventRecord(ctx, {
    level: "info",
    origin: ORIGIN,
    code,
    message,
    detail: JSON.stringify({ ...deviceFields(row), ...before }),
  });
}

/** The row written and its record, as a step's output. */
function written(
  slice: RegistrySlice,
  ctx: Context,
  code: "device_added" | "device_renamed" | "device_state",
  row: DeviceRow,
  previous: DeviceRow | undefined,
  message: string,
  more: readonly Out[] = [],
): Step {
  return change(ctx, code, row, previous, message).map((record) => ({
    slice: withRow(slice, row),
    out: [writeRow(row), record, ...more],
  }));
}

function writeRow(row: DeviceRow): Effect {
  return { kind: "write", durability: "now", op: { table: "devices", op: "upsert", row } };
}

/** The key and the hub's resume point for it go together (section 6). */
function deleteKey(id: DeviceId): readonly Effect[] {
  return [
    {
      kind: "write",
      durability: "now",
      op: { table: "device_keys", op: "delete", key: { deviceId: id } },
    },
    {
      kind: "write",
      durability: "now",
      op: { table: "send_counters", op: "delete", key: { deviceId: id } },
    },
  ];
}

function boot(slice: RegistrySlice, snapshot: DurableSnapshot): Step {
  const devices = new Map(snapshot.devices.map((row) => [row.id, row]));
  const highestId = snapshot.devices.reduce((most, row) => Math.max(most, row.id), 0);
  const hub =
    snapshot.hubKeys === undefined
      ? undefined
      : { signingPublic: snapshot.hubKeys.signingPublic, identity: snapshot.hubKeys.identity };
  const out: Out[] =
    hub === undefined
      ? []
      : [{ kind: "advertise", identity: hub.identity, port: ADVERTISE_SERVED_PORT }];
  return ok({ slice: { ...slice, devices, highestId, hub }, out });
}

/**
 * Retires a device that is there no more for this hub: removed by a person, or reset by its
 * owner. Its key is deleted and its name freed; its row and history stay.
 */
function retire(
  slice: RegistrySlice,
  row: DeviceRow,
  state: typeof DeviceState.Removed | typeof DeviceState.ResetByOwner,
  ctx: Context,
  why: string,
): Result<{ readonly slice: RegistrySlice; readonly out: readonly Out[] }, CoreFault> {
  const retired: DeviceRow = {
    ...row,
    state,
    name: retiredName(row.id, row.name),
    removedMs: ctx.now.wall,
  };
  const reset = state === DeviceState.ResetByOwner;
  return hubEventRecord(ctx, {
    level: reset ? "warning" : "info",
    origin: ORIGIN,
    code: reset ? "device_reset_by_owner" : "device_removed",
    message: `${row.name}: ${why}; its key is deleted, its history kept, and it is now ${retired.name}`,
    detail: JSON.stringify({
      ...deviceFields(retired),
      previousName: row.name,
      previousState: DEVICE_STATE_NAMES[row.state] ?? String(row.state),
    }),
    durability: "now",
  }).map((record) => ({
    slice: withRow(slice, retired),
    out: [
      writeRow(retired),
      ...deleteKey(row.id),
      { kind: "deviceRemoved", device: row.id },
      record,
    ],
  }));
}

/** Retires each device in turn, threading the slice. */
function retireAll(
  slice: RegistrySlice,
  rows: readonly DeviceRow[],
  ctx: Context,
  why: string,
): Step {
  let current: Step = unchanged(slice);
  for (const row of rows) {
    current = current.andThen((done) =>
      retire(done.slice, row, DeviceState.ResetByOwner, ctx, why).map((next) => ({
        slice: next.slice,
        out: [...done.out, ...next.out],
      })),
    );
  }
  return current;
}

/** A USB Identity that says a board we have as working is no longer paired to this hub. */
function identitySeen(slice: RegistrySlice, message: Internal, ctx: Context): Step {
  const seen = identityIn(message);
  if (seen === undefined || slice.hub === undefined) return unchanged(slice);
  const belongs = belonging(seen.identity, slice.hub.identity);
  if (belongs === "ours") return unchanged(slice);
  const rows = devicesByChip(ctx.view, seen.identity.chipId, RESETTABLE);
  const why =
    belongs === "unpaired"
      ? "its board showed on USB with no pairing"
      : "its board showed on USB paired to another hub";
  return retireAll(slice, rows, ctx, why);
}

function added(
  slice: RegistrySlice,
  message: Extract<Internal, { readonly kind: "deviceAdded" }>,
  ctx: Context,
): Step {
  const identity = provisionedIdentity(ctx.view, message.device);
  if (identity === undefined) {
    return err(
      coreFault(ctx.event, ORIGIN, "deviceAdded without a board being provisioned", {
        device: message.device,
      }),
    );
  }
  const row: DeviceRow = {
    id: message.device,
    address: message.address,
    role: message.role,
    name: message.name,
    chipId: identity.chipId,
    firmware: firmwareNumber(identity.firmwareVersion),
    development: identity.developmentBuild,
    state: DeviceState.Provisioning,
    addedMs: ctx.now.wall,
    removedMs: null,
  };
  return written(slice, ctx, "device_added", row, undefined, `${row.name} added, provisioning`);
}

function answered(
  slice: RegistrySlice,
  message: Extract<Internal, { readonly kind: "provisionAnswered" }>,
  accepted: boolean,
  ctx: Context,
): Step {
  const row = slice.devices.get(message.device);
  if (row?.state !== DeviceState.Provisioning) return unchanged(slice);
  if (accepted) {
    const paired: DeviceRow = { ...row, state: DeviceState.Paired };
    return written(slice, ctx, "device_state", paired, row, `${row.name} paired`);
  }
  return change(
    ctx,
    "device_not_added",
    row,
    undefined,
    `${row.name} not added: the board refused its Provision`,
  ).map((record) => ({
    slice: withoutRow(slice, row.id),
    out: [
      {
        kind: "write",
        durability: "now",
        op: { table: "devices", op: "delete", key: { id: row.id } },
      },
      ...deleteKey(row.id),
      { kind: "deviceRemoved", device: row.id },
      record,
    ],
  }));
}

function rename(
  slice: RegistrySlice,
  request: RequestId,
  device: DeviceId,
  name: string,
  ctx: Context,
): Step {
  const row = deviceById(ctx.view, device);
  if (row === undefined || !isNamed(row.state)) {
    return ok({ slice, out: [answerError(request, "unknownDevice", "no such device")] });
  }
  const problem = newNameProblem(ctx.view, name, row.id);
  if (problem === "taken") {
    return ok({
      slice,
      out: [answerError(request, "nameTaken", `another device is called ${name}`)],
    });
  }
  if (problem !== undefined) {
    return ok({ slice, out: [answerError(request, "badRequest", NAME_PROBLEM_TEXT[problem])] });
  }
  const answer = answerOk(request, { kind: "deviceRename", name });
  if (row.name === name) return ok({ slice, out: [answer] });
  const renamed: DeviceRow = { ...row, name };
  return written(slice, ctx, "device_renamed", renamed, row, `${row.name} renamed ${name}`, [
    answer,
  ]);
}

function remove(slice: RegistrySlice, request: RequestId, device: DeviceId, ctx: Context): Step {
  const row = deviceById(ctx.view, device);
  if (row === undefined || !isNamed(row.state)) {
    return ok({
      slice,
      out: [answerError(request, "unknownDevice", "no such device, or it is already removed")],
    });
  }
  return retire(slice, row, DeviceState.Removed, ctx, "removed by a command").map((done) => ({
    slice: done.slice,
    out: [...done.out, answerOk(request, { kind: "deviceRemove", name: row.name })],
  }));
}

/** The first authentic packet, a Started's firmware, a factory reset by the button. */
function heard(
  slice: RegistrySlice,
  message: Extract<Internal, { readonly kind: "accepted" }>,
  ctx: Context,
): Step {
  const row = slice.devices.get(message.device);
  if (row === undefined) return unchanged(slice);
  let next = AWAITING_CONTACT.has(row.state) ? { ...row, state: DeviceState.Contacted } : row;
  const packet = message.message;
  if (message.newest && packet.type === MessageType.Started) {
    next = { ...next, firmware: firmwareNumber(packet.firmwareVersion) };
  }
  const changed = next.state !== row.state || next.firmware !== row.firmware;
  const updated: Step = !changed
    ? unchanged(slice)
    : next.state !== row.state
      ? written(
          slice,
          ctx,
          "device_state",
          next,
          row,
          `${row.name} ${DEVICE_STATE_NAMES[next.state] ?? ""}`,
        )
      : ok({ slice: withRow(slice, next), out: [writeRow(next)] });
  const reset =
    message.newest &&
    packet.type === MessageType.Button &&
    packet.buttonAction === ButtonAction.FactoryResetGoingAhead &&
    isNamed(next.state);
  if (!reset) return updated;
  return updated.andThen((done) =>
    retire(
      done.slice,
      next,
      DeviceState.ResetByOwner,
      ctx,
      "its owner held the button to reset it",
    ).map((retired) => ({ slice: retired.slice, out: [...done.out, ...retired.out] })),
  );
}

/** A forced site move left this sensor behind: state 5, to be paired again (D115, section 8). */
function leftBehind(slice: RegistrySlice, device: DeviceId, ctx: Context): Step {
  const row = slice.devices.get(device);
  if (row === undefined || row.state === DeviceState.LeftBehind) return unchanged(slice);
  const behind: DeviceRow = { ...row, state: DeviceState.LeftBehind };
  return written(
    slice,
    ctx,
    "device_state",
    behind,
    row,
    `${row.name} left behind by a forced move`,
  );
}

function gatewayUp(slice: RegistrySlice, gateway: DeviceId, ctx: Context): Step {
  const row = slice.devices.get(gateway);
  if (row === undefined || !AWAITING_CONTACT.has(row.state)) return unchanged(slice);
  const contacted: DeviceRow = { ...row, state: DeviceState.Contacted };
  return written(slice, ctx, "device_state", contacted, row, `${row.name} contacted`);
}

export const handleRegistry: Handler<"registry"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "boot":
      return boot(slice, message.snapshot);
    case "setupFrame":
      return identitySeen(slice, message, ctx);
    case "deviceAdded":
      return added(slice, message, ctx);
    case "provisionAnswered":
      return answered(slice, message, message.result === ProvisionResultCode.Accepted, ctx);
    case "deviceRenameRequest":
      return rename(slice, message.request, message.device, message.name, ctx);
    case "deviceRemoveRequest":
      return remove(slice, message.request, message.device, ctx);
    case "accepted":
      return heard(slice, message, ctx);
    case "gatewayUp":
      return gatewayUp(slice, message.gateway, ctx);
    case "deviceLeftBehind":
      return leftBehind(slice, message.device, ctx);
    default:
      return unchanged(slice);
  }
};

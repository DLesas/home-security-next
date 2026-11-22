/**
 * Changing one device's update (docs/m3-updates-design.md section 4): every transition of
 * `device_updates` but `bytes` written now, each with its decision, and the device's `deviceUpdate`
 * event (`deviceUpdateEvent`, for `app` to send) at each transition and at most once every
 * `progressEventEveryMs` ‡ of progress. The entry keeps the body last sent, for the bound.
 */
import { Role } from "@hsn/protocol";
import type { DecisionKind } from "../model/decisions.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, Seq } from "../model/ids.ts";
import { DeviceUpdateState, type DeviceUpdateRow, UpdateHeld } from "../model/rows.ts";
import { monoAfterMs, msBetween } from "../model/time.ts";
import { holdName, IMAGE_HEADER_BYTES, methodName, reasonName, stateName } from "./codes.ts";
import { workingRole } from "./decide.ts";
import type { Steps } from "./out.ts";
import { firmwareDecision, writeUpdate } from "./records.ts";
import type { DeviceEntry, DeviceUpdateEvent, FirmwareSlice } from "./state.ts";

/** A row's fields that a transition may change; `bytes` alone is progress. */
export type RowChange = Partial<Omit<DeviceUpdateRow, "deviceId">>;

/** The image's file size (header and image) for the entry's rollout, or 0 when unknown. */
function fileBytesOf(slice: FirmwareSlice, row: DeviceUpdateRow): number {
  if (row.rolloutId === null) return 0;
  const rollout = slice.rollouts.get(row.rolloutId);
  const image = rollout === undefined ? undefined : slice.images.get(rollout.row.image);
  return image === undefined ? 0 : image.bytes + IMAGE_HEADER_BYTES;
}

/** The body `deviceUpdate` carries for this row. */
export function eventBody(slice: FirmwareSlice, row: DeviceUpdateRow): DeviceUpdateEvent {
  const rollout = row.rolloutId === null ? undefined : slice.rollouts.get(row.rolloutId);
  const reason = reasonName(row.lastReason);
  return {
    device: row.deviceId,
    image: rollout?.row.image ?? 0,
    state: stateName(row.state),
    held: holdName(row.held),
    method: methodName(row.method),
    bytes: row.bytes,
    of: fileBytesOf(slice, row),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Exposes the manual override once an open rollout stops automatically retrying a busy gateway. */
export function forceAvailability(
  slice: FirmwareSlice,
  ctx: Context,
  entry: DeviceEntry,
): Pick<DeviceUpdateEvent, "forceAvailable"> {
  const { row } = entry;
  if (
    row.held !== UpdateHeld.GatewayBusy ||
    entry.forced ||
    entry.busyHolds < ctx.deps.rules.firmware.gatewayBusyMaxHolds ||
    row.rolloutId === null ||
    slice.rollouts.get(row.rolloutId)?.row.endedMs !== null ||
    workingRole(ctx.view, row.deviceId) !== Role.Gateway
  )
    return {};
  return { forceAvailable: true };
}

/** Replaces the device's entry in the slice. */
export function putEntry(steps: Steps, entry: DeviceEntry): void {
  const updates = new Map(steps.slice.updates);
  updates.set(entry.row.deviceId, entry);
  steps.set({ ...steps.slice, updates });
}

/**
 * Sends the entry's `deviceUpdate` now (a `deviceUpdateEvent` for `app`), and returns the entry
 * with it as the body last sent. A row naming no rollout's image has no event to send.
 */
export function published(steps: Steps, ctx: Context, entry: DeviceEntry): DeviceEntry {
  const body = {
    ...eventBody(steps.slice, entry.row),
    ...forceAvailability(steps.slice, ctx, entry),
  };
  if (body.image > 0) steps.push({ kind: "deviceUpdateEvent", body });
  return { ...entry, event: body };
}

/** Publishes a change in force availability even when the update row did not move. */
export function publishForceAvailability(steps: Steps, ctx: Context, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined) return;
  if (entry.event?.forceAvailable === forceAvailability(steps.slice, ctx, entry).forceAvailable)
    return;
  putEntry(steps, { ...published(steps, ctx, entry), eventAt: ctx.now.mono });
}

/**
 * Changes the device's row. Anything but `bytes` is a transition: written now and published at
 * once. `bytes` alone is routine and published within the progress bound.
 */
export function change(steps: Steps, ctx: Context, device: DeviceId, fields: RowChange): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined) return;
  const row: DeviceUpdateRow = { ...entry.row, ...fields };
  const transition = (Object.keys(fields) as (keyof RowChange)[]).some(
    (key) => key !== "bytes" && !sameField(entry.row[key], row[key]),
  );
  if (!transition && row.bytes === entry.row.bytes) return;
  if (transition) {
    // A transition is published at once, and the progress bound counts from it.
    const next = {
      ...published(steps, ctx, {
        ...entry,
        row: { ...row, sinceMs: sinceOf(entry.row, row, ctx) },
      }),
      eventAt: ctx.now.mono,
    };
    putEntry(steps, next);
    steps.push(writeUpdate(next.row));
    return;
  }
  putEntry(steps, { ...entry, row });
  steps.push(writeUpdate(row, "routine"));
  progress(steps, ctx, device);
}

/** `since_ms` moves when the state moves. */
function sinceOf(before: DeviceUpdateRow, after: DeviceUpdateRow, ctx: Context): number {
  return before.state === after.state ? before.sinceMs : ctx.now.wall;
}

function sameField(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  return a === b;
}

/** Progress: published now if the last was `progressEventEveryMs` ago, else at the bound. */
export function progress(steps: Steps, ctx: Context, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined) return;
  const every = ctx.deps.rules.firmware.progressEventEveryMs;
  const key = { module: "firmware", kind: "progressEvent", device } as const;
  if (entry.eventAt === undefined || msBetween(entry.eventAt, ctx.now.mono) >= every) {
    putEntry(steps, { ...published(steps, ctx, entry), eventAt: ctx.now.mono });
    steps.clear(key);
    return;
  }
  if (!steps.has(key)) steps.timer(key, monoAfterMs(entry.eventAt, every));
}

/** The progress timer: publishes the bytes reached since the last event, if they moved. */
export function progressDue(steps: Steps, ctx: Context, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined || entry.event?.bytes === entry.row.bytes) return;
  putEntry(steps, { ...published(steps, ctx, entry), eventAt: ctx.now.mono });
}

/**
 * Sets the device's hold. A hold that begins or changes is recorded (`firmware_held`, its code);
 * one that ends is written and published only. The armed reminder starts and stops with the armed
 * hold (D91).
 */
export function setHeld(steps: Steps, ctx: Context, device: DeviceId, held: UpdateHeld): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined || entry.row.held === held) return;
  const wasArmed = entry.row.held === UpdateHeld.Armed;
  change(steps, ctx, device, { held });
  if (held !== UpdateHeld.No) {
    steps.pushResult(firmwareDecision(ctx, "firmware_held", { device, value: held }));
  }
  const key = { module: "firmware", kind: "armedReminder", device } as const;
  const after = steps.slice.updates.get(device);
  if (after === undefined) return;
  if (held === UpdateHeld.Armed && !wasArmed) {
    putEntry(steps, { ...after, armedSince: ctx.now.mono });
    steps.timer(key, monoAfterMs(ctx.now.mono, ctx.deps.rules.firmware.armedReminderAfterMs));
  } else if (held !== UpdateHeld.Armed && wasArmed) {
    putEntry(steps, { ...after, armedSince: undefined });
    steps.clear(key);
  }
}

/** A state transition with its decision (value as each kind gives it, records.ts). */
export function transition(
  steps: Steps,
  ctx: Context,
  device: DeviceId,
  state: DeviceUpdateState,
  fields: RowChange,
  record?: { readonly kind: DecisionKind; readonly value?: number; readonly cause?: Seq },
): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined) return;
  change(steps, ctx, device, { ...fields, state });
  if (record !== undefined) {
    steps.pushResult(
      firmwareDecision(ctx, record.kind, {
        device,
        ...(record.value === undefined ? {} : { value: record.value }),
        ...(record.cause === undefined ? {} : { cause: record.cause }),
      }),
    );
  }
}

/** Forgets what the device was last told, so it is offered again. */
export function forgetTold(steps: Steps, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry?.told === undefined) return;
  putEntry(steps, { ...entry, told: undefined });
}

/** True for states a rollout is still working on for the device. */
export function inProgress(state: DeviceUpdateState): boolean {
  return (
    state !== DeviceUpdateState.None &&
    state !== DeviceUpdateState.Confirmed &&
    state !== DeviceUpdateState.RolledBack &&
    state !== DeviceUpdateState.Refused &&
    state !== DeviceUpdateState.Cancelled
  );
}

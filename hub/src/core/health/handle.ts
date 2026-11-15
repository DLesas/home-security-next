/**
 * The health module's handler (m2-design.md section 2, module 17; section 7, "Device health";
 * D9, D89, D109, HB10, HB33).
 *
 * - Battery: every packet with the highest counter accepted from a sensor or a siren gives its
 *   cell voltage (HD 8: readings follow the newest packet only). Low battery is raised at 10% or
 *   below and cleared above 15% (HB33), each change a decision (`battery_low`, `battery_ok`,
 *   value: the percentage) and its `health_state` row, both written now, so a warning raised once
 *   is not raised again after a restart. A siren on mains counts only on its cell (D109).
 * - Tamper: a cover changed report (an event packet, HD 5) that is the newest packet and shows
 *   the cover open while the hub knows it closed raises `tamper_opened`; closed while open,
 *   `tamper_closed`; both written now with the row. A late one (not the newest) never changes the
 *   state, but an opening it reports after the sensor's last `tamper_opened` is told: a
 *   `tamper_opened` marked late, value the opening's wall time in whole seconds (as D106 does for
 *   doors); an opening on time has no value.
 * - A heartbeat that shows a cover other than the one the hub knows is `cover_state_unexpected`
 *   (D114), value 1 shown open, 0 shown closed, once per change of what the heartbeats show; a
 *   warning, so written now (audit caps it), and the state unchanged.
 * - A pairing or factory-reset hold while armed, reported by the sensor's button report, is
 *   `long_press_ignored` (HB10, D89), value: the button action, written now.
 * - Silence: a `sensor_silent` or `siren_silent` decision marks the device silent until a packet
 *   is accepted from it, for the device screens.
 * - A poor link (D107): judged from the sensors module's daily loss counts, read through its
 *   view, at the start, whenever a packet is accepted from the sensor, and on its `poor_link`.
 * - Gateways report no cell voltage: no battery percentage, state or notice in M2 (section 7).
 * - A removed device's row is deleted.
 */
import { err, ok, type Result } from "neverthrow";
import { ButtonAction, batteryMillivolts, MessageType, Role } from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { HealthStateRow } from "../model/rows.ts";
import { MILLISECONDS_PER_SECOND, msBetween } from "../model/time.ts";
import { type DecisionFields, decision } from "../util/records.ts";
import { sensorEntry } from "../sensors/view.ts";
import { batteryPercent, lowAfter } from "./battery.ts";
import { dayOf, isPoorLink } from "./link.ts";
import { readingOf, type Reading } from "./readings.ts";
import { type DeviceHealth, type HealthSlice, NO_HEALTH } from "./state.ts";

type Out = Internal | Effect;
type Step = Result<Handled<"health">, CoreFault>;
type Accepted = Extract<Internal, { readonly kind: "accepted" }>;

/** Button actions the sensor reports for a hold it ignored or refused while armed (§6, D89). */
const HOLDS_WHILE_ARMED: ReadonlySet<number> = new Set([
  ButtonAction.PairingHoldIgnoredWhileArmed,
  ButtonAction.FactoryResetHoldWhileArmed,
]);

function unchanged(slice: HealthSlice): Step {
  return ok({ slice, out: [] });
}

function healthOf(slice: HealthSlice, device: DeviceId): DeviceHealth {
  return slice.devices.get(device) ?? NO_HEALTH;
}

function withDevice(slice: HealthSlice, device: DeviceId, health: DeviceHealth): HealthSlice {
  return { ...slice, devices: new Map(slice.devices).set(device, health) };
}

function stateRow(device: DeviceId, health: DeviceHealth): HealthStateRow {
  return { deviceId: device, batteryLow: health.batteryLow, tamperOpen: health.tamperOpen };
}

/** The `health_state` row, written now (section 3). */
function rowWrite(device: DeviceId, health: DeviceHealth): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "health_state", op: "upsert", row: stateRow(device, health) },
  };
}

/** A decision of this module, written now: each goes with a `health_state` change or an event report. */
function decided(ctx: Context, fields: DecisionFields): Result<Internal, CoreFault> {
  return decision(ctx, "now", fields).map((d) => d.message);
}

// ——— Start ———

/** The slice at start: `health_state` as committed, each device's cell from its stored reading. */
function restored(snapshot: DurableSnapshot): HealthSlice {
  const devices = new Map<DeviceId, DeviceHealth>();
  const roles = new Map(snapshot.devices.map((row) => [row.id, row.role]));
  for (const state of snapshot.deviceState) {
    const role = roles.get(state.deviceId);
    if (role === undefined || state.reading === null) continue;
    const reading = readingOf(role, state.reading);
    if (reading === undefined) continue;
    devices.set(state.deviceId, { ...NO_HEALTH, cell: reading.cell });
  }
  for (const row of snapshot.m2.healthState) {
    const health = devices.get(row.deviceId) ?? NO_HEALTH;
    devices.set(row.deviceId, {
      ...health,
      batteryLow: row.batteryLow,
      tamperOpen: row.tamperOpen,
    });
  }
  return { timers: [], devices };
}

// ——— Packets ———

/** Low battery after this reading (HB33): a cell on mains neither raises nor clears it (D109). */
function batteryChange(
  ctx: Context,
  accepted: Accepted,
  health: DeviceHealth,
  cell: Reading["cell"],
): Result<{ readonly health: DeviceHealth; readonly out: readonly Out[] }, CoreFault> {
  const next: DeviceHealth = { ...health, cell };
  if (cell === undefined || cell.onMains) return ok({ health: next, out: [] });
  const low = lowAfter(ctx.deps.rules, health.batteryLow, cell.millivolts);
  if (low === health.batteryLow) return ok({ health: next, out: [] });
  const changed: DeviceHealth = { ...next, batteryLow: low };
  return decided(ctx, {
    kind: low ? "battery_low" : "battery_ok",
    device: accepted.device,
    cause: accepted.record,
    value: batteryPercent(ctx.deps.rules, cell.millivolts) ?? null,
  }).map((message) => ({ health: changed, out: [message, rowWrite(accepted.device, changed)] }));
}

/** A cover changed report (D9): the cover state it shows, against the one the hub knows. */
function tamperChange(
  ctx: Context,
  accepted: Accepted,
  health: DeviceHealth,
  coverOpen: boolean,
): Result<{ readonly health: DeviceHealth; readonly out: readonly Out[] }, CoreFault> {
  if (coverOpen === health.tamperOpen) return ok({ health, out: [] });
  const changed: DeviceHealth = {
    ...health,
    tamperOpen: coverOpen,
    openedAtMs: coverOpen ? openingMs(ctx, accepted) : health.openedAtMs,
  };
  return decided(ctx, {
    kind: coverOpen ? "tamper_opened" : "tamper_closed",
    device: accepted.device,
    cause: accepted.record,
  }).map((message) => ({ health: changed, out: [message, rowWrite(accepted.device, changed)] }));
}

/** When the reported event happened, wall milliseconds: the packet's end less its age (§6). */
function openingMs(ctx: Context, accepted: Accepted): number {
  const { arrival, message } = accepted;
  const endedMs =
    arrival.path === "lora"
      ? ctx.now.wall - msBetween(arrival.endedAt, ctx.now.mono)
      : ctx.now.wall;
  const ageS = "eventAgeSeconds" in message ? message.eventAgeSeconds : 0;
  return endedMs - ageS * MILLISECONDS_PER_SECOND;
}

/** A late cover changed report (not the newest packet): its opening is told, the state stays. */
function lateCover(
  slice: HealthSlice,
  ctx: Context,
  accepted: Accepted,
  heard: DeviceHealth,
): Step {
  const reading = packetReading(accepted);
  if (reading?.coverChanged !== true) {
    return ok({ slice: withDevice(slice, accepted.device, heard), out: [] });
  }
  const opened = openingMs(ctx, accepted);
  if (heard.openedAtMs !== undefined && opened <= heard.openedAtMs) {
    return ok({ slice: withDevice(slice, accepted.device, heard), out: [] });
  }
  return decided(ctx, {
    kind: "tamper_opened",
    device: accepted.device,
    cause: accepted.record,
    value: Math.floor(opened / MILLISECONDS_PER_SECOND),
  }).map((message) => ({
    slice: withDevice(slice, accepted.device, { ...heard, openedAtMs: opened }),
    out: [message],
  }));
}

/** A heartbeat's cover against the one the hub knows (D114): warned once per change shown. */
function coverCheck(
  ctx: Context,
  accepted: Accepted,
  health: DeviceHealth,
  shown: boolean,
): Result<{ readonly health: DeviceHealth; readonly out: readonly Out[] }, CoreFault> {
  if (shown === health.tamperOpen)
    return ok({ health: { ...health, coverShown: undefined }, out: [] });
  if (health.coverShown === shown) return ok({ health, out: [] });
  return decided(ctx, {
    kind: "cover_state_unexpected",
    device: accepted.device,
    cause: accepted.record,
    value: shown ? 1 : 0,
  }).map((message) => ({ health: { ...health, coverShown: shown }, out: [message] }));
}

/** A sensor's poor link judged now from the sensors module's counts (D107). */
function judgedLink(ctx: Context, device: DeviceId): boolean {
  const entry = sensorEntry(ctx.view, device);
  return entry !== undefined && isPoorLink(ctx.deps.rules, entry.loss, dayOf(ctx.now.wall));
}

function onAccepted(start: HealthSlice, ctx: Context, accepted: Accepted): Step {
  const before = start.devices.get(accepted.device);
  const poor = accepted.role === Role.Sensor && judgedLink(ctx, accepted.device);
  const slice =
    (before?.poorLink ?? false) === poor
      ? start
      : withDevice(start, accepted.device, { ...(before ?? NO_HEALTH), poorLink: poor });
  const known = slice.devices.get(accepted.device);
  const heard: DeviceHealth = { ...(known ?? NO_HEALTH), silent: false };
  if (!accepted.newest) {
    if (known === undefined && packetReading(accepted)?.coverChanged !== true)
      return unchanged(slice);
    return lateCover(slice, ctx, accepted, heard);
  }
  const reading = packetReading(accepted);
  if (reading === undefined) {
    return known?.silent !== true
      ? unchanged(slice)
      : ok({ slice: withDevice(slice, accepted.device, heard), out: [] });
  }
  const out: Out[] = [];
  const battery = batteryChange(ctx, accepted, heard, reading.cell);
  if (battery.isErr()) return err(battery.error);
  out.push(...battery.value.out);
  let health = battery.value.health;
  if (reading.coverChanged !== undefined) {
    const tamper = tamperChange(ctx, accepted, health, reading.coverChanged);
    if (tamper.isErr()) return err(tamper.error);
    out.push(...tamper.value.out);
    health = { ...tamper.value.health, coverShown: undefined };
  }
  if (reading.heartbeatCover !== undefined) {
    const check = coverCheck(ctx, accepted, health, reading.heartbeatCover);
    if (check.isErr()) return err(check.error);
    out.push(...check.value.out);
    health = check.value.health;
  }
  if (reading.button !== undefined && HOLDS_WHILE_ARMED.has(reading.button)) {
    const hold = decided(ctx, {
      kind: "long_press_ignored",
      device: accepted.device,
      cause: accepted.record,
      value: reading.button,
    });
    if (hold.isErr()) return err(hold.error);
    out.push(hold.value);
  }
  return ok({ slice: withDevice(slice, accepted.device, health), out });
}

/** What a packet from a sensor or siren tells this module, by its role and type. */
function packetReading(accepted: Accepted): Reading | undefined {
  const { message } = accepted;
  if (accepted.role === Role.Sensor) {
    switch (message.type) {
      case MessageType.Heartbeat:
        return {
          cell: { millivolts: batteryMillivolts(message.batteryCode), onMains: false },
          coverChanged: undefined,
          heartbeatCover: message.flags.coverOpen,
          button: undefined,
        };
      case MessageType.DoorChanged:
        return {
          cell: { millivolts: batteryMillivolts(message.batteryCode), onMains: false },
          coverChanged: undefined,
          heartbeatCover: undefined,
          button: undefined,
        };
      case MessageType.CoverChanged:
        return {
          cell: { millivolts: batteryMillivolts(message.batteryCode), onMains: false },
          coverChanged: message.flags.coverOpen,
          heartbeatCover: undefined,
          button: undefined,
        };
      case MessageType.Button:
        return {
          cell: { millivolts: batteryMillivolts(message.batteryCode), onMains: false },
          coverChanged: undefined,
          heartbeatCover: undefined,
          button: message.buttonAction,
        };
      default:
        return undefined;
    }
  }
  if (accepted.role === Role.Siren && message.type === MessageType.SirenReport) {
    return {
      cell: message.flags.cellFitted
        ? { millivolts: batteryMillivolts(message.cellBatteryCode), onMains: message.flags.onMains }
        : undefined,
      coverChanged: undefined,
      heartbeatCover: undefined,
      button: undefined,
    };
  }
  return undefined;
}

// ——— The handler ———

const SILENCE_DECISIONS: ReadonlySet<string> = new Set([
  "sensor_silent",
  "siren_silent",
  "poor_link",
]);

export const handleHealth: Handler<"health"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "boot": {
      // `sensors` (module 14) has restored its counts before this module (17) sees the boot.
      const start = restored(message.snapshot);
      const devices = new Map(start.devices);
      for (const row of message.snapshot.devices) {
        if (row.role !== Role.Sensor || !judgedLink(ctx, row.id)) continue;
        devices.set(row.id, { ...(devices.get(row.id) ?? NO_HEALTH), poorLink: true });
      }
      return ok({ slice: { ...start, devices }, out: [] });
    }
    case "accepted":
      return onAccepted(slice, ctx, message);
    case "auditRecord": {
      const { record } = message;
      if (record.kind !== "decision" || !SILENCE_DECISIONS.has(record.row.kind)) {
        return unchanged(slice);
      }
      const device = record.row.deviceId;
      if (device === null) return unchanged(slice);
      const health = healthOf(slice, device);
      return ok({
        slice: withDevice(
          slice,
          device,
          record.row.kind === "poor_link"
            ? { ...health, poorLink: true }
            : { ...health, silent: true },
        ),
        out: [],
      });
    }
    case "deviceRemoved": {
      if (!slice.devices.has(message.device)) return unchanged(slice);
      const devices = new Map(slice.devices);
      devices.delete(message.device);
      return ok({
        slice: { ...slice, devices },
        out: [
          {
            kind: "write",
            durability: "now",
            op: { table: "health_state", op: "delete", key: { deviceId: message.device } },
          },
        ],
      });
    }
    case "opRequest":
      // `OP_OWNERS` gives this module no operation; nothing to answer.
      return unchanged(slice);
    default:
      return unchanged(slice);
  }
};

/**
 * The slots module's handler (hub-design.md section 2, module 11; section 8, "Heartbeat slots"
 * and "Clock correction"). It keeps a slot for every sensor the sensors module holds: a new
 * one takes the phase with the largest clearance, and when the smallest clearance falls below
 * 2w ‡ every phase is planned again; at a site move's switch the plan is made again for the new
 * rate. Each phase change is written now with the sensor's `device_state` row (section 5). From
 * each accepted heartbeat it updates the clock samples: two slotted heartbeats of the newest
 * counter, heard by one gateway, of one settings version, with no Started between.
 */
import { ok, type Result } from "neverthrow";
import { MessageType, type MessageOf } from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { Arrival, Internal } from "../model/messages.ts";
import type { SensorConfigRow } from "../model/rows.ts";
import { MICROS_PER_MILLISECOND } from "../model/time.ts";
import { deviceStateRow } from "../intake/view.ts";
import {
  airtimeMs,
  allSensors,
  effectiveIntervalMs,
  heldCorrection,
  isSlotted,
  orFault,
  REPLY_PACKET_BYTES,
  SENSOR_STATUS_PACKET_BYTES,
  sensorConfig,
} from "../sensors/view.ts";
import { driftOf, intervalsIn, keepsSample, median, withSample } from "./correction.ts";
import { decodeEstimates, encodeEstimates } from "./estimates.ts";
import {
  modulo,
  placeSlot,
  planAll,
  type Slot,
  smallestClearance,
  spanUs,
  type Unplaced,
} from "./plan.ts";
import type { SlotEntry, SlotsSlice } from "./state.ts";

type Out = Internal | Effect;
type Step = Result<Handled<"slots">, CoreFault>;

/** The gateway's microsecond clock is 32 bits on the wire (§6). */
const GATEWAY_CLOCK_WRAP = 2 ** 32;

/** A sensor's interval and span as its settings make them (section 8). */
function shapeOf(
  ctx: Context,
  device: DeviceId,
  config: SensorConfigRow,
): Result<Unplaced, CoreFault> {
  const { rules } = ctx.deps;
  return orFault(ctx, airtimeMs(config.sendRate, SENSOR_STATUS_PACKET_BYTES)).andThen((heartbeat) =>
    orFault(ctx, airtimeMs(config.replyRate, REPLY_PACKET_BYTES)).map((reply) => ({
      device,
      order: device,
      intervalUs:
        effectiveIntervalMs(config.heartbeatUnits, config.sendRate) * MICROS_PER_MILLISECOND,
      spanUs: spanUs(heartbeat, rules.replies.heartbeatReplyMomentMs, reply, rules.slots.guardMs),
    })),
  );
}

function horizonUs(ctx: Context): number {
  return ctx.deps.rules.slots.clearanceHorizonMs * MICROS_PER_MILLISECOND;
}

function newEntry(slot: Slot): SlotEntry {
  return {
    slot,
    anchored: true,
    last: undefined,
    samples: [],
    heldUnits: undefined,
    changedAt: undefined,
  };
}

/** The `device_state` row of each sensor whose phase changed, written now (section 5). */
function phaseWrites(
  ctx: Context,
  slice: SlotsSlice,
  devices: readonly DeviceId[],
): readonly Out[] {
  const view = { ...ctx.view, slots: slice };
  return devices.flatMap((device): Out[] => {
    const entry = slice.entries.get(device);
    const row =
      entry === undefined
        ? undefined
        : deviceStateRow(view, device, encodeEstimates(entry.slot, entry.samples));
    return row === undefined
      ? []
      : [{ kind: "write", durability: "now", op: { table: "device_state", op: "upsert", row } }];
  });
}

/**
 * Brings the plan in line with the sensors module: a new sensor, or one whose interval or span
 * changed, is placed at the largest clearance; a removed one leaves its gap; if a placement left
 * the smallest clearance below 2w ‡, or `replan` asks, every phase is planned again.
 */
function sync(slice: SlotsSlice, ctx: Context, replan: boolean): Step {
  const horizon = horizonUs(ctx);
  const shapes: Unplaced[] = [];
  for (const sensor of allSensors(ctx.view)) {
    const shape = shapeOf(ctx, sensor.device, sensor.config);
    if (shape.isErr()) return shape.map(() => ({ slice, out: [] }));
    shapes.push(shape.value);
  }
  const wanted = new Set(shapes.map((shape) => shape.device));
  let entries = new Map([...slice.entries].filter(([device]) => wanted.has(device)));
  const changed: DeviceId[] = [];
  let placed = false;
  for (const shape of shapes) {
    const device = shape.device as DeviceId;
    const entry = entries.get(device);
    if (entry?.slot.intervalUs === shape.intervalUs && entry.slot.spanUs === shape.spanUs) {
      continue;
    }
    const others = [...entries.values()].filter((e) => e.slot.device !== device).map((e) => e.slot);
    const { slot } = placeSlot(others, shape, horizon);
    entries.set(device, entry === undefined ? newEntry(slot) : { ...entry, slot, anchored: true });
    changed.push(device);
    placed = true;
  }
  const slots = [...entries.values()].map((entry) => entry.slot);
  const widest = Math.max(0, ...slots.map((slot) => slot.spanUs));
  const crowded =
    placed && smallestClearance(slots, horizon) < ctx.deps.rules.slots.replanBelowSpans * widest;
  if (replan || crowded) {
    entries = new Map(entries);
    for (const slot of planAll(slots, horizon)) {
      const device = slot.device as DeviceId;
      const entry = entries.get(device);
      if (entry === undefined || entry.slot.phaseUs === slot.phaseUs) continue;
      entries.set(device, { ...entry, slot, anchored: true });
      if (!changed.includes(device)) changed.push(device);
    }
  }
  // The correction each sensor's current version holds, and when it last changed (6 hours ‡).
  for (const [device, entry] of entries) {
    const held = sensorConfig(ctx.view, device)?.correctionUnits;
    if (held !== entry.heldUnits) {
      entries.set(device, {
        ...entry,
        heldUnits: held,
        changedAt: entry.heldUnits === undefined ? undefined : ctx.now.mono,
      });
    }
  }
  const next = { ...slice, entries };
  return ok({ slice: next, out: phaseWrites(ctx, next, changed) });
}

/** The slots the snapshot kept (section 6, `device_state.estimates`), not yet anchored. */
function fromSnapshot(snapshot: DurableSnapshot): SlotsSlice["entries"] {
  const sensors = new Set(snapshot.sensorConfig.map((row) => row.deviceId));
  const entries = snapshot.deviceState.flatMap((row): [DeviceId, SlotEntry][] => {
    const estimates = decodeEstimates(row.estimates);
    if (!sensors.has(row.deviceId) || estimates === undefined) return [];
    const slot: Slot = {
      device: row.deviceId,
      order: row.deviceId,
      intervalUs: estimates.intervalUs,
      spanUs: estimates.spanUs,
      phaseUs: estimates.phaseUs,
    };
    return [[row.deviceId, { ...newEntry(slot), anchored: false, samples: estimates.samples }]];
  });
  return new Map(entries);
}

/** The gap between two heartbeats on the gateway's clock, unwrapped against the hub's. */
function gatewayGapUs(hubGapUs: number, earlierMicros: number, laterMicros: number): number {
  const wrapped = modulo(laterMicros - earlierMicros, GATEWAY_CLOCK_WRAP);
  const turns = Math.round((hubGapUs - wrapped) / GATEWAY_CLOCK_WRAP);
  return wrapped + turns * GATEWAY_CLOCK_WRAP;
}

/**
 * One accepted heartbeat: anchors the slot on this boot's clock if it is not yet, and makes a
 * clock sample with the previous slotted heartbeat when the two qualify (section 8).
 */
function onHeartbeat(
  entry: SlotEntry,
  device: DeviceId,
  counter: number,
  message: MessageOf<typeof MessageType.Heartbeat>,
  arrival: Extract<Arrival, { path: "lora" }>,
  ctx: Context,
): { readonly entry: SlotEntry; readonly anchoredNow: boolean } {
  const slotted = isSlotted(ctx.view, device, counter) && !message.flags.listeningAtSendRate;
  const anchoring = !entry.anchored && !message.flags.listeningAtSendRate;
  const slot = anchoring
    ? { ...entry.slot, phaseUs: modulo(arrival.endedAt, entry.slot.intervalUs) }
    : entry.slot;
  const mark = {
    gateway: arrival.gateway,
    gatewayMicros: arrival.gatewayMicros,
    endedAt: arrival.endedAt,
    version: message.settingsVersion,
  };
  let samples = entry.samples;
  const held = heldCorrection(ctx.view, device, message.settingsVersion);
  const last = entry.last;
  if (
    slotted &&
    last !== undefined &&
    held !== undefined &&
    last.gateway === mark.gateway &&
    last.version === mark.version
  ) {
    const hubGap = arrival.endedAt - last.endedAt;
    const gap = gatewayGapUs(hubGap, last.gatewayMicros, mark.gatewayMicros);
    const m = intervalsIn(gap, slot.intervalUs);
    if (gap > 0 && keepsSample(ctx.deps.rules, m, slot.intervalUs, held, gap, median(samples))) {
      samples = withSample(ctx.deps.rules, samples, driftOf(m, slot.intervalUs, held, gap));
    }
  }
  return {
    entry: {
      ...entry,
      slot,
      anchored: entry.anchored || anchoring,
      samples,
      last: slotted ? mark : undefined,
    },
    anchoredNow: anchoring,
  };
}

function onAccepted(
  slice: SlotsSlice,
  message: Extract<Internal, { kind: "accepted" }>,
  ctx: Context,
): Step {
  const entry = slice.entries.get(message.device);
  if (entry === undefined || !message.newest) return sync(slice, ctx, false);
  const packet = message.message;
  if (packet.type === MessageType.Started) {
    // A restarted sensor has lost its rhythm: no sample spans a Started (section 8).
    const next = {
      ...slice,
      entries: new Map(slice.entries).set(message.device, { ...entry, last: undefined }),
    };
    return sync(next, ctx, false);
  }
  if (packet.type !== MessageType.Heartbeat || message.arrival.path !== "lora")
    return sync(slice, ctx, false);
  const done = onHeartbeat(entry, message.device, message.counter, packet, message.arrival, ctx);
  const next = { ...slice, entries: new Map(slice.entries).set(message.device, done.entry) };
  return sync(next, ctx, false).map((synced) => ({
    slice: synced.slice,
    out: [
      ...synced.out,
      ...(done.anchoredNow ? phaseWrites(ctx, synced.slice, [message.device]) : []),
    ],
  }));
}

/** The slots module's handler. */
export const handleSlots: Handler<"slots"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "boot":
      return sync(
        { ...slice, boot: message.boot.id, entries: fromSnapshot(message.snapshot) },
        ctx,
        false,
      );
    case "deviceAdded":
    case "deviceRemoved":
    case "sensorSettingsRequest":
      return sync(slice, ctx, false);
    case "siteMove":
      // At the switch the plan is made again for the new rate (section 8, "Heartbeat slots").
      return sync(slice, ctx, message.stage === "switched");
    case "accepted":
      return onAccepted(slice, message, ctx);
    default:
      return ok({ slice, out: [] });
  }
};

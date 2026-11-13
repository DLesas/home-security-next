/**
 * Read-only selectors over the slots module's slice that other modules may use (hub-design.md
 * section 2): the next-heartbeat value a reply carries, the clock correction slots wants sent,
 * and a sensor's estimates for its `device_state` row. Sensors builds a reply before slots sees
 * the packet, so these give the values from before it (section 2, the note under the table).
 */
import { ok, type Result } from "neverthrow";
import type { HubError } from "../model/errors.ts";
import type { DeviceId } from "../model/ids.ts";
import type { HubRules } from "../model/rules.ts";
import type { HubState } from "../model/state.ts";
import { type Mono, MICROS_PER_MILLISECOND, msBetween } from "../model/time.ts";
import { safeTenthsFromMilliseconds } from "../util/protocol-safe.ts";
import { correctionToSend, median, PPM, PPM_PER_UNIT } from "./correction.ts";
import { encodeEstimates } from "./estimates.ts";
import { nextOccurrenceAfterUs, type Slot } from "./plan.ts";
import type { SlotEntry } from "./state.ts";

/** What slots keeps of a sensor, or undefined for none. */
export function slotEntry(view: HubState, device: DeviceId): SlotEntry | undefined {
  return view.slots.entries.get(device);
}

/** A sensor's slot as planned, or undefined. */
export function slotOf(view: HubState, device: DeviceId): Slot | undefined {
  return view.slots.entries.get(device)?.slot;
}

/** A sensor's `device_state.estimates` (section 6), or undefined for a device slots does not plan. */
export function slotEstimates(view: HubState, device: DeviceId): Uint8Array | undefined {
  const entry = view.slots.entries.get(device);
  return entry === undefined ? undefined : encodeEstimates(entry.slot, entry.samples);
}

/**
 * The reply's next heartbeat, in tenths of a second after the answered packet's end (section 8,
 * "Telling the sensor"; §6): the first occurrence of the sensor's slot at least `aheadMs` after
 * `endedAt`; 0, "keep the schedule", when the sensor has no slot on this boot's clock yet.
 */
export function nextHeartbeatTenths(
  view: HubState,
  device: DeviceId,
  endedAt: Mono,
  aheadMs: number,
): Result<number, HubError> {
  const entry = view.slots.entries.get(device);
  if (entry?.anchored !== true) return ok(0);
  const afterUs = nextOccurrenceAfterUs(entry.slot, endedAt, aheadMs * MICROS_PER_MILLISECOND);
  return safeTenthsFromMilliseconds(afterUs / MICROS_PER_MILLISECOND);
}

/**
 * The correction slots wants the sensor to hold, units of 10 ppm, when it differs from what its
 * current version holds by enough (section 8, "Change"); undefined otherwise.
 */
export function correctionProposal(
  view: HubState,
  device: DeviceId,
  now: Mono,
  rules: HubRules,
): Result<number | undefined, HubError> {
  const entry = view.slots.entries.get(device);
  if (entry?.heldUnits === undefined) return ok(undefined);
  const allowed =
    entry.changedAt === undefined ||
    msBetween(entry.changedAt, now) >= rules.clockCorrection.minIntervalMs;
  return correctionToSend(rules, entry.samples, entry.heldUnits, allowed);
}

/**
 * How long a sensor holding a correction of `heldUnits` really waits for what it counts as
 * `nominalMs` on its own clock: nominal × (1 + c) ÷ (1 + d̂), with d̂ slots' estimate of how fast
 * its clock runs; the nominal time while there is no estimate.
 *
 * SPEC-QUESTION: section 8 times a heartbeat reply "1 s † after its end on the delivering
 * gateway's clock", but the sensor sleeps 1 s on its own clock: one more than 2 % slow opens its
 * window (20 ms † early, §8) after that moment and never hears a heartbeat reply, so it is never
 * corrected by one. The reading taken: the hub sends at the moment the sensor listens, which is
 * 1 s exactly once the correction holds (c = d̂) and before any estimate.
 */
export function sensorWaitMs(
  view: HubState,
  device: DeviceId,
  heldUnits: number,
  nominalMs: number,
): number {
  const entry = view.slots.entries.get(device);
  const estimate = entry === undefined ? undefined : median(entry.samples);
  if (estimate === undefined) return nominalMs;
  return (nominalMs * (1 + (heldUnits * PPM_PER_UNIT) / PPM)) / (1 + estimate);
}

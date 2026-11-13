/**
 * Heartbeat slots (hub-design.md section 8, "Heartbeat slots"; protocol.md §7; D108): each
 * sensor's phase φ in its effective interval I, the span w its slot occupies, where a new sensor
 * goes, when every phase is planned again, and the next heartbeat a reply names. Pure; times in
 * microseconds on the hub's monotonic clock.
 */
import { MICROS_PER_MILLISECOND } from "../model/time.ts";

/** One sensor's slot. */
export interface Slot {
  readonly device: number;
  /** Planned in order of pairing: the device id, which grows as devices are added. */
  readonly order: number;
  readonly intervalUs: number;
  readonly spanUs: number;
  /** φ, from 0 to I. */
  readonly phaseUs: number;
}

/** What a slot is placed from, before it has a phase. */
export type Unplaced = Omit<Slot, "phaseUs">;

/** `a` modulo `m`, from 0 to m. */
export function modulo(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/**
 * The span w of a slot (section 8): the heartbeat's airtime, the reply moment (1 s †), the
 * reply's airtime and the guard (2 s ‡). It covers the link-check reply, so reply moments stay
 * clear of other heartbeats.
 */
export function spanUs(
  heartbeatAirtimeMs: number,
  replyMomentMs: number,
  replyAirtimeMs: number,
  guardMs: number,
): number {
  return Math.ceil(
    (heartbeatAirtimeMs + replyMomentMs + replyAirtimeMs + guardMs) * MICROS_PER_MILLISECOND,
  );
}

/** A span on a circle of one interval: [start, start + length), start from 0 to the interval. */
interface Arc {
  readonly start: number;
  readonly length: number;
}

/** Every span of `others` over the horizon, projected onto a circle of `intervalUs`. */
function projected(others: readonly Slot[], intervalUs: number, horizonUs: number): readonly Arc[] {
  const arcs: Arc[] = [];
  for (const other of others) {
    for (let start = other.phaseUs; start < other.phaseUs + horizonUs; start += other.intervalUs) {
      arcs.push({ start: modulo(start, intervalUs), length: other.spanUs });
    }
  }
  return arcs.toSorted((a, b) => a.start - b.start);
}

/** The free stretches between projected arcs, merged, around the circle: [from, from + length). */
function gaps(arcs: readonly Arc[], intervalUs: number): readonly Arc[] {
  const first = arcs[0];
  if (first === undefined) return [{ start: 0, length: intervalUs }];
  const free: Arc[] = [];
  let end = first.start + first.length;
  for (const arc of arcs.slice(1)) {
    if (arc.start > end) free.push({ start: end, length: arc.start - end });
    end = Math.max(end, arc.start + arc.length);
  }
  // Around the circle, back to the first arc's start.
  const wrapGap = first.start + intervalUs - end;
  if (wrapGap > 0) free.push({ start: modulo(end, intervalUs), length: wrapGap });
  return free;
}

/**
 * The phase with the largest clearance to every other span over the horizon (section 8: an
 * hour): the middle of the widest free stretch. The clearance is the free time left on each side
 * of the new span; negative when even the widest stretch is shorter than the span.
 */
export function placeSlot(
  others: readonly Slot[],
  slot: Unplaced,
  horizonUs: number,
): { readonly slot: Slot; readonly clearanceUs: number } {
  if (others.length === 0) {
    return { slot: { ...slot, phaseUs: 0 }, clearanceUs: Number.POSITIVE_INFINITY };
  }
  const free = gaps(projected(others, slot.intervalUs, horizonUs), slot.intervalUs);
  const widest = free.reduce(
    (best, gap) => (gap.length > best.length ? gap : best),
    free[0] ?? { start: 0, length: 0 },
  );
  const clearanceUs = (widest.length - slot.spanUs) / 2;
  const phaseUs = modulo(Math.round(widest.start + Math.max(0, clearanceUs)), slot.intervalUs);
  return { slot: { ...slot, phaseUs }, clearanceUs };
}

/** Overlapping spans have no free time between them: less than any clearance two spans can have. */
const OVERLAPPING = -1;

/**
 * The smallest free time between `slot`'s span and any other's over the horizon, edge to edge
 * around the circle of its interval; `OVERLAPPING` when two spans overlap.
 */
export function clearanceOf(slot: Slot, others: readonly Slot[], horizonUs: number): number {
  let smallest = Number.POSITIVE_INFINITY;
  const circle = slot.intervalUs;
  for (const arc of projected(others, circle, horizonUs)) {
    const overlaps =
      modulo(arc.start - slot.phaseUs, circle) < slot.spanUs ||
      modulo(slot.phaseUs - arc.start, circle) < arc.length;
    if (overlaps) return OVERLAPPING;
    const after = modulo(arc.start - (slot.phaseUs + slot.spanUs), circle);
    const before = modulo(slot.phaseUs - (arc.start + arc.length), circle);
    smallest = Math.min(smallest, after, before);
  }
  return smallest;
}

/** The smallest clearance of the whole plan. */
export function smallestClearance(slots: readonly Slot[], horizonUs: number): number {
  return slots.reduce(
    (smallest, slot) =>
      Math.min(
        smallest,
        clearanceOf(
          slot,
          slots.filter((other) => other.device !== slot.device),
          horizonUs,
        ),
      ),
    Number.POSITIVE_INFINITY,
  );
}

/**
 * Every phase planned again (section 8): evenly in order of pairing when all share one interval,
 * the usual case with one sending rate; otherwise each in turn, in order of pairing, at the
 * largest clearance from those already placed.
 */
export function planAll(slots: readonly Unplaced[], horizonUs: number): readonly Slot[] {
  const ordered = slots.toSorted((a, b) => a.order - b.order);
  const first = ordered[0];
  if (first === undefined) return [];
  if (ordered.every((slot) => slot.intervalUs === first.intervalUs)) {
    return ordered.map((slot, i) => ({
      ...slot,
      phaseUs: Math.round((i * first.intervalUs) / ordered.length),
    }));
  }
  return ordered.reduce<readonly Slot[]>(
    (placed, slot) => [...placed, placeSlot(placed, slot, horizonUs).slot],
    [],
  );
}

/**
 * The next heartbeat a reply names (section 8, "Telling the sensor"): the first t with
 * t ≡ φ (mod I) and t ≥ e + `aheadUs`, e being the answered packet's end, as microseconds after e.
 */
export function nextOccurrenceAfterUs(slot: Slot, endedUs: number, aheadUs: number): number {
  const earliest = endedUs + aheadUs;
  const t = earliest + modulo(slot.phaseUs - earliest, slot.intervalUs);
  return t - endedUs;
}

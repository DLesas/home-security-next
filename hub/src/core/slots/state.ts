/**
 * The slots module's slice (hub-design.md section 2, module 11): each sensor's heartbeat slot
 * (phase, interval, span), its clock samples and the correction it last held, and the module's
 * timers (none: slots act only on arrivals and changes).
 */
import { type BootId, bootId, type DeviceId } from "../model/ids.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import type { Slot } from "./plan.ts";

/** A slotted heartbeat, the first of a possible sample pair (section 8, "Clock correction"). */
export interface HeartbeatMark {
  readonly gateway: DeviceId;
  /** Its end on the gateway's 32-bit microsecond clock. */
  readonly gatewayMicros: number;
  /** Its end on the hub's clock, to unwrap the gateway's. */
  readonly endedAt: Mono;
  readonly version: number;
}

export interface SlotEntry {
  readonly slot: Slot;
  /**
   * False after a restart until the sensor's first heartbeat: a phase is kept on one boot's
   * clock, so the plan of a previous run is anchored again on the sensor's own rhythm.
   */
  readonly anchored: boolean;
  readonly last: HeartbeatMark | undefined;
  /** Drifts d, as fractions, oldest first: at most the last 5 ‡. */
  readonly samples: readonly number[];
  /** The correction the sensor's current version holds, units of 10 ppm, as last seen. */
  readonly heldUnits: number | undefined;
  /** When `heldUnits` last changed, for the 6 hours ‡ between changes; undefined: long ago. */
  readonly changedAt: Mono | undefined;
}

export interface SlotsSlice {
  readonly timers: readonly TimerOf<"slots">[];
  readonly boot: BootId;
  readonly entries: ReadonlyMap<DeviceId, SlotEntry>;
}

/** The slice before the boot event. */
export const EMPTY_SLOTS_SLICE: SlotsSlice = { timers: [], boot: bootId(0), entries: new Map() };

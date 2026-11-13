/**
 * The clock module's slice (hub-design.md section 2, module 1; section 5, "Raspberry Pi"): this
 * run's boot record, the time at the start and of the last input, the wall time records are
 * stamped with, whether the wall clock is trusted, the last commit mark before the start, and how
 * long the hub was off (D113). It has no timers: it acts on every input.
 */
import type { DeviceId } from "../model/ids.ts";
import type { BootRow, DeviceStateRow } from "../model/rows.ts";
import type { Mono, Now } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/**
 * How long the hub was off: from the last commit before the stop to this run's first input
 * (section 5, "How long was the hub down?"). `firstStart`: there was no earlier run.
 */
export type Downtime =
  | { readonly kind: "firstStart" }
  | { readonly kind: "unknown" }
  | { readonly kind: "known"; readonly ms: number; readonly source: "wallClock" | "gatewayUptime" };

/** A gateway's last status before the stop, saved with the commit mark (section 5, way 2). */
export interface UptimeWitness {
  readonly gateway: DeviceId;
  readonly uptimeS: number;
  /** When that status arrived, on the stopped run's monotonic clock. */
  readonly statusMono: Mono;
}

export interface ClockSlice {
  readonly timers: readonly TimerOf<"clock">[];
  /** This run's row of `boots`, as last written; undefined before the boot event. */
  readonly boot: BootRow | undefined;
  /** The boot input's time. */
  readonly started: Now | undefined;
  /** The last input's time. */
  readonly last: Now | undefined;
  /**
   * The wall time records are stamped with: the highest wall time seen, so `at_ms` never
   * decreases within a table, also across a restart (section 6).
   */
  readonly recordWallMs: number;
  /** Whether the wall clock is trusted now (section 5). */
  readonly trusted: boolean;
  /** The last commit mark before this start: device 0's row of `device_state`. */
  readonly mark: DeviceStateRow | undefined;
  readonly downtime: Downtime;
  /** Gateways whose last status before the stop can tell the downtime from their uptime. */
  readonly witnesses: readonly UptimeWitness[];
}

/** The slice before the boot event. */
export const EMPTY_CLOCK_SLICE: ClockSlice = {
  timers: [],
  boot: undefined,
  started: undefined,
  last: undefined,
  recordWallMs: 0,
  trusted: false,
  mark: undefined,
  downtime: { kind: "unknown" },
  witnesses: [],
};

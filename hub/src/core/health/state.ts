/**
 * The health module's slice (m2-design.md section 2): battery percentages and low-battery state per device, tamper state. A stub in step 0 that holds only its
 * timers; owner A6 fills it in in step 1.
 */
import type { TimerOf } from "../model/timers.ts";

export interface HealthSlice {
  readonly timers: readonly TimerOf<"health">[];
}

/** The slice before the boot event. */
export const EMPTY_HEALTH_SLICE: HealthSlice = { timers: [] };

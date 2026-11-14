/**
 * The schedules module's slice (m2-design.md section 2): schedule entries, each one's next time, the hub's time zone. A stub in step 0 that holds only its
 * timers; owner A5 fills it in in step 1.
 */
import type { TimerOf } from "../model/timers.ts";

export interface SchedulesSlice {
  readonly timers: readonly TimerOf<"schedules">[];
}

/** The slice before the boot event. */
export const EMPTY_SCHEDULES_SLICE: SchedulesSlice = { timers: [] };

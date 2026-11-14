/**
 * The notify module's slice (m2-design.md section 2): notifications, who each is for, each client's categories and what it has read. A stub in step 0 that holds only its
 * timers; owner A6 fills it in in step 1.
 */
import type { TimerOf } from "../model/timers.ts";

export interface NotifySlice {
  readonly timers: readonly TimerOf<"notify">[];
}

/** The slice before the boot event. */
export const EMPTY_NOTIFY_SLICE: NotifySlice = { timers: [] };

/**
 * The upkeep module's slice (m2-design.md section 2): backup settings, whether a backup is due and
 * since when, the backup key and its epoch, a restore in progress, the update state (section 9).
 * A stub in step 0 that holds only its timers; owner A8 fills it in in step 1.
 */
import type { TimerOf } from "../model/timers.ts";

export interface UpkeepSlice {
  readonly timers: readonly TimerOf<"upkeep">[];
}

/** The slice before the boot event. */
export const EMPTY_UPKEEP_SLICE: UpkeepSlice = { timers: [] };

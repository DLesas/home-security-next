/**
 * The layout module's slice (m2-design.md section 2): groups and their members, the sirens of each group, modes and their groups, the current mode. A stub in step 0 that holds only its
 * timers; owner A4 fills it in in step 1.
 */
import type { TimerOf } from "../model/timers.ts";

export interface LayoutSlice {
  readonly timers: readonly TimerOf<"layout">[];
}

/** The slice before the boot event. */
export const EMPTY_LAYOUT_SLICE: LayoutSlice = { timers: [] };

/** The layout module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { LayoutSlice } from "./state.ts";

export function layoutDeadlines(slice: LayoutSlice): readonly TimerOf<"layout">[] {
  return slice.timers;
}

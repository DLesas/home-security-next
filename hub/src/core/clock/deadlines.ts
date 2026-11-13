/** The clock module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { ClockSlice } from "./state.ts";

export function clockDeadlines(slice: ClockSlice): readonly TimerOf<"clock">[] {
  return slice.timers;
}

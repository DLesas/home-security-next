/** The schedules module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { SchedulesSlice } from "./state.ts";

export function schedulesDeadlines(slice: SchedulesSlice): readonly TimerOf<"schedules">[] {
  return slice.timers;
}

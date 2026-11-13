/** The sensors module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { SensorsSlice } from "./state.ts";

export function sensorsDeadlines(slice: SensorsSlice): readonly TimerOf<"sensors">[] {
  return slice.timers;
}

/** The health module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { HealthSlice } from "./state.ts";

export function healthDeadlines(slice: HealthSlice): readonly TimerOf<"health">[] {
  return slice.timers;
}

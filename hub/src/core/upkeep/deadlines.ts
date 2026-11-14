/** The upkeep module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { UpkeepSlice } from "./state.ts";

export function upkeepDeadlines(slice: UpkeepSlice): readonly TimerOf<"upkeep">[] {
  return slice.timers;
}

/** The slots module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { SlotsSlice } from "./state.ts";

export function slotsDeadlines(slice: SlotsSlice): readonly TimerOf<"slots">[] {
  return slice.timers;
}

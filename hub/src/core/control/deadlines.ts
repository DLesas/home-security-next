/** The control module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { ControlSlice } from "./state.ts";

export function controlDeadlines(slice: ControlSlice): readonly TimerOf<"control">[] {
  return slice.timers;
}

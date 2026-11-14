/** The notify module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { NotifySlice } from "./state.ts";

export function notifyDeadlines(slice: NotifySlice): readonly TimerOf<"notify">[] {
  return slice.timers;
}

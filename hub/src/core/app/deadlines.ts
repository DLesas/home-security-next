/** The app module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { AppSlice } from "./state.ts";

export function appDeadlines(slice: AppSlice): readonly TimerOf<"app">[] {
  return slice.timers;
}

/** The setup module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { SetupSlice } from "./state.ts";

export function setupDeadlines(slice: SetupSlice): readonly TimerOf<"setup">[] {
  return slice.timers;
}

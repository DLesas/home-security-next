/** The intake module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { IntakeSlice } from "./state.ts";

export function intakeDeadlines(slice: IntakeSlice): readonly TimerOf<"intake">[] {
  return slice.timers;
}

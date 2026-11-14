/** The people module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { PeopleSlice } from "./state.ts";

export function peopleDeadlines(slice: PeopleSlice): readonly TimerOf<"people">[] {
  return slice.timers;
}

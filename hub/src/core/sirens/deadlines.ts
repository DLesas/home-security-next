/** The sirens module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { SirensSlice } from "./state.ts";

/** The sirens module's timers: repeats, the minute, path rules, "report now" (section 2). */
export function sirensDeadlines(slice: SirensSlice): readonly TimerOf<"sirens">[] {
  return slice.timers;
}

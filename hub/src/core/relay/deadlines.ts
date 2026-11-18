/** The relay module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { RelaySlice } from "./state.ts";

export function relayDeadlines(slice: RelaySlice): readonly TimerOf<"relay">[] {
  return slice.timers;
}

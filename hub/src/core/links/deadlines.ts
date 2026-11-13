/** The links module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { LinksSlice } from "./state.ts";

/** The links module has no timers (section 2, "Timers"). */
export function linksDeadlines(slice: LinksSlice): readonly TimerOf<"links">[] {
  return slice.timers;
}

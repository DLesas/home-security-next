/** The site module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { SiteSlice } from "./state.ts";

export function siteDeadlines(slice: SiteSlice): readonly TimerOf<"site">[] {
  return slice.timers;
}

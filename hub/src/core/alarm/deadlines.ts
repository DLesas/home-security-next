/** The alarm module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { AlarmSlice } from "./state.ts";

/** The alarm module's timers: its countdowns' ends and the alarm's (section 2). */
export function alarmDeadlines(slice: AlarmSlice): readonly TimerOf<"alarm">[] {
  return slice.timers;
}

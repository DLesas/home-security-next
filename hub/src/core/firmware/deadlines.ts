/** The firmware module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { FirmwareSlice } from "./state.ts";

export function firmwareDeadlines(slice: FirmwareSlice): readonly TimerOf<"firmware">[] {
  return slice.timers;
}

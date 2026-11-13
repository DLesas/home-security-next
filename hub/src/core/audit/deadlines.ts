/** The audit module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { AuditSlice } from "./state.ts";

export function auditDeadlines(slice: AuditSlice): readonly TimerOf<"audit">[] {
  return slice.timers;
}

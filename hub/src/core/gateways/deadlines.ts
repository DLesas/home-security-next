/** The gateways module's timers, for `nextDeadline` and the dispatcher (hub-design.md section 2, "Timers"). */
import type { TimerOf } from "../model/timers.ts";
import type { GatewaysSlice } from "./state.ts";

/** Its timers: offline, unproven sessions and transmit results (section 2, "Timers"). */
export function gatewaysDeadlines(slice: GatewaysSlice): readonly TimerOf<"gateways">[] {
  return slice.timers;
}

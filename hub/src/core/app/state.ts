/**
 * The app module's slice (m2-design.md section 2): app sessions (connection, client, person, protocol version, subscriptions) and the live revision. A stub in step 0 that holds only its
 * timers; owner A3 fills it in in step 1.
 */
import type { TimerOf } from "../model/timers.ts";

export interface AppSlice {
  readonly timers: readonly TimerOf<"app">[];
}

/** The slice before the boot event. */
export const EMPTY_APP_SLICE: AppSlice = { timers: [] };

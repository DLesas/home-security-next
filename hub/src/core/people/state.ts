/**
 * The people module's slice (m2-design.md section 2): people, linked clients and their public keys, permissions, the user-management switch, link tokens and invites, each client's last accepted sequence number. A stub in step 0 that holds only its
 * timers; owner A3 fills it in in step 1.
 */
import type { TimerOf } from "../model/timers.ts";

export interface PeopleSlice {
  readonly timers: readonly TimerOf<"people">[];
}

/** The slice before the boot event. */
export const EMPTY_PEOPLE_SLICE: PeopleSlice = { timers: [] };

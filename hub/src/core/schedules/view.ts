/**
 * Read-only selectors over the schedules module's slice that other modules may use (hub-design.md
 * section 2). None in step 0; owner A5 adds them.
 */
import type { HubState } from "../model/state.ts";
import type { SchedulesSlice } from "./state.ts";

/** The slice itself, for tests and the owner's first selectors. */
export function schedulesSlice(view: HubState): SchedulesSlice {
  return view.schedules;
}

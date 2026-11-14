/**
 * Read-only selectors over the upkeep module's slice that other modules may use (hub-design.md
 * section 2). None in step 0; owner A8 adds them.
 */
import type { HubState } from "../model/state.ts";
import type { UpkeepSlice } from "./state.ts";

/** The slice itself, for tests and the owner's first selectors. */
export function upkeepSlice(view: HubState): UpkeepSlice {
  return view.upkeep;
}

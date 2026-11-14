/**
 * Read-only selectors over the health module's slice that other modules may use (hub-design.md
 * section 2). None in step 0; owner A6 adds them.
 */
import type { HubState } from "../model/state.ts";
import type { HealthSlice } from "./state.ts";

/** The slice itself, for tests and the owner's first selectors. */
export function healthSlice(view: HubState): HealthSlice {
  return view.health;
}

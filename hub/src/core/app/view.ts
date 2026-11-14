/**
 * Read-only selectors over the app module's slice that other modules may use (hub-design.md
 * section 2). None in step 0; owner A3 adds them.
 */
import type { HubState } from "../model/state.ts";
import type { AppSlice } from "./state.ts";

/** The slice itself, for tests and the owner's first selectors. */
export function appSlice(view: HubState): AppSlice {
  return view.app;
}

/**
 * Read-only selectors over the layout module's slice that other modules may use (hub-design.md
 * section 2). None in step 0; owner A4 adds them.
 */
import type { HubState } from "../model/state.ts";
import type { LayoutSlice } from "./state.ts";

/** The slice itself, for tests and the owner's first selectors. */
export function layoutSlice(view: HubState): LayoutSlice {
  return view.layout;
}

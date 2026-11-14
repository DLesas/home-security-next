/**
 * Read-only selectors over the notify module's slice that other modules may use (hub-design.md
 * section 2). None in step 0; owner A6 adds them.
 */
import type { HubState } from "../model/state.ts";
import type { NotifySlice } from "./state.ts";

/** The slice itself, for tests and the owner's first selectors. */
export function notifySlice(view: HubState): NotifySlice {
  return view.notify;
}

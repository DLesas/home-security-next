/**
 * Read-only selectors over the people module's slice that other modules may use (hub-design.md
 * section 2). None in step 0; owner A3 adds them.
 */
import type { HubState } from "../model/state.ts";
import type { PeopleSlice } from "./state.ts";

/** The slice itself, for tests and the owner's first selectors. */
export function peopleSlice(view: HubState): PeopleSlice {
  return view.people;
}

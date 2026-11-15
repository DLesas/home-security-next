/**
 * Whether a notification is read for a person (m2-design.md section 7): once any client of theirs
 * marked it read; for the console, once any console did. Pure, over `people`'s view.
 */
import type { PersonId } from "../model/ids.ts";
import type { HubState } from "../model/state.ts";
import { clientsFor } from "./audience.ts";
import type { Raised } from "./state.ts";

/** Whether `raised` is read for `person` (null: the console). */
export function readBy(view: HubState, raised: Raised, person: PersonId | null): boolean {
  if (raised.read.size === 0) return false;
  const clients = person === null ? clientsFor(view, []) : clientsFor(view, [person]);
  return clients.some((client) => raised.read.has(client));
}

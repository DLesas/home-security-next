/**
 * Who a notification is for (m2-design.md section 7, "Notifications" and "People and
 * permissions"; D69, D76, HB5a), read from `people`'s view as the state stands when `notify`
 * handles the message, so a change earlier in the same step is seen. Pure.
 *
 * - About a sensor: every person who may view it (`peopleWhoMayView`; *manage* includes *view*,
 *   and while user management is off every person may, D13).
 * - About an action: every person who may view at least one sensor it changes.
 * - About a siren or a gateway: every person, since they have no permission of their own and every
 *   person may see their state ‡ (section 7).
 * - About the hub as a whole: every person with *manage system*.
 * - The console belongs to no person and receives every notification ‡.
 */
import type { ClientId, DeviceId, PersonId } from "../model/ids.ts";
import { ClientKind } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import {
  clientsOf,
  liveClient,
  peopleSlice,
  peopleWhoMayView,
  peopleWith,
} from "../people/view.ts";

/** What a notification is about, for its recipients. */
export type About =
  | { readonly kind: "sensor"; readonly device: DeviceId }
  | { readonly kind: "device"; readonly device: DeviceId }
  | { readonly kind: "sensors"; readonly sensors: readonly DeviceId[] }
  | { readonly kind: "hub" }
  | { readonly kind: "people"; readonly people: readonly PersonId[] };

/** Every live person. */
function livePeople(view: HubState): readonly PersonId[] {
  return [...peopleSlice(view).people.values()]
    .filter((person) => person.removedMs === null)
    .map((person) => person.id);
}

/** The people a notification about `about` is for, ascending. */
export function recipients(view: HubState, about: About): readonly PersonId[] {
  const people = ((): readonly PersonId[] => {
    switch (about.kind) {
      case "sensor":
        return peopleWhoMayView(view, about.device);
      case "sensors":
        return [...new Set(about.sensors.flatMap((sensor) => peopleWhoMayView(view, sensor)))];
      case "device":
        return livePeople(view);
      case "hub":
        return peopleWith(view, "manageSystem");
      case "people": {
        const live = new Set(livePeople(view));
        return about.people.filter((person) => live.has(person));
      }
    }
  })();
  return [...people].sort((a, b) => a - b);
}

/** A client's person: null for the console, undefined for a client not live. */
export function personOf(view: HubState, client: ClientId): PersonId | null | undefined {
  const row = liveClient(view, client);
  if (row === undefined) return undefined;
  return row.kind === ClientKind.Console ? null : row.personId;
}

/**
 * The live clients a notification for `people` may go to: those of the ones not removed, and
 * every live console. A removed person, client or console is never told.
 */
export function clientsFor(view: HubState, people: readonly PersonId[]): readonly ClientId[] {
  const consoles = [...peopleSlice(view).clients.values()]
    .filter((row) => row.removedMs === null && row.kind === ClientKind.Console)
    .map((row) => row.id);
  const live = new Set(livePeople(view));
  const theirs = people
    .filter((person) => live.has(person))
    .flatMap((person) => clientsOf(view, person));
  return [...new Set([...theirs, ...consoles])].sort((a, b) => a - b);
}

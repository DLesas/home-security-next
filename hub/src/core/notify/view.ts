/**
 * Read-only selectors over the notify module's slice that other modules may use (hub-design.md
 * section 2): what `app`'s snapshot shows of notifications (section 6, `snapshot`: "unread
 * notifications"), and a client's categories.
 */
import {
  categoryBit,
  type NotificationObject,
  OPTIONAL_CATEGORIES,
  type OptionalCategory,
} from "@hsn/protocol/app";
import type { ClientId, PersonId } from "../model/ids.ts";
import type { HubRules } from "../model/rules.ts";
import type { HubState } from "../model/state.ts";
import { categoriesOf, isDelayed, isForPerson, notificationObject } from "./deliver.ts";
import { readBy } from "./reads.ts";
import type { NotifySlice } from "./state.ts";

/** The slice itself, for tests. */
export function notifySlice(view: HubState): NotifySlice {
  return view.notify;
}

/**
 * A person's unread notifications raised at or after `sinceMs` (the last 7 days ‡ for a snapshot),
 * oldest first; `person` null for the console, which sees every one. With `nowMs`, one raised
 * more than 60 s ‡ before it is marked `delayed` (D102's rule).
 */
export function unreadFor(
  view: HubState,
  person: PersonId | null,
  sinceMs: number,
  rules?: HubRules,
  nowMs?: number,
): readonly NotificationObject[] {
  return view.notify.notifications
    .filter(
      (raised) =>
        raised.row.atMs >= sinceMs && isForPerson(raised, person) && !readBy(view, raised, person),
    )
    .map((raised) =>
      notificationObject(
        raised,
        false,
        rules !== undefined && nowMs !== undefined && isDelayed(rules, raised, nowMs),
      ),
    );
}

/**
 * A client's preferences as the snapshot and `notifications.prefs` carry them: the optional
 * categories on, in their bits' order, and the row's revision (0 before the client set any).
 */
export function prefsFor(
  view: HubState,
  client: ClientId,
): { readonly categories: readonly OptionalCategory[]; readonly revision: number } {
  const bits = categoriesOf(view.notify, client);
  return {
    categories: OPTIONAL_CATEGORIES.filter((c) => (bits & categoryBit(c)) !== 0),
    revision: view.notify.prefs.get(client)?.revision ?? 0,
  };
}

/** The optional categories a client has on (section 7), in their bits' order. */
export function categoriesOn(view: HubState, client: ClientId): readonly string[] {
  const bits = categoriesOf(view.notify, client);
  return OPTIONAL_CATEGORIES.filter((c) => (bits & categoryBit(c)) !== 0);
}

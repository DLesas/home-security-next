/**
 * The notify module's slice (m2-design.md section 2): notifications, who each is for, each
 * client's categories and what it has read.
 *
 * - Notifications are kept for the unread window (7 days ‡): what the snapshot's unread and
 *   `notifications.list` answer from. They are the `notifications` audit rows, critical ones
 *   written now, the rest routine (section 3); at a start the snapshot gives those of the last 7
 *   days with their reads, so what is unread survives a restart.
 * - Reads are `notification_reads` rows, routine; the slice keeps which clients read each.
 * - Categories are `notification_prefs`, written now (configuration, section 4).
 * - People, permissions and sessions are not here: `people`'s view gives the first two, and
 *   `app` sends the events to the sessions (`notificationRaised`).
 */
import type { NotificationCategory } from "@hsn/protocol/app";
import type { ClientId, PersonId } from "../model/ids.ts";
import type { NotificationPrefsRow, NotificationRow } from "../model/rows.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";

/** One notification of the unread window. */
export interface Raised {
  readonly row: NotificationRow;
  readonly category: NotificationCategory;
  readonly recipients: readonly PersonId[];
  /** Clients that marked it read. */
  readonly read: ReadonlySet<ClientId>;
}

export interface NotifySlice {
  readonly timers: readonly TimerOf<"notify">[];
  /** Notifications of the unread window, oldest first. */
  readonly notifications: readonly Raised[];
  /** `notification_prefs` by client; a client without a row has every optional category on. */
  readonly prefs: ReadonlyMap<ClientId, NotificationPrefsRow>;
  /** When each kind about each device was last notified, for the flood rule (section 7). */
  readonly lastRaised: ReadonlyMap<string, Mono>;
}

/** The slice before the boot event. */
export const EMPTY_NOTIFY_SLICE: NotifySlice = {
  timers: [],
  notifications: [],
  prefs: new Map(),
  lastRaised: new Map(),
};

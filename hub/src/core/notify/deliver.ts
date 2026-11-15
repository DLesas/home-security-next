/**
 * Who of a notification's recipients gets it, by their client's categories, and how it reads as
 * a `NotificationObject` (m2-design.md section 7, "Notifications"). Pure.
 *
 * - A client gets a notification when its person is a recipient (the console: every one ‡), it
 *   is not the client the notification is about (a new client is told to the other clients of its
 *   person), and its category is on for that client or cannot be turned off (D69, D75, AP9a).
 * - One delivered more than 60 s ‡ after it was raised is `delayed` (D102's rule, for sessions).
 * - A notification is read for a person once any of their clients marked it read.
 */
import {
  categoryBit,
  type NotificationCategory,
  type NotificationObject,
  OPTIONAL_CATEGORIES,
  type OptionalCategory,
} from "@hsn/protocol/app";
import type { ClientId, PersonId } from "../model/ids.ts";
import type { HubRules } from "../model/rules.ts";
import type { NotifySlice, Raised } from "./state.ts";

/** Every optional category on: a client without a `notification_prefs` row (section 7). */
export const ALL_OPTIONAL_ON = OPTIONAL_CATEGORIES.reduce((bits, c) => bits | categoryBit(c), 0);

function isOptional(category: NotificationCategory): category is OptionalCategory {
  return (OPTIONAL_CATEGORIES as readonly string[]).includes(category);
}

/** The optional categories a client has on, as bits. */
export function categoriesOf(slice: NotifySlice, client: ClientId): number {
  return slice.prefs.get(client)?.categories ?? ALL_OPTIONAL_ON;
}

/** Whether a client's categories let a notification of `category` through. */
export function categoryOn(
  slice: NotifySlice,
  client: ClientId,
  category: NotificationCategory,
  mandatory: boolean,
): boolean {
  if (mandatory || !isOptional(category)) return true;
  return (categoriesOf(slice, client) & categoryBit(category)) !== 0;
}

/** Whether `raised` is for `person` (null: the console, for which every one is). */
export function isForPerson(raised: Raised, person: PersonId | null): boolean {
  return person === null || raised.recipients.includes(person);
}

/** Whether a notification delivered at `wallMs` is late (D102's rule, 60 s ‡). */
export function isDelayed(rules: HubRules, raised: Raised, wallMs: number): boolean {
  return wallMs - raised.row.atMs > rules.notify.delayedAfterMs;
}

/** The notification as `notifications.list`, the snapshot and the `notification` event carry it. */
export function notificationObject(
  raised: Raised,
  read: boolean,
  delayed: boolean,
): NotificationObject {
  const { row } = raised;
  return {
    seq: row.seq,
    atMs: row.atMs,
    clockOk: row.clockOk,
    kind: row.kind,
    category: raised.category,
    critical: row.critical,
    device: row.deviceId,
    cause: row.causeSeq,
    read,
    delayed,
  };
}

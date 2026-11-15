/**
 * What can go wrong on the client's side of a request, beside the hub's own refusals (section 5's
 * error codes): every one is shown in words (`state/words.ts`).
 */
export const LOCAL_FAULTS = [
  /** No session: requests made while out of touch are not queued (section 8). */
  "offline",
  /** The session closed before a read's reply came. */
  "lost",
  /** The reply did not match the operation's schema. */
  "badReply",
  /** The next `seq` could not be written to storage, so the change was not sent. */
  "storage",
  /** This browser was removed from the hub. */
  "removed",
  /** This browser is not linked. */
  "notLinked",
  /** The tab holding the connection closed before it answered. */
  "tabClosed",
  /**
   * A change sent whose reply was lost and which could not be sent again within 30 s ‡: whether
   * the hub made it is not known (section 8, wave 2's ruling); the next snapshot shows the house.
   */
  "unconfirmed",
] as const;

export type LocalFault = (typeof LOCAL_FAULTS)[number];

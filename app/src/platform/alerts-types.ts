/**
 * The types of `alerts.ts`'s pair, apart from it: in the phone's type check
 * (`tsconfig.native.json`) `./alerts` is the phone's file.
 */

/** Whether the system's notifications may be shown: as the browser says, or none here. */
export type NoticePermission = "granted" | "denied" | "default" | "unsupported";

export interface Alerts {
  /** The permission as it stands, without asking. */
  readonly noticePermission: () => NoticePermission;
  /** Asks the system's question; resolves with the answer. */
  readonly askNoticePermission: () => Promise<NoticePermission>;
  /** Shows the system's notification, if allowed; `tag` makes repeats of one notification one. */
  readonly showNotice: (title: string, body: string, tag: string) => void;
  /** A short tone, if the system lets the app make one. */
  readonly tone: () => void;
}

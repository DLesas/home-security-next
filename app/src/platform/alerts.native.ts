/**
 * Alerting on a phone while the app is open, the phone's side of `alerts.ts`. Not built yet: P5
 * builds it in wave 1 on expo-notifications (a notification with sound). Until then there is no
 * notification and no tone (`unsupported`); the banner and the screen reader's announcement
 * remain.
 */
import type { Alerts } from "./alerts-types";

export const noticePermission: Alerts["noticePermission"] = () => "unsupported";
export const askNoticePermission: Alerts["askNoticePermission"] = () =>
  Promise.resolve("unsupported");
/** Not built: nothing is shown. */
export const showNotice: Alerts["showNotice"] = () => undefined;
/** Not built: no sound. */
export const tone: Alerts["tone"] = () => undefined;

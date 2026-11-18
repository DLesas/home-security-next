/**
 * Alerting the person while the app is open (m2-design.md section 7, "Notifications"; m3-design.md
 * section 2): the system's own notification and a short tone, for a critical notification.
 * `alerts.web.ts` uses the browser's `Notification` and `AudioContext`; `alerts.native.ts` will use
 * expo-notifications (P5, wave 1). Metro loads one of them in place of this file; tsc and Bun's
 * tests read this one, which binds the web build's (`split.ts`).
 */
import type { Alerts } from "./alerts-types";
import type { Split } from "./split";
import type * as phone from "./alerts.native";
import * as web from "./alerts.web";

export type { Alerts, NoticePermission } from "./alerts-types";

/** Both platforms' files export `Alerts`. */
export type Platforms = Split<Alerts, typeof web, typeof phone>;

export const { noticePermission, askNoticePermission, showNotice, tone }: Alerts = web;

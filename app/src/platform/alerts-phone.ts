/**
 * Alerting on a phone while the app is open (m3-design.md section 6, "Notifications while the app
 * is open"), apart from React Native so it can be tested: what `alerts.native.ts` does.
 *
 * The system's own notification needs expo-notifications, which is not installed (only
 * expo-sharing was approved for this step), so there is none yet: `unsupported`. While the app is
 * open an urgent notification is the notice over every screen (`CriticalNotices`), which Android
 * reads as an assertive live region and iOS is told by announcement, and the phone vibrates for
 * it, in place of the browser's tone.
 */
import type { Alerts } from "./alerts-types";

export interface PhoneAlertDeps {
  /** Says a text to a screen reader at once (`announce.ts`). */
  readonly announce: (text: string) => void;
  /** React Native's `Vibration.vibrate` with a pattern. */
  readonly vibrate: (pattern: readonly number[]) => void;
}

/** Two pulses: off 0 ms, on 400, off 200, on 400. */
export const ALERT_VIBRATION = [0, 400, 200, 400] as const;

export function phoneAlerts(deps: PhoneAlertDeps): Alerts {
  return {
    noticePermission: () => "unsupported",
    askNoticePermission: () => Promise.resolve("unsupported"),
    showNotice: (title, body) => {
      deps.announce(`${title}. ${body}`);
    },
    tone: () => {
      deps.vibrate(ALERT_VIBRATION);
    },
  };
}

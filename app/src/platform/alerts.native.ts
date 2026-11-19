/**
 * Alerting on a phone while the app is open, the phone's side of `alerts.ts` (`alerts-phone.ts`
 * says what and why): no system notification without expo-notifications; the urgent notice is
 * announced on iOS, and the phone vibrates in place of a tone.
 */
import { Vibration } from "react-native";
import { phoneAlerts } from "./alerts-phone";
import { announce } from "./announce.native";

const alerts = phoneAlerts({
  announce,
  vibrate: (pattern) => {
    Vibration.vibrate([...pattern]);
  },
});

export const { noticePermission, askNoticePermission, showNotice, tone } = alerts;

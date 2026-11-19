/**
 * Announcing on a phone, the phone's side of `announce.ts`: iOS is told through
 * `AccessibilityInfo.announceForAccessibility`; Android reads the live region.
 */
import { AccessibilityInfo, Platform } from "react-native";
import { type Announce, phoneAnnouncer } from "./announce-types";

export const announce: Announce["announce"] = phoneAnnouncer({
  os: Platform.OS,
  announceForAccessibility: (text) => {
    AccessibilityInfo.announceForAccessibility(text);
  },
});

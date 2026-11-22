/** Expo's permission prompt and the system settings for this app. */
import { DEPLOYMENT } from "@hsn/deployment";
import { PermissionStatus } from "expo";
import {
  getPermissionsAsync,
  requestPermissionsAsync,
} from "expo-notifications/build/NotificationPermissions";
import { AppState, Linking, Platform } from "react-native";
import type {
  AlertPermission,
  AlertPermissionAnswer,
  AlertPermissionResult,
} from "./alert-permission-types";
import { secureItems } from "./vault-items.native";

const askedItem = "notifications.asked";
const failed = { ok: false, fault: "failed" } as const;

/** Android can return denied even before the first prompt, so remember the first answer locally. */
async function read(): AlertPermissionResult {
  const settings = await getPermissionsAsync().catch(() => undefined);
  if (!settings) return failed;
  if (settings.granted && settings.status === PermissionStatus.GRANTED)
    return { ok: true, value: "granted" };
  if (Platform.OS === "android" && settings.canAskAgain) {
    const asked = await secureItems.get(askedItem);
    if (!asked.ok) return failed;
    return { ok: true, value: asked.value === null ? "notAsked" : "denied" };
  }
  return {
    ok: true,
    value: settings.status === PermissionStatus.UNDETERMINED ? "notAsked" : "denied",
  };
}

/** Requests the permission once and keeps Android's answer across restarts. */
async function ask(): AlertPermissionResult {
  const settings = await requestPermissionsAsync().catch(() => undefined);
  if (!settings) return failed;
  if (Platform.OS === "android") await secureItems.set(askedItem, "1");
  const value: AlertPermissionAnswer =
    settings.granted && settings.status === PermissionStatus.GRANTED ? "granted" : "denied";
  return { ok: true, value };
}

/** Adapts a settings intent without exposing a native error. */
function settingsOpened(open: Promise<void>): AlertPermissionResult<void> {
  return open.then(
    () => ({ ok: true, value: undefined }),
    () => failed,
  );
}

/** Opens this app's general settings using React Native's cross-platform API. */
function openSettings() {
  return settingsOpened(Linking.openSettings());
}

/** Navigates directly to notification settings where Android supports the intent. */
function openNotificationSettings() {
  return settingsOpened(
    Linking.sendIntent("android.settings.APP_NOTIFICATION_SETTINGS", [
      { key: "android.provider.extra.APP_PACKAGE", value: DEPLOYMENT.android.applicationId },
    ]).catch(() => Linking.openSettings()),
  );
}

export const alertPermission: AlertPermission | undefined = {
  read,
  ask,
  openSettings,
  ...(Platform.OS === "android" ? { openNotificationSettings } : {}),
  /** Reads settings again when the person returns to the app. */
  onForeground: (refresh) => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      listener.remove();
    };
  },
};

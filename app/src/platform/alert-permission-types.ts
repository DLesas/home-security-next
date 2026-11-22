/** The operating system's answer for notifications on this phone. */
import type { Outcome } from "./split";

export type AlertPermissionAnswer = "granted" | "denied" | "notAsked";
export type AlertPermissionResult<T = AlertPermissionAnswer> = Promise<Outcome<T, "failed">>;

export interface AlertPermission {
  /** Reads the system's current answer without asking. */
  read(): AlertPermissionResult;
  /** Asks the system after the person presses Allow notifications. */
  ask(): AlertPermissionResult;
  /** Opens this app's system settings. */
  openSettings(): AlertPermissionResult<void>;
  /** On Android, opens this app's notification settings. */
  readonly openNotificationSettings?: () => AlertPermissionResult<void>;
  /** Calls back on return to the app and provides an unsubscribe. */
  onForeground(refresh: () => void): () => void;
}

export interface AlertPermissionPlatform {
  readonly alertPermission: AlertPermission | undefined;
}

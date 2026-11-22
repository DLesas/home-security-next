/** A scriptable phone permission, with no native prompt or settings. */
import type { AlertPermission, AlertPermissionAnswer } from "./alert-permission-types";

/** Supplies permission answers and counts button presses and returns from settings. */
export function fakeAlertPermission(initial: AlertPermissionAnswer = "notAsked", android = true) {
  const state = {
    answer: initial,
    next: "granted" as AlertPermissionAnswer,
    asked: 0,
    settings: 0,
    notificationSettings: 0,
  };
  const foreground = new Set<() => void>();
  const permission: AlertPermission = {
    /** Reads the simulated system's current answer. */
    read: () => Promise.resolve({ ok: true, value: state.answer }),
    /** Applies the answer scripted for the next prompt. */
    ask: () => {
      state.asked++;
      state.answer = state.next;
      return Promise.resolve({ ok: true, value: state.answer });
    },
    /** Records a visit to the app's settings. */
    openSettings: () => {
      state.settings++;
      return Promise.resolve({ ok: true, value: undefined });
    },
    ...(android
      ? {
          /** Records a visit directly to the app's notification settings. */
          openNotificationSettings: () => {
            state.notificationSettings++;
            return Promise.resolve({ ok: true as const, value: undefined });
          },
        }
      : {}),
    /** Subscribes to the simulated app returning to the foreground. */
    onForeground: (refresh) => {
      foreground.add(refresh);
      return () => {
        foreground.delete(refresh);
      };
    },
  };
  return {
    permission,
    state,
    /** Changes the system answer in settings and simulates returning to the app. */
    returnFromSettings(answer: AlertPermissionAnswer) {
      state.answer = answer;
      for (const refresh of foreground) refresh();
    },
  };
}

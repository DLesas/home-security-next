/**
 * Alerting in a browser, the web build's side of `alerts.ts`: the browser's own notification if
 * the person allowed it, and a tone if the browser lets the page make one (most only after it was
 * touched). A web page is no substitute for push: a closed tab is told nothing.
 */
import type { NoticePermission } from "./alerts-types";

export function noticePermission(): NoticePermission {
  return typeof Notification === "function" ? Notification.permission : "unsupported";
}

export function askNoticePermission(): Promise<NoticePermission> {
  return typeof Notification === "function"
    ? Notification.requestPermission()
    : Promise.resolve("unsupported");
}

export function showNotice(title: string, body: string, tag: string): void {
  if (typeof Notification !== "function" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag });
  } catch {
    // A browser that refuses it: the banner remains.
  }
}

export function tone(): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 880;
    oscillator.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.6);
  } catch {
    // No sound allowed: the banner and the screen reader's announcement remain.
  }
}

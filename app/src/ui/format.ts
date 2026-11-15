/**
 * Times as people read them (m2-design.md section 8): in the hub's time zone from `hub.info`, not
 * the browser's ‡, so a time reads the same on every screen; formatted by `Intl.DateTimeFormat`.
 * The app does no calendar arithmetic. While the hub's clock is not trusted, a time is "about".
 */
import type { HubInfo } from "@hsn/protocol/app";
import type { Translate } from "../state/words";

export function formatTime(
  t: Translate,
  language: string,
  hub: Pick<HubInfo, "timeZone" | "clockTrusted"> | null,
  ms: number,
): string {
  let text: string;
  try {
    text = new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(hub === null ? {} : { timeZone: hub.timeZone }),
    }).format(ms);
  } catch {
    // A zone this browser's Intl does not know: the instant in UTC, still unambiguous.
    text = new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(ms);
  }
  return hub !== null && !hub.clockTrusted ? t("time.about", { time: text }) : text;
}

/** Seconds left of a countdown told at `toldAtMs`, never below zero. */
export function secondsLeft(
  countdown: { readonly secondsLeft: number; readonly toldAtMs: number },
  nowMs: number,
): number {
  return Math.max(0, countdown.secondsLeft - Math.floor((nowMs - countdown.toldAtMs) / 1000));
}

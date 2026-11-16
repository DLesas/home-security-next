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
  // Date and time apart, joined by the app's own words: systems join them differently (", ", " at ").
  const zone = hub === null ? undefined : hub.timeZone;
  let text: string;
  try {
    text = joinDateTime(t, language, ms, zone);
  } catch {
    // A zone this browser's Intl does not know: the instant in UTC, still unambiguous.
    text = joinDateTime(t, language, ms, "UTC");
  }
  return hub !== null && !hub.clockTrusted ? t("time.about", { time: text }) : text;
}

function joinDateTime(
  t: Translate,
  language: string,
  ms: number,
  zone: string | undefined,
): string {
  const inZone = zone === undefined ? {} : { timeZone: zone };
  const date = new Intl.DateTimeFormat(language, { dateStyle: "medium", ...inZone }).format(ms);
  const time = new Intl.DateTimeFormat(language, { timeStyle: "short", ...inZone }).format(ms);
  return t("time.at", { date, time });
}

/** Seconds left of a countdown told at `toldAtMs`, never below zero. */
export function secondsLeft(
  countdown: { readonly secondsLeft: number; readonly toldAtMs: number },
  nowMs: number,
): number {
  return Math.max(0, countdown.secondsLeft - Math.floor((nowMs - countdown.toldAtMs) / 1000));
}

/**
 * What meets the top of a phone's screen, behind the status bar (docs/app-design.md, "On a
 * phone", rules 1 and 2): the state field's look on Home, the alarm or countdown band over any
 * screen, else the page. Pure, so the shell's band and status bar are tested.
 */
import type { LiveState } from "../state/live";
import { LOOK, type Look, runningCountdowns } from "./banners";
import { houseState } from "./state-field";

export type Top = Look | "page";

/** What meets the top: the alarm and a countdown on every screen; the field's look on Home. */
export function topOf(
  state: Pick<LiveState, "alarm" | "countdowns" | "sensors" | "mode" | "modes">,
  home: boolean,
): Top {
  if (state.alarm !== null) return "alarm";
  if (runningCountdowns(state).length > 0) return "night";
  if (!home) return "page";
  return houseState(state).look;
}

/** The band behind the status bar: the colour of what meets it. */
export const BAND: Readonly<Record<Top, string>> = {
  page: "bg-limewash",
  day: LOOK.day.box,
  night: LOOK.night.box,
  alarm: LOOK.alarm.box,
};

/** The status bar's text: light on night and alarm, dark on day and every page. */
export function statusBarStyle(top: Top): "light" | "dark" {
  return top === "night" || top === "alarm" ? "light" : "dark";
}

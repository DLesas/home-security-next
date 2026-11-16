/**
 * Two live events made from the state they report, not from the messages that changed it
 * (m2-design.md section 5, "Live updates"; section 6), so no path can change it unseen: a client's
 * request, `hsn`, a schedule, or the hub's own choice.
 *
 * - **A countdown's end**: every sensor that leaves the alarm's countdowns tells it once, to those
 *   who may view it: `cancelled` when it is now disarmed (a disarm, a mode switch that disarms it),
 *   `ended` otherwise (it ran out into the alarm, or the alarm took it).
 * - **The site's settings**: whenever the site's row moves and what `site.show` shows of it
 *   changes (a survey's channel, `site.set`, the Wi-Fi name, a move's switch), `config {site}` to
 *   every session subscribed to `config`, as `site.show` is anyone's.
 */
import { armState } from "../alarm/view.ts";
import type { DeviceId } from "../model/ids.ts";
import { ArmState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { mayView } from "../people/view.ts";
import type { Sending } from "./events.ts";
import { siteObject } from "./objects.ts";

export function countdownChanges(sending: Sending, view: HubState): void {
  const now = view.alarm.countdowns;
  const seen = sending.slice.countdownsSeen;
  if (seen === now) return;
  sending.slice = { ...sending.slice, countdownsSeen: now };
  if (seen === undefined) return;
  const ended = [...seen.keys()].filter((sensor) => !now.has(sensor)).toSorted((a, b) => a - b);
  for (const sensor of ended) endOf(sending, view, sensor);
}

function endOf(sending: Sending, view: HubState, sensor: DeviceId): void {
  const what = armState(view, sensor) === ArmState.Disarmed ? "cancelled" : "ended";
  sending.event(view, "countdown", (_session, actor) =>
    mayView(view, actor, sensor) ? { sensor, what, secondsLeft: 0, trigger: null } : undefined,
  );
}

export function siteChanges(sending: Sending, view: HubState): void {
  const row = view.site.row;
  if (sending.slice.siteRowSeen === row) return;
  const site = siteObject(view);
  const text = JSON.stringify(site);
  const before = sending.slice.siteSent;
  sending.slice = { ...sending.slice, siteRowSeen: row, siteSent: text };
  if (before === undefined || before === text) return;
  sending.event(view, "config", () => ({ site }));
}

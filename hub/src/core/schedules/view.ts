/**
 * Read-only selectors over the schedules module's slice that other modules may use (hub-design.md
 * section 2): the entries as the app shows them (snapshot, `config` events), the hub's time zone
 * (`hub.info`), and the entries that name a mode, group or sensor, for layout's rule that
 * deleting what a schedule names is refused, naming the schedules ‡ (section 7).
 */
import type { ScheduleObject } from "@hsn/protocol/app";
import type { DeviceId, GroupId, ModeId, ScheduleId } from "../model/ids.ts";
import type { HubState } from "../model/state.ts";
import { byId, scheduleObjectOf } from "./entries.ts";
import type { SchedulesSlice } from "./state.ts";

/** The slice itself, for tests. */
export function schedulesSlice(view: HubState): SchedulesSlice {
  return view.schedules;
}

/** Every entry, in id order, with its next time and its last miss (section 6, `scheduleObject`). */
export function scheduleObjects(view: HubState): readonly ScheduleObject[] {
  return byId(view.schedules.entries.values()).map(scheduleObjectOf);
}

/** One entry, or undefined. */
export function scheduleObject(view: HubState, id: ScheduleId): ScheduleObject | undefined {
  const entry = view.schedules.entries.get(id);
  return entry === undefined ? undefined : scheduleObjectOf(entry);
}

/**
 * The site's time zone, for `hub.info.timeZone` (section 11, settled): the stored zone
 * (`schedule_state.time_zone`) until the shell's `timeZone` arrives, then that one; null before
 * either, never an empty string.
 */
export function timeZone(view: HubState): string | null {
  return view.schedules.zone;
}

/** The entries that name this mode, group or sensor, in id order (`invalid`, `inUse`, `refs`). */
export function schedulesNaming(
  view: HubState,
  named: { readonly mode: ModeId } | { readonly group: GroupId } | { readonly sensor: DeviceId },
): readonly ScheduleId[] {
  return byId(view.schedules.entries.values())
    .filter(({ row }) =>
      "mode" in named
        ? row.modeId === named.mode
        : "group" in named
          ? row.groupId === named.group
          : row.sensorId === named.sensor,
    )
    .map(({ row }) => row.id);
}

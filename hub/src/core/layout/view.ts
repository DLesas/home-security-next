/**
 * Read-only selectors over the layout module's slice that other modules may use (hub-design.md
 * section 2; m2-design.md section 2): the alarm module for the sirens a trigger sounds (AL2a,
 * D74), the app module for which sensors a request would change (HB5a) and for the snapshot's
 * current mode, the schedules module for whether the modes and groups its entries name exist.
 */
import { alarmSensors, armingPlan, disarmingPlan } from "../alarm/view.ts";
import type { DeviceId, GroupId, ModeId } from "../model/ids.ts";
import type { HubState } from "../model/state.ts";
import { groupObject, modeObject } from "./config.ts";
import { modeSensors } from "./resolve.ts";
import type { Group, LayoutSlice, Mode } from "./state.ts";

/** The slice itself, for tests. */
export function layoutSlice(view: HubState): LayoutSlice {
  return view.layout;
}

/** The current mode (null: arming matches no mode) and whether arming changed since the switch. */
export function currentMode(view: HubState): {
  readonly mode: ModeId | null;
  readonly modified: boolean;
} {
  return { mode: view.layout.current, modified: view.layout.modified };
}

/** Every mode and every group as section 6's replies carry them, by id, for the snapshot (section 5). */
export function modeObjects(view: HubState): readonly ReturnType<typeof modeObject>[] {
  return [...view.layout.modes.values()].toSorted((a, b) => a.id - b.id).map(modeObject);
}

export function groupObjects(view: HubState): readonly ReturnType<typeof groupObject>[] {
  return [...view.layout.groups.values()].toSorted((a, b) => a.id - b.id).map(groupObject);
}

export function layoutModes(view: HubState): readonly Mode[] {
  return [...view.layout.modes.values()];
}

export function layoutGroups(view: HubState): readonly Group[] {
  return [...view.layout.groups.values()];
}

export function modeById(view: HubState, id: ModeId): Mode | undefined {
  return view.layout.modes.get(id);
}

export function groupById(view: HubState, id: GroupId): Group | undefined {
  return view.layout.groups.get(id);
}

/** The groups a sensor is in (a sensor may be in several, D74). */
export function groupsOf(view: HubState, sensor: DeviceId): readonly Group[] {
  return [...view.layout.groups.values()].filter((group) => group.sensors.includes(sensor));
}

/**
 * The sirens a trigger of `sensor` sounds (AL2a, D41, D74; m2-design.md section 7): those of
 * every group it is in, `"all"` when it is in none or one of them sounds every siren; "every
 * siren" is every siren paired at the time of the alarm, which the alarm module takes; a list
 * left empty counts as every siren.
 */
export function triggerSirens(view: HubState, sensor: DeviceId): readonly DeviceId[] | "all" {
  const groups = groupsOf(view, sensor);
  // A list left empty sounds every siren too, so no group can silently sound nothing (section 7).
  const every = (group: Group) => group.allSirens || group.sirens.length === 0;
  if (groups.length === 0 || groups.some(every)) return "all";
  return [...new Set(groups.flatMap((group) => group.sirens))];
}

/** Whether a group exists, for a schedule entry's target (section 7, "Schedules"). */
export function groupExists(view: HubState, id: GroupId): boolean {
  return view.layout.groups.has(id);
}

/** Whether a mode exists, the fixed ones included, for a schedule entry's target. */
export function modeExists(view: HubState, id: ModeId): boolean {
  return view.layout.modes.has(id);
}

/** What HB5a's check asks about: a switch, or an arm or disarm of a group. */
export type ChangeTarget =
  | { readonly kind: "mode"; readonly mode: ModeId }
  | { readonly kind: "arm"; readonly group: GroupId }
  | { readonly kind: "disarm"; readonly group: GroupId };

/**
 * The sensors whose arm state a request would change, for HB5a's check (m2-design.md section 7;
 * section 11, "Step 1's questions, settled"): a switch's, those it would arm or disarm; a group's
 * arm, its disarmed members; its disarm, its armed members (either waiting state included).
 * Undefined when there is no such mode or group. A sensor target and `mine` need none.
 */
export function sensorsChanged(
  view: HubState,
  target: ChangeTarget,
): readonly DeviceId[] | undefined {
  const slice = view.layout;
  if (target.kind === "disarm") {
    const group = slice.groups.get(target.group);
    return group === undefined ? undefined : disarmingPlan(view, group.sensors, false).toDisarm;
  }
  const mode = target.kind === "mode" ? slice.modes.get(target.mode) : undefined;
  const group = target.kind === "arm" ? slice.groups.get(target.group) : undefined;
  if (mode === undefined && group === undefined) return undefined;
  const plan = armingPlan(view, {
    sensors:
      mode === undefined
        ? alarmSensors(view).filter((s) => group?.sensors.includes(s) === true)
        : modeSensors(view, slice, mode),
    switching: mode !== undefined,
    confirm: undefined,
    asks: false,
    holdBack: false,
  });
  return plan.kind === "go" ? [...plan.toArm, ...plan.toDisarm] : [];
}

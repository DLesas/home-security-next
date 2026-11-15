/**
 * Requests resolved to sensors (m2-design.md section 7, "Modes, groups and arming"; D74, D90):
 * a switch to a mode becomes the mode's sensors, Away every sensor (including ungrouped ones and
 * any added since) and Disarmed none; an arm or disarm of a group becomes its members, of a
 * sensor that sensor; a disarm of "mine" every sensor the person may manage (D51, D76).
 */
import { alarmSensors, armedForUser } from "../alarm/view.ts";
import { type DeviceId, deviceId, groupId, modeId } from "../model/ids.ts";
import type { Actor, Confirmation, DomainMessage } from "../model/messages.ts";
import { ModeFixed } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { mayManage } from "../people/view.ts";
import type { LayoutSlice, Mode } from "./state.ts";

type OpRequest = Extract<DomainMessage, { readonly kind: "opRequest" }>;

/** The arming operations layout resolves; its other operations are configuration. */
export type ArmingOp = Extract<OpRequest["op"], { readonly op: "mode.switch" | "arm" | "disarm" }>;

/** What an arming operation names, in sensors. */
export type Resolved =
  | {
      readonly kind: "arm";
      readonly sensors: readonly DeviceId[];
      /** Set for a switch to this mode. */
      readonly mode: Mode | undefined;
      readonly confirm: Confirmation | undefined;
    }
  | {
      readonly kind: "disarm";
      readonly sensors: readonly DeviceId[];
      /** `"mine"`: every sensor the person may manage, so it needs no permission of its own. */
      readonly mine: boolean;
    }
  | { readonly kind: "notFound"; readonly what: "mode" | "group" | "device"; readonly id: number };

export function isArmingOp(op: OpRequest["op"]): op is ArmingOp {
  return op.op === "mode.switch" || op.op === "arm" || op.op === "disarm";
}

/** The sensors of a mode, in the alarm's order (D74, D90). */
export function modeSensors(view: HubState, slice: LayoutSlice, mode: Mode): readonly DeviceId[] {
  switch (mode.fixed) {
    case ModeFixed.Away:
      return alarmSensors(view);
    case ModeFixed.Disarmed:
      return [];
    default: {
      const held = new Set(mode.groups.flatMap((g) => slice.groups.get(g)?.sensors ?? []));
      return alarmSensors(view).filter((sensor) => held.has(sensor));
    }
  }
}

/**
 * A disarm of "mine" (D51, D76): every armed sensor the actor may manage, by `people`'s
 * permissions (section 7; while user management is off, every one, D13).
 */
function mine(view: HubState, actor: Actor): readonly DeviceId[] {
  return alarmSensors(view).filter(
    (sensor) => armedForUser(view, sensor) && mayManage(view, actor, sensor),
  );
}

/** A group's members that are sensors of the alarm's, in the alarm's order. */
function members(view: HubState, sensors: readonly DeviceId[]): readonly DeviceId[] {
  const held = new Set(sensors);
  return alarmSensors(view).filter((sensor) => held.has(sensor));
}

/** One target: a group's members, or a sensor the alarm knows. */
function target(
  view: HubState,
  slice: LayoutSlice,
  named: { readonly group: number } | { readonly sensor: number },
): readonly DeviceId[] | Extract<Resolved, { readonly kind: "notFound" }> {
  if ("group" in named) {
    const group = slice.groups.get(groupId(named.group));
    return group === undefined
      ? { kind: "notFound", what: "group", id: named.group }
      : members(view, group.sensors);
  }
  const sensor = deviceId(named.sensor);
  return alarmSensors(view).includes(sensor)
    ? [sensor]
    : { kind: "notFound", what: "device", id: named.sensor };
}

/** An arming operation in sensors, or what it named that does not exist. */
export function resolve(view: HubState, slice: LayoutSlice, op: ArmingOp, actor: Actor): Resolved {
  switch (op.op) {
    case "mode.switch": {
      const mode = slice.modes.get(modeId(op.body.mode));
      return mode === undefined
        ? { kind: "notFound", what: "mode", id: op.body.mode }
        : {
            kind: "arm",
            sensors: modeSensors(view, slice, mode),
            mode,
            confirm: op.body.confirm,
          };
    }
    case "arm": {
      const sensors = target(view, slice, op.body.target);
      return "kind" in sensors
        ? sensors
        : { kind: "arm", sensors, mode: undefined, confirm: op.body.confirm };
    }
    case "disarm": {
      const named = op.body.target;
      if (named === "mine") {
        return { kind: "disarm", sensors: mine(view, actor), mine: true };
      }
      const sensors = target(view, slice, named);
      return "kind" in sensors ? sensors : { kind: "disarm", sensors, mine: false };
    }
  }
}

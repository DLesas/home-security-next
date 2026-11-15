/**
 * What an arming or disarming request will do, decided from the alarm's slice and the health
 * module's low batteries (hub-design.md section 8, "Arming and the countdown"; m2-design.md section 7, "Modes, groups and
 * arming"; D50, D74, D109, D117, AL7, AL12). The alarm acts on exactly this plan, and the layout
 * module reads it through the alarm's view before the alarm acts: a mode switch is recorded, and
 * `mode_state` written, only when the switch will be made, never for one the alarm refuses
 * (`needsConfirmation`). Both read the same slice in the same step, so they cannot disagree.
 */
import type { DeviceId } from "../model/ids.ts";
import type { Confirmation, DomainMessage } from "../model/messages.ts";
import { ArmState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { batteryLow } from "../health/view.ts";
import type { AlarmSlice } from "./state.ts";

/** An arming request as the alarm takes it. */
export interface ArmingAsk {
  /**
   * The sensors to arm; for a switch, the mode's sensors, every other armed sensor being disarmed
   * (D74: "switching to a mode arms exactly that mode's sensors and disarms the rest").
   */
  readonly sensors: readonly DeviceId[];
  readonly switching: boolean;
  /** What the request confirmed (D50, AL12); undefined: nothing. */
  readonly confirm: Confirmation | undefined;
  /** False for a schedule, which never asks and arms anyway (AL7, AL12). */
  readonly asks: boolean;
  /** A schedule's switch leaves its triggers and counting sensors armed (D117). */
  readonly holdBack: boolean;
}

/** The question an `armSensors` message asks; the layout module asks the same before it. */
export function armingAskOf(
  message: Pick<
    Extract<DomainMessage, { readonly kind: "armSensors" }>,
    "sensors" | "mode" | "confirm" | "actor"
  >,
): ArmingAsk {
  const schedule = message.actor.kind === "schedule";
  return {
    sensors: message.sensors,
    switching: message.mode !== undefined,
    confirm: message.confirm,
    asks: !schedule,
    holdBack: schedule,
  };
}

/**
 * The question `hsn arm <sensor>…` asks (hub-design.md section 8, "Arm"): `--continue` confirms
 * open doors (D50); a battery is never asked of the hub computer, since `hsn arm` cannot confirm
 * one and M1a never asked.
 */
export function armRequestAsk(sensors: readonly DeviceId[], continueOpen: boolean): ArmingAsk {
  return {
    sensors,
    switching: false,
    confirm: { openDoors: continueOpen, lowBattery: true },
    asks: true,
    holdBack: false,
  };
}

/** What an arming request will do. */
export type ArmingPlan =
  /** Ids that are no sensor of the alarm's: refused, nothing changes. */
  | { readonly kind: "unknown"; readonly sensors: readonly DeviceId[] }
  /** Open doors or low batteries not confirmed: refused, naming each, nothing changes. */
  | {
      readonly kind: "needsConfirmation";
      readonly openDoors: readonly DeviceId[];
      readonly lowBattery: readonly DeviceId[];
    }
  | {
      readonly kind: "go";
      /** Disarmed sensors armed now, in the request's order. */
      readonly toArm: readonly DeviceId[];
      /** Those of `toArm` whose door is open: they wait for it to close (D50). */
      readonly open: readonly DeviceId[];
      /** Low batteries armed anyway, confirmed or by a schedule (AL12). */
      readonly lowBattery: readonly DeviceId[];
      /** Armed sensors a switch disarms. */
      readonly toDisarm: readonly DeviceId[];
      /** Armed sensors a schedule's switch leaves armed (D117). */
      readonly heldBack: readonly DeviceId[];
    };

/** A disarming request's plan. */
export interface DisarmingPlan {
  readonly unknown: readonly DeviceId[];
  /** Armed sensors (either waiting state included) disarmed now, in the request's order. */
  readonly toDisarm: readonly DeviceId[];
  /** Armed sensors a schedule's disarm leaves armed: triggers and counting sensors (D117). */
  readonly heldBack: readonly DeviceId[];
}

/** Sensors a schedule may not disarm while the alarm or their countdown runs (D117). */
function runningSensors(slice: AlarmSlice): ReadonlySet<DeviceId> {
  return new Set([...slice.countdowns.keys(), ...(slice.alarm?.triggers.keys() ?? [])]);
}

function isDisarmed(slice: AlarmSlice, sensor: DeviceId): boolean {
  return (slice.sensors.get(sensor)?.arm ?? ArmState.Disarmed) === ArmState.Disarmed;
}

/**
 * What arming `ask.sensors` will do (section 8, "Arm"; D50, D74, AL7, AL12). A disarmed sensor
 * is armed; one whose newest status showed its door open, or whose battery the health module holds
 * low, makes the request ask for confirmation unless it was given (a schedule never
 * asks); confirmed, an open door waits for it to close, a low battery is armed. A sensor already
 * armed, or waiting for its door, is untouched (no new settings version, HD 8). A switch also
 * disarms every armed sensor outside the mode, a schedule's holding back its triggers and counting
 * sensors (D117).
 */
export function planArming(slice: AlarmSlice, view: HubState, ask: ArmingAsk): ArmingPlan {
  const unknown = ask.sensors.filter((id) => !slice.sensors.has(id));
  if (unknown.length > 0) return { kind: "unknown", sensors: unknown };
  const named = new Set(ask.sensors);
  const toArm = [...named].filter((id) => isDisarmed(slice, id));
  const open = toArm.filter((id) => slice.sensors.get(id)?.doorNow === true);
  // The health module's low-battery state, raised at 10% or below (HB33; D109, AL12).
  const lowBattery = toArm.filter((id) => batteryLow(view, id));
  const confirm = ask.confirm ?? { openDoors: false, lowBattery: false };
  const unconfirmed =
    (open.length > 0 && !confirm.openDoors) || (lowBattery.length > 0 && !confirm.lowBattery);
  if (ask.asks && unconfirmed) {
    return { kind: "needsConfirmation", openDoors: open, lowBattery };
  }
  const outside = ask.switching
    ? [...slice.sensors.keys()].filter((id) => !named.has(id) && !isDisarmed(slice, id))
    : [];
  const running = ask.holdBack ? runningSensors(slice) : new Set<DeviceId>();
  return {
    kind: "go",
    toArm,
    open,
    lowBattery,
    toDisarm: outside.filter((id) => !running.has(id)),
    heldBack: outside.filter((id) => running.has(id)),
  };
}

/**
 * What disarming `sensors` will do (section 8, "Disarm"; D95, D117): every armed one is disarmed,
 * either waiting state included; a schedule's disarm leaves the alarm's triggers and the sensors
 * counting down armed (D117).
 */
export function planDisarming(
  slice: AlarmSlice,
  sensors: readonly DeviceId[],
  holdBack: boolean,
): DisarmingPlan {
  const unknown = sensors.filter((id) => !slice.sensors.has(id));
  const armed = [...new Set(sensors)].filter(
    (id) => slice.sensors.has(id) && !isDisarmed(slice, id),
  );
  const running = holdBack ? runningSensors(slice) : new Set<DeviceId>();
  return {
    unknown,
    toDisarm: armed.filter((id) => !running.has(id)),
    heldBack: armed.filter((id) => running.has(id)),
  };
}

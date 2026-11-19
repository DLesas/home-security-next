/**
 * Read-only selectors over the alarm module's slice that other modules may use (hub-design.md
 * section 2): the sensors module for its replies and `sensor_config` rows, the sirens module for
 * what each siren should do, the site module for whether a switch must wait, and the control
 * module for `hsn status` (section 9); and, in M2, the layout module for what an arming request
 * will do (m2-design.md section 7).
 */
import type { SirenShould } from "../model/messages.ts";
import type { BootId, DeviceId } from "../model/ids.ts";
import { ArmState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import type { Mono } from "../model/time.ts";
import {
  type ArmingAsk,
  type ArmingPlan,
  type DisarmingPlan,
  planArming,
  planDisarming,
} from "./plan.ts";
import type { SirenRestore } from "./state.ts";
import { secondsUntil } from "./time.ts";

export {
  type ArmingAsk,
  type ArmingPlan,
  armingAskOf,
  armRequestAsk,
  type DisarmingPlan,
} from "./plan.ts";
export { actorText } from "./out.ts";
export { DOORS_OPEN_MESSAGE } from "./commands.ts";

/**
 * What an arming request will do, as the alarm will do it in this step (`plan.ts`): the layout
 * module asks it first, and records a mode switch, and changes `mode_state`, only for a plan the
 * alarm will carry out (m2-design.md section 7; section 11, "Step 1's questions, settled").
 */
export function armingPlan(view: HubState, ask: ArmingAsk): ArmingPlan {
  return planArming(view.alarm, view, ask);
}

/** What a disarming request will do, as the alarm will do it in this step (`plan.ts`). */
export function disarmingPlan(
  view: HubState,
  sensors: readonly DeviceId[],
  holdBack: boolean,
): DisarmingPlan {
  return planDisarming(view.alarm, sensors, holdBack);
}

/** The sensors whose entry countdown runs (AL3): the ones a disarm cancels with the notice (D24). */
export function countingSensors(view: HubState): readonly DeviceId[] {
  return [...view.alarm.countdowns.keys()];
}

/** A sensor's arming state (section 8), or undefined for a device that is no sensor. */
export function armState(view: HubState, sensor: DeviceId): ArmState | undefined {
  return view.alarm.sensors.get(sensor)?.arm;
}

/** When a sensor was armed, for its `sensor_config` row (section 6); null while disarmed. */
export function armedSince(
  view: HubState,
  sensor: DeviceId,
): { readonly boot: BootId | null; readonly mono: Mono | null } | undefined {
  const arming = view.alarm.sensors.get(sensor);
  return arming === undefined ? undefined : { boot: arming.armedBoot, mono: arming.armedMono };
}

/** Whether this sensor has a running entry countdown. */
export function countdownRunning(view: HubState, sensor: DeviceId): boolean {
  return view.alarm.countdowns.has(sensor);
}

/**
 * Armed as the user sees it: both waiting states count as armed (section 8), for `hsn status` and
 * for what is critical while armed (D52, D82, D107).
 */
export function armedForUser(view: HubState, sensor: DeviceId): boolean {
  const arm = armState(view, sensor);
  return arm !== undefined && arm !== ArmState.Disarmed;
}

/** Whether any sensor is armed as the user sees it. */
export function anySensorArmed(view: HubState): boolean {
  return [...view.alarm.sensors.values()].some((arming) => arming.arm !== ArmState.Disarmed);
}

/**
 * What a reply to `sensor` says of its arming (§6, Reply; section 8): "armed" only when fully
 * armed, since a sensor never buzzes for a door the hub ignores; the countdown, with its whole
 * seconds left, while one runs.
 */
export function replyArming(
  view: HubState,
  sensor: DeviceId,
  now: Mono,
): { readonly armed: boolean; readonly countdownStarted: boolean; readonly secondsLeft: number } {
  const countdown = view.alarm.countdowns.get(sensor);
  return {
    armed: armState(view, sensor) === ArmState.Armed,
    countdownStarted: countdown !== undefined,
    secondsLeft: countdown === undefined ? 0 : secondsUntil(now, countdown.deadline),
  };
}

/** The newest accepted report of a running countdown's opening: the notice's binding (§4). */
export function countdownNewestCounter(view: HubState, sensor: DeviceId): number | undefined {
  return view.alarm.countdowns.get(sensor)?.newestCounter;
}

/** Whether a countdown or the alarm runs: a site move's switch waits for it (D115). */
export function countdownOrAlarmRunning(view: HubState): boolean {
  return view.alarm.countdowns.size > 0 || view.alarm.alarm !== undefined;
}

/** Every sensor this module knows. */
export function alarmSensors(view: HubState): readonly DeviceId[] {
  return [...view.alarm.sensors.keys()];
}

/**
 * What a siren should do now (section 8, "What the siren should do"): sounding for the alarm until
 * its time, testing until the test's end, or off. Time running out simply makes it off. A siren
 * of a restored alarm that reported off while the downtime is unknown should be off (D113).
 */
export function sirenShould(view: HubState, siren: DeviceId, now: Mono): SirenShould {
  const entry = view.alarm.alarm?.sirens.get(siren);
  if (entry !== undefined && entry.until > now && entry.restore !== "cutShort") {
    return { kind: "sound", until: entry.until };
  }
  const test = view.alarm.tests.get(siren);
  if (test !== undefined && test > now) return { kind: "test", until: test };
  return { kind: "off" };
}

/**
 * Whether the correction rule may command a siren (section 8, "Correcting a siren"): not while a
 * restored alarm waits to hear whether it still sounds, with the downtime unknown (D113).
 */
export function sirenCorrectable(view: HubState, siren: DeviceId): boolean {
  const restore: SirenRestore | undefined = view.alarm.alarm?.sirens.get(siren)?.restore;
  return restore !== "awaitReport" && restore !== "cutShort";
}

/** The alarm for `hsn status`: when it started, its triggers and its sirens (section 9). */
export function alarmSummary(view: HubState):
  | {
      readonly startedAt: Mono;
      readonly triggers: readonly DeviceId[];
      readonly sirens: readonly DeviceId[];
    }
  | undefined {
  const run = view.alarm.alarm;
  return run === undefined
    ? undefined
    : {
        startedAt: run.startedAt,
        triggers: [...run.triggers.keys()],
        sirens: [...run.sirens.keys()],
      };
}

/** A sensor's line of `hsn status` (section 9): arming as shown, door, countdown left. */
export function sensorSummary(
  view: HubState,
  sensor: DeviceId,
  now: Mono,
):
  | {
      readonly arm: "disarmed" | "armed" | "waitsForDoorToClose";
      readonly door: "open" | "closed" | "unknown";
      readonly countdownSecondsLeft: number | null;
    }
  | undefined {
  const arming = view.alarm.sensors.get(sensor);
  if (arming === undefined) return undefined;
  const countdown = view.alarm.countdowns.get(sensor);
  const arm =
    arming.arm === ArmState.Disarmed
      ? "disarmed"
      : arming.arm === ArmState.Armed
        ? "armed"
        : "waitsForDoorToClose";
  const door = arming.doorNow === undefined ? "unknown" : arming.doorNow ? "open" : "closed";
  return {
    arm,
    door,
    countdownSecondsLeft: countdown === undefined ? null : secondsUntil(now, countdown.deadline),
  };
}

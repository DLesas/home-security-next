/**
 * M1a's answers to `hsn arm --all` and `hsn disarm --all` (hub-design.md section 9), which travel
 * as switches to Away and Disarmed (m2-design.md section 1). The alarm answers every arming one
 * way, with `opAnswer` and section 6's body; control turns that into the reply `hsn arm` and
 * `hsn disarm` have always given, so the CLI and the recorded sessions see no change (section 11,
 * "Step 1's questions, settled").
 */
import {
  alarmSensors,
  alarmSummary,
  armState,
  countingSensors,
  DOORS_OPEN_MESSAGE,
} from "../alarm/view.ts";
import type { ControlReply } from "../model/control.ts";
import { type DeviceId, deviceId } from "../model/ids.ts";
import type { OpOutcome } from "../model/messages.ts";
import { ArmState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { deviceById } from "../registry/view.ts";
import type { AlarmBefore } from "./state.ts";

function names(view: HubState, ids: readonly DeviceId[]): string[] {
  return ids.flatMap((id) => deviceById(view, id)?.name ?? []);
}

/** The alarm as a switch finds it, taken as the switch passes on its way to the alarm. */
export function alarmBefore(view: HubState): AlarmBefore {
  return {
    armed: alarmSensors(view).filter((id) => armState(view, id) !== ArmState.Disarmed),
    counting: countingSensors(view),
    alarm: alarmSummary(view) !== undefined,
  };
}

/** A refusal as M1a gave it: an open door named (D50), or a sensor that is not one. */
function refused(view: HubState, outcome: Extract<OpOutcome, { ok: false }>): ControlReply {
  const { error } = outcome;
  if (error.code === "needsConfirmation") {
    return {
      ok: false,
      error: {
        code: "doorsOpen",
        message: DOORS_OPEN_MESSAGE,
        names: names(view, error.detail.openDoors.map(deviceId)),
      },
    };
  }
  if (error.code === "notFound") {
    return { ok: false, error: { code: "unknownDevice", message: "not a sensor" } };
  }
  return { ok: false, error: { code: "failed", message: error.code } };
}

/** `hsn arm --all`'s answer, from the alarm as the switch left it: armed, and waiting. */
export function armAllReply(view: HubState, outcome: OpOutcome): ControlReply {
  if (!outcome.ok) return refused(view, outcome);
  const ids = alarmSensors(view);
  const inState = (...states: readonly ArmState[]) =>
    names(
      view,
      ids.filter((id) => {
        const arm = armState(view, id);
        return arm !== undefined && states.includes(arm);
      }),
    );
  return {
    ok: true,
    result: {
      kind: "arm",
      armed: inState(ArmState.Armed),
      waitsForDoorToClose: [
        ...inState(ArmState.WaitsForCloseAfterArming),
        ...inState(ArmState.WaitsForCloseAfterAlarm),
      ],
    },
  };
}

/**
 * `hsn disarm --all`'s answer: the sensors it disarmed, the countdowns it cancelled (D24), and
 * whether it ended the alarm (D95), from the alarm before and after the switch.
 */
export function disarmAllReply(
  view: HubState,
  before: AlarmBefore | undefined,
  outcome: OpOutcome,
): ControlReply {
  if (!outcome.ok) return refused(view, outcome);
  const disarmed = (before?.armed ?? []).filter((id) => armState(view, id) === ArmState.Disarmed);
  const counting = new Set(before?.counting ?? []);
  return {
    ok: true,
    result: {
      kind: "disarm",
      disarmed: names(view, disarmed),
      countdownsCancelled: names(
        view,
        disarmed.filter((id) => counting.has(id)),
      ),
      alarmEnded: before?.alarm === true && alarmSummary(view) === undefined,
    },
  };
}

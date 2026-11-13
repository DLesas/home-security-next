/**
 * `hsn arm`, `hsn disarm` and `hsn siren test` (hub-design.md sections 8 and 9; D24, D50, D65,
 * D74, D95, AL3, AL7, AL8, AL11). Each change goes out before the answer, in the same step, so the
 * state it depends on is committed before the CLI is told (section 4).
 * The decisions each causes name the command's `commands` record as their cause (D110), and
 * the actor in their detail.
 */
import { ok } from "neverthrow";
import type { ControlError, ControlReply } from "../model/control.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { DomainMessage } from "../model/messages.ts";
import { ArmState } from "../model/rows.ts";
import { deviceById } from "../registry/view.ts";
import { sirenIds, sirenName } from "../sirens/view.ts";
import { endAlarm, waitForClose } from "./alarm.ts";
import { setArm } from "./arm-state.ts";
import { actorDetail, type Changing, decide, each, then, unchanged, writeNow } from "./out.ts";
import type { AlarmSlice } from "./state.ts";
import { afterSeconds } from "./time.ts";

type Request<K extends DomainMessage["kind"]> = Extract<DomainMessage, { readonly kind: K }>;

/**
 * A test's length when `hsn siren test` names none. SPEC-QUESTION: D65 and SR9 say only "a short
 * test"; 5 s ‡ is the protocol vectors' test command (siren-command.json, action 2).
 */
export const SIREN_TEST_DEFAULT_S = 5;

function answer(
  slice: AlarmSlice,
  request: Request<"armRequest">["request"],
  reply: ControlReply,
): Changing {
  return ok({ slice, out: [{ kind: "answer", request, reply }] });
}

function refuse(
  slice: AlarmSlice,
  request: Request<"armRequest">["request"],
  error: ControlError,
): Changing {
  return answer(slice, request, { ok: false, error });
}

/** The sensors a request names, or the ids that are no sensor of this module. */
function selected(
  slice: AlarmSlice,
  selection: Request<"armRequest">["sensors"],
): { readonly ids: readonly DeviceId[]; readonly unknown: readonly DeviceId[] } {
  const ids = selection === "all" ? [...slice.sensors.keys()] : selection;
  return { ids, unknown: ids.filter((id) => !slice.sensors.has(id)) };
}

/** The sensors' names, from the registry, which owns them. */
function names(ctx: Context, ids: readonly DeviceId[]): string[] {
  return ids.flatMap((id) => deviceById(ctx.view, id)?.name ?? []);
}

const UNKNOWN_SENSOR: ControlError = { code: "unknownDevice", message: "not a sensor" };

/**
 * Arms the named sensors (section 8, "Arm"). A disarmed sensor whose last known door state is open
 * is named and the command stops, unless `continueOpen`; with it, that sensor waits for its door
 * to close (D50, AL7). Arming adds to what is armed (D74); every sensor armed records when.
 */
export function onArmRequest(
  slice: AlarmSlice,
  ctx: Context,
  request: Request<"armRequest">,
): Changing {
  const { ids, unknown } = selected(slice, request.sensors);
  if (unknown.length > 0) return refuse(slice, request.request, UNKNOWN_SENSOR);
  const toArm = ids.filter((id) => slice.sensors.get(id)?.arm === ArmState.Disarmed);
  const open = toArm.filter((id) => slice.sensors.get(id)?.doorNow === true);
  if (open.length > 0 && !request.continueOpen) {
    return refuse(slice, request.request, {
      code: "doorsOpen",
      message: "a door is open; arm with --continue to arm it when it closes",
      names: names(ctx, open),
    });
  }
  const armed = each(slice, toArm, (current, sensor) =>
    decide(ctx, "routine", {
      kind: "armed",
      device: sensor,
      cause: request.record,
      detail: actorDetail(request.actor),
    }).andThen(({ seq, message }): Changing => {
      const arming = current.sensors.get(sensor);
      if (arming === undefined) return unchanged(current);
      const changed = setArm(current, sensor, arming, ArmState.Armed, seq, ctx.now.mono);
      const result = ok({ slice: changed.slice, out: [message, ...changed.out] });
      return open.includes(sensor)
        ? then(result, (s) => waitForClose(s, ctx, sensor, ArmState.WaitsForCloseAfterArming, seq))
        : result;
    }),
  );
  return then(armed, (current) => {
    const inState = (state: ArmState) =>
      names(
        ctx,
        ids.filter((id) => current.sensors.get(id)?.arm === state),
      );
    return answer(current, request.request, {
      ok: true,
      result: {
        kind: "arm",
        armed: inState(ArmState.Armed),
        waitsForDoorToClose: [
          ...inState(ArmState.WaitsForCloseAfterArming),
          ...inState(ArmState.WaitsForCloseAfterAlarm),
        ],
      },
    });
  });
}

/**
 * Disarms the named sensors (section 8, "Disarm"). A running countdown of a disarmed sensor is
 * cancelled, and the sensors module sends the disarmed notice twice (D24). The alarm ends only
 * when every trigger is disarmed, and its sirens are then commanded off; otherwise they sound on
 * to their automatic stop (D95, AL11).
 */
export function onDisarmRequest(
  slice: AlarmSlice,
  ctx: Context,
  request: Request<"disarmRequest">,
): Changing {
  const { ids, unknown } = selected(slice, request.sensors);
  if (unknown.length > 0) return refuse(slice, request.request, UNKNOWN_SENSOR);
  const toDisarm = ids.filter((id) => slice.sensors.get(id)?.arm !== ArmState.Disarmed);
  const cancelled = toDisarm.filter((id) => slice.countdowns.has(id));
  const disarmed = each(slice, toDisarm, (current, sensor) =>
    decide(ctx, "routine", {
      kind: "disarmed",
      device: sensor,
      cause: request.record,
      detail: actorDetail(request.actor),
    }).andThen(({ seq, message }): Changing => {
      const arming = current.sensors.get(sensor);
      if (arming === undefined) return unchanged(current);
      const changed = setArm(current, sensor, arming, ArmState.Disarmed, seq, null);
      const countdown = current.countdowns.get(sensor);
      if (countdown === undefined) {
        return ok({ slice: changed.slice, out: [message, ...changed.out] });
      }
      const countdowns = new Map(changed.slice.countdowns);
      countdowns.delete(sensor);
      return ok({
        slice: { ...changed.slice, countdowns },
        out: [
          message,
          ...changed.out,
          writeNow({ table: "countdowns", op: "delete", key: { sensorId: sensor } }),
          {
            kind: "countdownCancelled",
            sensor,
            newestCounter: countdown.newestCounter,
            replyGateway: countdown.replyGateway,
            replyRate: countdown.replyRate,
            cause: seq,
          },
        ],
      });
    }),
  );
  return then(disarmed, (current) => {
    const run = current.alarm;
    const allDisarmed =
      run !== undefined &&
      [...run.triggers.keys()].every(
        (sensor) => (current.sensors.get(sensor)?.arm ?? ArmState.Disarmed) === ArmState.Disarmed,
      );
    const ended = allDisarmed
      ? endAlarm(current, ctx, "disarmed", request.record)
      : unchanged(current);
    return then(ended, (s) =>
      answer(s, request.request, {
        ok: true,
        result: {
          kind: "disarm",
          disarmed: names(ctx, toDisarm),
          countdownsCancelled: names(ctx, cancelled),
          alarmEnded: allDisarmed,
        },
      }),
    );
  });
}

/**
 * A short test of one siren (D65, SR9): what it should do becomes "testing" until the test's end,
 * which then simply passes (section 8). Refused while the alarm sounds that siren.
 */
export function onSirenTestRequest(
  slice: AlarmSlice,
  ctx: Context,
  request: Request<"sirenTestRequest">,
): Changing {
  const { siren } = request;
  const name = sirenName(ctx.view, siren);
  if (name === undefined || !sirenIds(ctx.view).includes(siren)) {
    return refuse(slice, request.request, { code: "unknownDevice", message: "not a siren" });
  }
  const now = ctx.now.mono;
  const sounding = slice.alarm?.sirens.get(siren);
  if (sounding !== undefined && sounding.until > now) {
    return refuse(slice, request.request, { code: "failed", message: "the alarm is sounding it" });
  }
  const seconds = request.seconds ?? SIREN_TEST_DEFAULT_S;
  const until = afterSeconds(now, seconds);
  const tests = new Map([...slice.tests].filter(([, end]) => end > now)).set(siren, until);
  return ok({
    slice: { ...slice, tests },
    out: [
      { kind: "sirenIntent", siren, should: { kind: "test", until }, cause: request.record },
      {
        kind: "answer",
        request: request.request,
        reply: { ok: true, result: { kind: "sirenTest", name, seconds } },
      },
    ],
  });
}

/**
 * Arming and disarming requests and `hsn siren test` (hub-design.md sections 8 and 9;
 * m2-design.md sections 1 and 7; D24, D50, D65, D74, D95, D109, D117, AL3, AL7, AL8, AL11, AL12).
 *
 * M1a's `hsn arm <sensor>…` and `hsn disarm <sensor>…` arrive as `armRequest` and
 * `disarmRequest`; M2's requests arrive from the layout module already resolved to sensors, as
 * `armSensors` (a mode switch, a group, a sensor) and `disarmSensors`, with the actor and what was
 * confirmed. Every one is decided by its plan (`plan.ts`) and then made with the same per-sensor
 * steps, so a switch to Away arms exactly as `hsn arm --all` did and a switch to Disarmed
 * disarms exactly as `hsn disarm --all` did. Each change goes out before the answer, in the same
 * step, so the state it depends on is committed before anyone is told (section 4). The decisions
 * each causes name the request's `commands` record as their cause (D110), and the actor in their
 * detail.
 */
import { ok } from "neverthrow";
import type { ControlError, ControlReply } from "../model/control.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, Seq } from "../model/ids.ts";
import type { AnswerTo, DomainMessage, OpOutcome } from "../model/messages.ts";
import { ArmState } from "../model/rows.ts";
import { deviceById } from "../registry/view.ts";
import { sirenIds, sirenName } from "../sirens/view.ts";
import { endAlarm, waitForClose } from "./alarm.ts";
import { setArm } from "./arm-state.ts";
import {
  actorDetail,
  actorText,
  type Changing,
  decide,
  each,
  type Out,
  then,
  unchanged,
  writeNow,
} from "./out.ts";
import { armingAskOf, armRequestAsk, planArming, planDisarming } from "./plan.ts";
import type { AlarmSlice } from "./state.ts";
import { afterSeconds } from "./time.ts";

type Request<K extends DomainMessage["kind"]> = Extract<DomainMessage, { readonly kind: K }>;

/**
 * A test's length when `hsn siren test` names none. SPEC-QUESTION: D65 and SR9 say only "a short
 * test"; 5 s ‡ is the protocol vectors' test command (siren-command.json, action 2).
 */
export const SIREN_TEST_DEFAULT_S = 5;

/** `hsn arm`'s refusal for an open door without `--continue` (D50). */
export const DOORS_OPEN_MESSAGE = "a door is open; arm with --continue to arm it when it closes";

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

/** The ids an M1a request names: every sensor, or these. */
function idsOf(
  slice: AlarmSlice,
  selection: Request<"armRequest">["sensors"],
): readonly DeviceId[] {
  return selection === "all" ? [...slice.sensors.keys()] : selection;
}

/** The sensors' names, from the registry, which owns them. */
function names(ctx: Context, ids: readonly DeviceId[]): string[] {
  return ids.flatMap((id) => deviceById(ctx.view, id)?.name ?? []);
}

const UNKNOWN_SENSOR: ControlError = { code: "unknownDevice", message: "not a sensor" };

function doorsOpen(ctx: Context, open: readonly DeviceId[]): ControlError {
  return { code: "doorsOpen", message: DOORS_OPEN_MESSAGE, names: names(ctx, open) };
}

/**
 * Arms each of `toArm` (section 8, "Arm"): an `armed` decision with the actor, the new state
 * written by the sensors module on `armedChanged`; one of `open` then waits for its door to close
 * (D50, AL7). Every sensor armed records when (section 8).
 */
function armEach(
  slice: AlarmSlice,
  ctx: Context,
  toArm: readonly DeviceId[],
  open: readonly DeviceId[],
  record: Seq,
  actor: string,
): Changing {
  return each(slice, toArm, (current, sensor) =>
    decide(ctx, "routine", {
      kind: "armed",
      device: sensor,
      cause: record,
      detail: actorDetail(actor),
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
}

/**
 * Disarms each of `toDisarm` (section 8, "Disarm"): a `disarmed` decision with the actor; a
 * running countdown is cancelled, and the sensors module sends the disarmed notice twice (D24).
 */
function disarmEach(
  slice: AlarmSlice,
  ctx: Context,
  toDisarm: readonly DeviceId[],
  record: Seq,
  actor: string,
): Changing {
  return each(slice, toDisarm, (current, sensor) =>
    decide(ctx, "routine", {
      kind: "disarmed",
      device: sensor,
      cause: record,
      detail: actorDetail(actor),
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
}

/**
 * The alarm ends only when every trigger is disarmed, and its sirens are then commanded off;
 * otherwise they sound on to their automatic stop (D95, AL11).
 */
function endWhenDisarmed(slice: AlarmSlice, ctx: Context, record: Seq): Changing {
  const run = slice.alarm;
  const allDisarmed =
    run !== undefined &&
    [...run.triggers.keys()].every(
      (sensor) => (slice.sensors.get(sensor)?.arm ?? ArmState.Disarmed) === ArmState.Disarmed,
    );
  return allDisarmed ? endAlarm(slice, ctx, "disarmed", record) : unchanged(slice);
}

/** The triggers of a running alarm that are still armed: why it continues (D95). */
function armedTriggers(slice: AlarmSlice): readonly DeviceId[] {
  return [...(slice.alarm?.triggers.keys() ?? [])].filter(
    (sensor) => (slice.sensors.get(sensor)?.arm ?? ArmState.Disarmed) !== ArmState.Disarmed,
  );
}

/** `hsn arm`'s answer: the sensors named that are armed, and those waiting for their door. */
function armReply(slice: AlarmSlice, ctx: Context, ids: readonly DeviceId[]): ControlReply {
  const inState = (...states: readonly ArmState[]) =>
    names(
      ctx,
      ids.filter((id) => {
        const arm = slice.sensors.get(id)?.arm;
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
 * Arms the named sensors (section 8, "Arm"): `hsn arm <sensor>…`. A disarmed sensor whose last
 * known door state is open is named and the command stops, unless `continueOpen`; with it, that
 * sensor waits for its door to close (D50, AL7). Arming adds to what is armed (D74). The hub
 * computer is never asked about a battery (`armRequestAsk`).
 */
export function onArmRequest(
  slice: AlarmSlice,
  ctx: Context,
  request: Request<"armRequest">,
): Changing {
  const ids = idsOf(slice, request.sensors);
  const plan = planArming(slice, ctx.view, armRequestAsk(ids, request.continueOpen));
  if (plan.kind === "unknown") return refuse(slice, request.request, UNKNOWN_SENSOR);
  if (plan.kind === "needsConfirmation") {
    return refuse(slice, request.request, doorsOpen(ctx, plan.openDoors));
  }
  const armed = armEach(slice, ctx, plan.toArm, plan.open, request.record, request.actor);
  return then(armed, (current) => answer(current, request.request, armReply(current, ctx, ids)));
}

/**
 * Disarms the named sensors (section 8, "Disarm"): `hsn disarm <sensor>…`. A running countdown of
 * a disarmed sensor is cancelled with the disarmed notice twice (D24). The alarm ends only when
 * every trigger is disarmed (D95, AL11).
 */
export function onDisarmRequest(
  slice: AlarmSlice,
  ctx: Context,
  request: Request<"disarmRequest">,
): Changing {
  const ids = idsOf(slice, request.sensors);
  const plan = planDisarming(slice, ids, false);
  if (plan.unknown.length > 0) return refuse(slice, request.request, UNKNOWN_SENSOR);
  const cancelled = plan.toDisarm.filter((id) => slice.countdowns.has(id));
  const disarmed = disarmEach(slice, ctx, plan.toDisarm, request.record, request.actor);
  return then(disarmed, (current) => {
    const ended = endWhenDisarmed(current, ctx, request.record);
    return then(ended, (s) =>
      answer(s, request.request, {
        ok: true,
        result: {
          kind: "disarm",
          disarmed: names(ctx, plan.toDisarm),
          countdownsCancelled: names(ctx, cancelled),
          alarmEnded: current.alarm !== undefined && s.alarm === undefined,
        },
      }),
    );
  });
}

/**
 * An M2 request's answer, whoever asked: app, `hsn op` and `hsn`'s own `--all` (which control
 * turns into M1a's reply, hub-design.md section 9), or a schedule, which records its run from it
 * (m2-design.md section 11, "Step 1's questions, settled").
 */
function opAnswered(answerTo: AnswerTo, outcome: OpOutcome): Out {
  return [{ kind: "opAnswer", answerTo, outcome }];
}

function notFoundDevice(answerTo: AnswerTo, ids: readonly DeviceId[]): Out {
  return opAnswered(answerTo, {
    ok: false,
    error: { code: "notFound", detail: { what: "device", id: ids[0] ?? 0 } },
  });
}

/**
 * An arming request resolved to sensors by the layout module (m2-design.md section 7): a group or
 * a sensor adds to what is armed; a switch to a mode (`mode` set) arms exactly its sensors and
 * disarms the rest (D74), a schedule's holding back its triggers and counting sensors (D117), and
 * may end the alarm (D95). A person's request that would arm an open door or a low battery is
 * refused `needsConfirmation`, naming each, unless confirmed (D50, AL7, AL12); nothing changes.
 * Answered `{armed, disarmed, waiting, lowBattery}` (section 6): the sensors this request changed,
 * and the low batteries it armed, confirmed or by a schedule; a switch's also `heldBack`, the
 * sensors a schedule's switch left armed (D117), empty otherwise.
 */
export function onArmSensors(
  slice: AlarmSlice,
  ctx: Context,
  message: Request<"armSensors">,
): Changing {
  const { answerTo, record } = message;
  const plan = planArming(slice, ctx.view, armingAskOf(message));
  if (plan.kind === "unknown") {
    return ok({ slice, out: notFoundDevice(answerTo, plan.sensors) });
  }
  if (plan.kind === "needsConfirmation") {
    return ok({
      slice,
      out: opAnswered(answerTo, {
        ok: false,
        error: {
          code: "needsConfirmation",
          detail: { openDoors: plan.openDoors, lowBattery: plan.lowBattery },
        },
      }),
    });
  }
  const actor = actorText(message.actor);
  const armed = armEach(slice, ctx, plan.toArm, plan.open, record, actor);
  const disarmed = then(armed, (s) => disarmEach(s, ctx, plan.toDisarm, record, actor));
  // A switch may disarm the alarm's triggers; one with no sensor to arm is a full disarm, as
  // `hsn disarm --all` was. Arming alone never ends the alarm.
  const judged =
    message.mode !== undefined && (plan.toDisarm.length > 0 || message.sensors.length === 0)
      ? then(disarmed, (s) => endWhenDisarmed(s, ctx, record))
      : disarmed;
  return then(judged, (s) =>
    ok({
      slice: s,
      out: opAnswered(answerTo, {
        ok: true,
        body: {
          armed: plan.toArm.filter((id) => !plan.open.includes(id)),
          disarmed: plan.toDisarm,
          waiting: plan.open,
          lowBattery: plan.lowBattery,
          ...(message.mode === undefined ? {} : { heldBack: plan.heldBack }),
        },
      }),
    }),
  );
}

/**
 * A disarm resolved to sensors by the layout module (a group, a sensor, "mine"): each armed one is
 * disarmed, a running countdown cancelled with the notice twice (D24); the alarm ends only when
 * every trigger is then disarmed, and otherwise the answer names the triggers that remain (D95,
 * AL11). A schedule's disarm leaves the triggers and counting sensors armed (D117).
 */
export function onDisarmSensors(
  slice: AlarmSlice,
  ctx: Context,
  message: Request<"disarmSensors">,
): Changing {
  const { answerTo, record } = message;
  // D117's holding back follows the actor: a schedule's (step 1's questions, settled).
  const plan = planDisarming(slice, message.sensors, message.actor.kind === "schedule");
  if (plan.unknown.length > 0) return ok({ slice, out: notFoundDevice(answerTo, plan.unknown) });
  const disarmed = disarmEach(slice, ctx, plan.toDisarm, record, actorText(message.actor));
  const judged = then(disarmed, (s) => endWhenDisarmed(s, ctx, record));
  return then(judged, (s) => {
    const remaining = s.alarm === undefined ? [] : armedTriggers(s);
    return ok({
      slice: s,
      out: opAnswered(answerTo, {
        ok: true,
        body: {
          disarmed: plan.toDisarm,
          heldBack: plan.heldBack,
          alarmEnded: slice.alarm !== undefined && s.alarm === undefined,
          ...(s.alarm === undefined ? {} : { alarmContinues: { triggers: remaining } }),
        },
      }),
    });
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

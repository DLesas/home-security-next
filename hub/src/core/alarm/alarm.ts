/**
 * The alarm: its triggers and the sirens they sound (hub-design.md section 8, "Arming and the
 * countdown" and "What the siren should do"; D67, D74, D95, D114; AL2a, the sirens of each
 * trigger's groups, m2-design.md section 7). Every write here is "now", and
 * the alarm's rows are emitted before the `sirenIntent` that leads to a command, so the alarm is
 * committed before any siren command leaves (section 5).
 */
import { ok } from "neverthrow";
import type { Context } from "../model/handler.ts";
import type { DeviceId, Seq } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { type AlarmTriggerKind, ArmState } from "../model/rows.ts";
import { type Mono, mono } from "../model/time.ts";
import { triggerSirens } from "../layout/view.ts";
import { sirenIds, sirenMaxSoundS } from "../sirens/view.ts";
import { setArm } from "./arm-state.ts";
import { type Changing, decide, each, type Out, then, writeNow } from "./out.ts";
import type { AlarmRun, AlarmSiren, AlarmSlice } from "./state.ts";
import { afterSeconds, secondsUntil } from "./time.ts";

/** A new trigger: what set it off, and from when its sirens' automatic stop counts (D106). */
export interface NewTrigger {
  readonly sensor: DeviceId;
  readonly kind: AlarmTriggerKind;
  /** The countdown's end, or would-be end for a late report: the automatic stop counts from it. */
  readonly base: Mono;
  /** The record that caused it: the countdown's report, or the late report itself. */
  readonly cause: Seq;
  /** The decision that starts the alarm: `alarm`, or `late_report_sirens` with its seconds. */
  readonly starting: "alarm" | "late_report_sirens";
}

/** The alarm row and a siren's row, as written now (section 6). */
function alarmRows(slice: AlarmSlice, run: AlarmRun): Out {
  return [
    writeNow({
      table: "alarm",
      op: "upsert",
      row: { boot: slice.boot, startedMono: run.startedAt, causeSeq: run.cause },
    }),
  ];
}

/** A siren's row of the alarm (`alarm_sirens`, section 6), written now. */
export function sirenRow(slice: AlarmSlice, siren: DeviceId, entry: AlarmSiren): Out {
  return [
    writeNow({
      table: "alarm_sirens",
      op: "upsert",
      row: { sirenId: siren, boot: slice.boot, untilMono: entry.until, commanded: entry.commanded },
    }),
  ];
}

/** A trigger's row (`alarm_triggers`, section 6), written now. */
export function triggerRow(
  slice: AlarmSlice,
  sensor: DeviceId,
  kind: AlarmTriggerKind,
  at: Mono,
): Out {
  return [
    writeNow({
      table: "alarm_triggers",
      op: "upsert",
      row: { sensorId: sensor, kind, boot: slice.boot, atMono: at },
    }),
  ];
}

/**
 * Adds a trigger, starting the alarm if none runs. The trigger's sirens are those of every group
 * its sensor is in, every paired siren for a sensor in no group or in a group of every siren
 * (AL2a, D41, D74; m2-design.md section 7): with no groups, every siren, as before. Each of them
 * not yet in the alarm sounds until the base plus the automatic stop, never later than now plus
 * its longest sound (section 8); a siren already in it is not extended (D95, D114), so thirty
 * doors cost one command per siren.
 */
export function addTrigger(slice: AlarmSlice, ctx: Context, trigger: NewTrigger): Changing {
  const now = ctx.now.mono;
  const running = slice.alarm;
  if (running?.triggers.has(trigger.sensor) === true) return ok({ slice, out: [] });
  const stopAt = afterSeconds(trigger.base, slice.autoStopS);
  const secondsLeft = secondsUntil(now, stopAt);
  const kind = running === undefined ? trigger.starting : "alarm_trigger_added";
  return decide(ctx, "now", {
    kind,
    device: trigger.sensor,
    cause: trigger.cause,
    ...(kind === "late_report_sirens" ? { value: secondsLeft } : {}),
  }).map(({ seq, message }) => {
    const base: AlarmRun = running ?? {
      startedAt: now,
      cause: seq,
      triggers: new Map(),
      sirens: new Map(),
      quietEnd: stopAt,
    };
    const chosen = triggerSirens(ctx.view, trigger.sensor);
    const added: [DeviceId, AlarmSiren][] = sirenIds(ctx.view)
      .filter((siren) => chosen === "all" || chosen.includes(siren))
      .filter((siren) => !base.sirens.has(siren))
      .flatMap((siren): [DeviceId, AlarmSiren][] => {
        const cap = afterSeconds(now, sirenMaxSoundS(ctx.view, siren) ?? slice.autoStopS);
        const until = mono(Math.min(stopAt, cap));
        return until > now ? [[siren, { until, commanded: false, restore: "fresh" }]] : [];
      });
    const run: AlarmRun = {
      ...base,
      triggers: new Map(base.triggers).set(trigger.sensor, {
        kind: trigger.kind,
        at: now,
        restored: false,
      }),
      sirens: new Map([...base.sirens, ...added]),
      quietEnd: mono(Math.max(base.quietEnd, stopAt)),
    };
    const tests = new Map(slice.tests);
    for (const [siren] of added) tests.delete(siren);
    const next: AlarmSlice = { ...slice, alarm: run, tests };
    const intents: Internal[] = added.map(([siren, entry]) => ({
      kind: "sirenIntent",
      siren,
      should: { kind: "sound", until: entry.until },
      cause: run.cause,
    }));
    return {
      slice: next,
      out: [
        message,
        ...(running === undefined ? alarmRows(next, run) : []),
        ...triggerRow(next, trigger.sensor, trigger.kind, now),
        ...added.flatMap(([siren, entry]) => sirenRow(next, siren, entry)),
        ...intents,
      ],
    };
  });
}

/** Why the alarm ended: a disarm of every trigger (D95), or every siren's time passed (D67). */
export type AlarmEnding = "disarmed" | "byItself";

/** `alarm_ended`'s value: how it ended. */
const ENDING_VALUE: Readonly<Record<AlarmEnding, number>> = { byItself: 0, disarmed: 1 };

/**
 * Ends the alarm and deletes its rows. A disarm commands every siren still sounding off; ending by
 * itself sends nothing (time running out is not a change, section 8), and each trigger whose door
 * last reported open then waits for it to close (D67).
 */
export function endAlarm(
  slice: AlarmSlice,
  ctx: Context,
  ending: AlarmEnding,
  cause: Seq | undefined,
): Changing {
  const run = slice.alarm;
  if (run === undefined) return ok({ slice, out: [] });
  const now = ctx.now.mono;
  const ended = decide(ctx, "now", {
    kind: "alarm_ended",
    device: undefined,
    cause: cause ?? run.cause,
    value: ENDING_VALUE[ending],
  }).map(({ seq, message }) => {
    const offs: Internal[] =
      ending === "disarmed"
        ? [...run.sirens]
            .filter(([, entry]) => entry.until > now && entry.restore !== "cutShort")
            .map(([siren]) => ({ kind: "sirenIntent", siren, should: { kind: "off" }, cause: seq }))
        : [];
    const deletes: Out = [
      writeNow({ table: "alarm", op: "delete", key: undefined }),
      ...[...run.triggers.keys()].map((sensorId) =>
        writeNow({ table: "alarm_triggers", op: "delete", key: { sensorId } }),
      ),
      ...[...run.sirens.keys()].map((sirenId) =>
        writeNow({ table: "alarm_sirens", op: "delete", key: { sirenId } }),
      ),
    ];
    return { slice: { ...slice, alarm: undefined }, out: [message, ...deletes, ...offs] };
  });
  if (ending === "disarmed") return ended;
  const waiting = [...run.triggers.keys()].filter((sensor) => {
    const arming = slice.sensors.get(sensor);
    return arming?.arm === ArmState.Armed && arming.door?.open === true;
  });
  return then(ended, (current) =>
    each(current, waiting, (s, sensor) =>
      waitForClose(s, ctx, sensor, ArmState.WaitsForCloseAfterAlarm, run.cause),
    ),
  );
}

/** A sensor that now waits for its door to close (D50, D67, D114): recorded, and its version bumped. */
export function waitForClose(
  slice: AlarmSlice,
  ctx: Context,
  sensor: DeviceId,
  arm: typeof ArmState.WaitsForCloseAfterArming | typeof ArmState.WaitsForCloseAfterAlarm,
  cause: Seq | undefined,
): Changing {
  const arming = slice.sensors.get(sensor);
  if (arming === undefined) return ok({ slice, out: [] });
  return decide(ctx, "now", {
    kind: "waits_for_door_to_close",
    device: sensor,
    cause,
    value: arm,
  }).map(({ seq, message }) => {
    const changed = setArm(slice, sensor, arming, arm, seq, arming.armedMono);
    return { slice: changed.slice, out: [message, ...changed.out] };
  });
}

/**
 * The alarm module's handler (hub-design.md section 2, module 8; section 8, "Arming and the
 * countdown" and "What the siren should do"; m2-design.md section 7). It handles the boot and the
 * downtime (restart rule, D80, D113), accepted sensor status packets and siren packets, arm,
 * disarm and siren test requests (M1a's from control, M2's resolved to sensors by layout), its
 * two timers, and the device and settings changes it keeps copies of. It emits
 * `armedChanged`, `countdownCancelled`, `sirenIntent`, its rows written now, its decisions, and
 * the `cadence` effect whenever a countdown or the alarm starts or the last one ends (D112).
 */
import { ok } from "neverthrow";
import { Role } from "@hsn/protocol";
import { downtime, lastCommitMark } from "../clock/view.ts";
import type { Context, Handler } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Internal } from "../model/messages.ts";
import { DeviceState } from "../model/rows.ts";
import { MICROS_PER_MILLISECOND } from "../model/time.ts";
import { endAlarm, type SirenSource } from "./alarm.ts";
import {
  onArmRequest,
  onArmSensors,
  onDisarmRequest,
  onDisarmSensors,
  onSirenTestRequest,
} from "./commands.ts";
import { onCountdownEnd, onSensorStatus, sensorStatus } from "./doors.ts";
import { type Changed, type Changing, unchanged, writeNow } from "./out.ts";
import { newSensor, onBoot, onDowntimeKnown, onSirenHeard } from "./restore.ts";
import type { AlarmSlice } from "./state.ts";
import { alarmEndsAt, withTimers } from "./timers.ts";

/** Whether a countdown or the alarm runs, so the writer commits every second (D112, D113). */
function running(slice: AlarmSlice): boolean {
  return slice.countdowns.size > 0 || slice.alarm !== undefined;
}

function route(slice: AlarmSlice, message: Internal, ctx: Context): Changing {
  switch (message.kind) {
    case "boot":
      return onBoot(slice, ctx, message);
    case "downtimeKnown":
      return onDowntimeKnown(slice, ctx, message.downtimeMs);
    case "accepted": {
      if (message.role === Role.Siren) return onSirenHeard(slice, ctx, message);
      const status = message.role === Role.Sensor ? sensorStatus(message.message) : undefined;
      return status === undefined ? unchanged(slice) : onSensorStatus(slice, ctx, message, status);
    }
    case "timer":
      if (message.key.module !== "alarm") return unchanged(slice);
      if (message.key.kind === "countdownEnd")
        return onCountdownEnd(slice, ctx, message.key.sensor);
      return slice.alarm !== undefined && alarmEndsAt(slice.alarm) <= ctx.now.mono
        ? endAlarm(slice, ctx, "byItself", undefined)
        : unchanged(slice);
    case "armRequest":
      return onArmRequest(slice, ctx, message);
    case "disarmRequest":
      return onDisarmRequest(slice, ctx, message);
    case "armSensors":
      return onArmSensors(slice, ctx, message);
    case "disarmSensors":
      return onDisarmSensors(slice, ctx, message);
    case "sirenTestRequest":
      return onSirenTestRequest(slice, ctx, message);
    case "deviceAdded":
      return message.role === Role.Sensor && !slice.sensors.has(message.device)
        ? ok({
            slice: {
              ...slice,
              sensors: new Map(slice.sensors).set(
                message.device,
                newSensor(slice.countdownDefaultS),
              ),
            },
            out: [],
          })
        : unchanged(slice);
    case "deviceRemoved":
      return onDeviceRemoved(slice, message.device);
    case "sensorSettingsRequest": {
      const arming = slice.sensors.get(message.sensor);
      const countdownS = message.change.countdown;
      return arming === undefined || countdownS === undefined
        ? unchanged(slice)
        : ok({
            slice: {
              ...slice,
              sensors: new Map(slice.sensors).set(message.sensor, { ...arming, countdownS }),
            },
            out: [],
          });
    }
    case "siteSettingsRequest":
      return ok({
        slice: {
          ...slice,
          autoStopS: message.change.autoStop ?? slice.autoStopS,
          countdownDefaultS: message.change.countdown ?? slice.countdownDefaultS,
        },
        out: [],
      });
    default:
      return unchanged(slice);
  }
}

/**
 * A removed device leaves the alarm's tables: its countdown ends without a notice (its key is
 * gone), and a siren leaves the alarm. Its history stays (section 9).
 */
function onDeviceRemoved(slice: AlarmSlice, device: DeviceId): Changing {
  if (!slice.sensors.has(device) && slice.alarm?.sirens.has(device) !== true) {
    return unchanged(slice);
  }
  const sensors = new Map(slice.sensors);
  sensors.delete(device);
  const countdowns = new Map(slice.countdowns);
  const hadCountdown = countdowns.delete(device);
  const tests = new Map(slice.tests);
  tests.delete(device);
  const run = slice.alarm;
  const sirens = new Map(run?.sirens);
  const hadSiren = sirens.delete(device);
  return ok({
    slice: {
      ...slice,
      sensors,
      countdowns,
      tests,
      alarm: run === undefined ? undefined : { ...run, sirens },
    },
    out: [
      ...(hadCountdown
        ? [writeNow({ table: "countdowns", op: "delete", key: { sensorId: device } })]
        : []),
      ...(hadSiren
        ? [writeNow({ table: "alarm_sirens", op: "delete", key: { sirenId: device } })]
        : []),
    ],
  });
}

/** The slice with its timers kept current, and `cadence` when the running state changed. */
function finish(before: AlarmSlice, changed: Changed, ctx: Context): Changed {
  if (changed.slice === before) return changed;
  const slice = withTimers(changed.slice);
  const wasRunning = running(before);
  const isRunning = running(slice);
  if (wasRunning === isRunning) return { slice, out: changed.out };
  const { runningCadenceMs: runningMs, routineBatchMs: routine } = ctx.deps.rules.persistence;
  return {
    slice,
    out: [...changed.out, { kind: "cadence", everyMs: isRunning ? runningMs : routine }],
  };
}

/**
 * The paired sirens of a boot snapshot and their longest sound, as the sirens module restores them
 * (`sirens/devices.ts`, `onBoot`: every siren not removed, in the snapshot's order, with its
 * `siren_config` row's settings). A siren without a row gets the module's first settings there; here
 * the automatic stop caps it, as for any siren whose longest sound is not known (`addTrigger`).
 */
function bootSirens(snapshot: DurableSnapshot): SirenSource {
  const configs = new Map(snapshot.sirenConfig.map((row) => [row.deviceId, row.maxSoundS]));
  return {
    ids: snapshot.devices
      .filter((device) => device.role === Role.Siren && device.state !== DeviceState.Removed)
      .map((device) => device.id),
    maxSoundS: (siren) => configs.get(siren),
  };
}

/**
 * When a countdown that ends at a start really ended, wall milliseconds (D102): its time at the
 * last commit was re-expressed as this boot's start plus what was left (`restore.ts`), so it ended
 * that long after the last commit's wall time, which is before the stop. Undefined without a mark.
 */
function endedBeforeStop(slice: AlarmSlice, ctx: Context, sensor: DeviceId): number | undefined {
  const mark = lastCommitMark(ctx.view);
  const countdown = slice.countdowns.get(sensor);
  if (mark === undefined || countdown === undefined) return undefined;
  return mark.lastSeenMs + (countdown.deadline - slice.bootAt) / MICROS_PER_MILLISECOND;
}

/** The earliest countdown end or alarm end at or before now, as the timers would order them. */
function firstDue(
  slice: AlarmSlice,
  ctx: Context,
):
  | { readonly kind: "countdown"; readonly sensor: DeviceId }
  | { readonly kind: "alarm" }
  | undefined {
  const now = ctx.now.mono;
  let first: { readonly at: number; readonly sensor: DeviceId | undefined } | undefined;
  for (const [sensor, countdown] of slice.countdowns) {
    if (countdown.deadline <= now && (first === undefined || countdown.deadline < first.at))
      first = { at: countdown.deadline, sensor };
  }
  if (slice.alarm !== undefined) {
    const end = alarmEndsAt(slice.alarm);
    // Equal times keep the timers' order: the countdowns before the alarm's end (`withTimers`).
    if (end <= now && (first === undefined || end < first.at))
      first = { at: end, sensor: undefined };
  }
  if (first === undefined) return undefined;
  return first.sensor === undefined
    ? { kind: "alarm" }
    : { kind: "countdown", sensor: first.sensor };
}

/**
 * What a restart left already due, done in this step (hub-design.md section 2, "Timers": a
 * deadline at or before the step's time would run again at once), earliest first, each exactly as
 * its timer would have done it a turn later:
 *
 * - a countdown whose time left at the last commit was none (its end not committed before the
 *   stop), with the downtime unknown: it ends now and its sirens sound (D113: "resumes each saved
 *   countdown with the time it had left, and sounds the sirens when it ends"; section 5, point 1);
 * - an alarm every one of whose sirens' time has passed, before the stop or during the downtime
 *   once that is known: it ends by itself (section 8, "Ending by itself"; D67; section 5, point 3:
 *   judged "as if they had been restored with it"). Nothing is sent: time running out is not a
 *   change (section 8), and a siren that still reports sounding is answered by the correction rule.
 *
 * A countdown that ran out during a known downtime is judged by D106 when the downtime is known
 * (`onDowntimeKnown`), never here. So at the boot message itself, while the downtime is known and
 * its `downtimeKnown` is still to come in this same step, nothing is done yet.
 *
 * At the boot message the sirens module, which runs after this one, has not read the snapshot yet,
 * so a countdown ending then sounds the sirens the snapshot holds, read as that module reads them
 * (`bootSirens`); its `sirenIntent`s reach it later in the same step, once it has.
 */
function settleDue(changed: Changed, ctx: Context, message: Internal): Changing {
  if (message.kind === "boot" && downtime(ctx.view).kind === "known") return ok(changed);
  const due = firstDue(changed.slice, ctx);
  if (due === undefined) return ok(changed);
  const atBoot = message.kind === "boot";
  const sirens = atBoot ? bootSirens(message.snapshot) : undefined;
  const done =
    due.kind === "countdown"
      ? onCountdownEnd(
          changed.slice,
          ctx,
          due.sensor,
          sirens,
          atBoot ? endedBeforeStop(changed.slice, ctx, due.sensor) : undefined,
        )
      : endAlarm(changed.slice, ctx, "byItself", undefined);
  // Each one removes what was due, so this ends after one pass per countdown and the alarm.
  return done.andThen((next) =>
    settleDue({ slice: next.slice, out: [...changed.out, ...next.out] }, ctx, message),
  );
}

/** The alarm module's handler (section 2, module 8). */
export const handleAlarm: Handler<"alarm"> = (slice, message, ctx) =>
  route(slice, message, ctx)
    .andThen((changed) =>
      changed.slice === slice ? ok(changed) : settleDue(changed, ctx, message),
    )
    .map((changed) => finish(slice, changed, ctx));

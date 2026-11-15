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
import type { Context, Handler } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { endAlarm } from "./alarm.ts";
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

/** The alarm module's handler (section 2, module 8). */
export const handleAlarm: Handler<"alarm"> = (slice, message, ctx) =>
  route(slice, message, ctx).map((changed) => finish(slice, changed, ctx));

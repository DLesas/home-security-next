/**
 * The firmware module's handler (docs/m3-updates-design.md section 4; hub-design.md section 2,
 * module 15). It acts on: `boot`; `accepted` Started, update query and update status, and any
 * accepted packet that shows a device's own link; `gatewayUp`, `linkClosed`, `deviceRemoved`,
 * `armedChanged`; `releaseOffered` (its firmware entries); `fileReady` for its own jobs;
 * `transferProgress`; `v2OpRequest` for `firmware.*` and `rollout.*`; decisions it reads from
 * other modules (`key_changed` ends a key-change hold, silence of a pilot in its soak, a battery
 * that went low or recovered); and its six timers. On every message it also looks whether a
 * countdown, an alarm or a site move began or ended: grants are revoked while a countdown or an
 * alarm runs and given again after (R12), and holds are looked at again.
 *
 * With no image and no rollout it changes nothing and emits nothing, whatever the message.
 */
import { ok } from "neverthrow";
import type { Context, Handler } from "../model/handler.ts";
import type { Internal } from "../model/messages.ts";
import { onBoot } from "./boot.ts";
import { climateOf, openRollout } from "./decide.ts";
import { grantEffect } from "./deliver.ts";
import {
  busyRetryDue,
  onAccepted,
  onDeviceRemoved,
  onGatewayUp,
  onLinkClosed,
  onProgress,
  onSilent,
  reminderDue,
  trialWatchDue,
} from "./devices.ts";
import { change, progressDue, putEntry } from "./entries.ts";
import { firmwareOp } from "./ops.ts";
import { Steps } from "./out.ts";
import { advance, advanceDevice, soakEnded } from "./rollout.ts";
import type { FirmwareSlice } from "./state.ts";
import { onFileReady, onReleaseOffered, onStoreDamaged } from "./store.ts";
import { DeviceUpdateState, UpdateHeld, UpdateMethod } from "../model/rows.ts";

/** Decisions of other modules that firmware acts on. */
const SILENCE = new Set(["sensor_silent", "siren_silent", "gateway_offline"]);
const BATTERY = new Set(["battery_low", "battery_ok"]);

function onTimer(steps: Steps, ctx: Context, message: Extract<Internal, { kind: "timer" }>): void {
  const key = message.key;
  if (key.module !== "firmware") return;
  steps.clear(key);
  switch (key.kind) {
    case "soakEnd":
      soakEnded(steps, ctx);
      return;
    case "trialWatch":
      trialWatchDue(steps, ctx, key.device);
      return;
    case "sessionExpiry": {
      // The session's life ended: its nonce goes; a Bluetooth offer not yet verified starts again.
      const entry = steps.slice.updates.get(key.device);
      if (entry === undefined) return;
      const planned =
        entry.row.method === UpdateMethod.Bluetooth &&
        (entry.row.state === DeviceUpdateState.Offered ||
          entry.row.state === DeviceUpdateState.Fetching);
      change(steps, ctx, key.device, {
        bleNonce: null,
        bleExpiresMs: null,
        ...(planned ? { state: DeviceUpdateState.Planned } : {}),
      });
      const after = steps.slice.updates.get(key.device);
      if (after !== undefined) putEntry(steps, { ...after, told: undefined });
      advance(steps, ctx);
      return;
    }
    case "armedReminder":
      reminderDue(steps, ctx, key.device);
      return;
    case "gatewayBusyRetry":
      busyRetryDue(steps, ctx, key.device);
      return;
    case "progressEvent":
      progressDue(steps, ctx, key.device);
      return;
  }
}

function onRecord(
  steps: Steps,
  ctx: Context,
  message: Extract<Internal, { kind: "auditRecord" }>,
): void {
  const { record } = message;
  if (record.kind !== "decision") return;
  const { kind, deviceId } = record.row;
  if (deviceId === null) return;
  if (kind === "key_changed" && steps.slice.rekey.has(deviceId)) {
    const rekey = new Set(steps.slice.rekey);
    rekey.delete(deviceId);
    steps.set({ ...steps.slice, rekey });
    advanceDevice(steps, ctx, deviceId);
  } else if (SILENCE.has(kind)) {
    onSilent(steps, ctx, deviceId);
  } else if (BATTERY.has(kind)) {
    advanceDevice(steps, ctx, deviceId);
  }
}

function handle(steps: Steps, ctx: Context, message: Internal): void {
  switch (message.kind) {
    case "boot":
      onBoot(steps, ctx, message.snapshot);
      return;
    case "timer":
      onTimer(steps, ctx, message);
      return;
    case "accepted":
      onAccepted(steps, ctx, message);
      return;
    case "gatewayUp":
      onGatewayUp(steps, ctx, message.gateway, message.link);
      return;
    case "linkClosed":
      onLinkClosed(steps, message.link);
      return;
    case "deviceRemoved":
      onDeviceRemoved(steps, ctx, message.device);
      return;
    case "armedChanged": {
      // A change of arming is news the device's own "armed" refusal waited for.
      const entry = steps.slice.updates.get(message.sensor);
      if (entry?.deviceHeld?.held === UpdateHeld.Armed) {
        putEntry(steps, { ...entry, deviceHeld: undefined });
      }
      advanceDevice(steps, ctx, message.sensor);
      return;
    }
    case "releaseOffered":
      onReleaseOffered(steps, ctx, message.releases);
      return;
    case "fileReady":
      onFileReady(steps, ctx, message.job, message.outcome);
      return;
    case "firmwareStoreDamaged":
      onStoreDamaged(steps, ctx, message.image, message.problem);
      return;
    case "transferProgress":
      onProgress(steps, ctx, message.link, message.image, message.bytes);
      return;
    case "v2OpRequest":
      if (message.owner !== "firmware") return;
      firmwareOp(steps, ctx, message.op, message.actor, message.answerTo, message.record);
      return;
    case "auditRecord":
      onRecord(steps, ctx, message);
      return;
    default:
      return;
  }
}

/**
 * A countdown, an alarm or a site move began or ended since the last message: every grant is
 * revoked while a countdown or an alarm runs and given again when it ends (downloads resume from
 * their checkpoints, R12), and every device's hold is looked at again.
 */
function watchClimate(steps: Steps, ctx: Context): void {
  const climate = climateOf(ctx.view);
  if (climate === steps.slice.climate) return;
  const suspend = climate === "countdown" || climate === "alarm";
  if (suspend !== steps.slice.suspended) {
    for (const [link, held] of steps.slice.grants) {
      const image = steps.slice.images.get(held.image);
      if (suspend) steps.push({ kind: "transferRevoke", link, reason: "paused" });
      else if (image !== undefined) steps.push(grantEffect(link, image));
    }
  }
  steps.set({ ...steps.slice, climate, suspended: suspend });
  if (openRollout(steps.slice) !== undefined) advance(steps, ctx);
}

export const handleFirmware: Handler<"firmware"> = (slice: FirmwareSlice, message, ctx) => {
  if (!slice.booted && message.kind !== "boot") return ok({ slice, out: [] });
  const steps = new Steps(slice);
  handle(steps, ctx, message);
  watchClimate(steps, ctx);
  return steps.done();
};

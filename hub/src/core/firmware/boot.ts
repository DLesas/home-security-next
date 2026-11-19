/**
 * After a restart (docs/m3-updates-design.md section 4, "After a hub restart"): the rollout
 * continues from its stage, rebuilt from migration 3's tables. Offers are made again (what each
 * device was told is memory, so it is told again; a sensor is reached at its next packet, a siren
 * or gateway when it is next on its link), grants are given again when a device asks on its link,
 * and devices resume from their own checkpoints. A device installing or on trial keeps its state
 * and is watched again for the whole trial deadline and grace. An installing sensor can recover a
 * missed reply by reporting its verified image after the old reply could no longer arrive.
 * Times kept as wall times (the soak's end, a session's expiry, the last reminder) are counted
 * again from the wall clock, each bounded by its rule.
 */
import type { DurableSnapshot } from "../model/events.ts";
import { EMPTY_M3M4_SNAPSHOT } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import { type ImageId, rolloutId, type RolloutId } from "../model/ids.ts";
import {
  DeviceUpdateState,
  type FirmwareImageRow,
  RolloutStage,
  UpdateHeld,
} from "../model/rows.ts";
import { monoAfterMs } from "../model/time.ts";
import { decodeIds, INSTALLING_STATES } from "./codes.ts";
import { workingRole } from "./decide.ts";
import { trialWatchMs } from "./deliver.ts";
import { reminderDue } from "./devices.ts";
import { eventBody, putEntry } from "./entries.ts";
import type { Steps } from "./out.ts";
import { writeUpdate } from "./records.ts";
import { advance, soakEnded } from "./rollout.ts";
import { type DeviceEntry, EMPTY_FIRMWARE_SLICE, type Rollout } from "./state.ts";

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

export function onBoot(steps: Steps, ctx: Context, snapshot: DurableSnapshot): void {
  const m3m4 = snapshot.m3m4 ?? EMPTY_M3M4_SNAPSHOT;
  const fw = ctx.deps.rules.firmware;
  const images = new Map<ImageId, FirmwareImageRow>(
    m3m4.firmwareImages.map((row) => [row.id, row]),
  );
  const rollouts = new Map<RolloutId, Rollout>(
    m3m4.rollouts.map((row) => [
      row.id,
      { row, devices: decodeIds(row.devices), pilots: decodeIds(row.pilots) },
    ]),
  );
  const maxOf = (ids: Iterable<number>) => Math.max(0, ...ids);
  steps.set({
    ...EMPTY_FIRMWARE_SLICE,
    booted: true,
    images,
    nextImage: maxOf(images.keys()) + 1,
    rollouts,
    nextRollout: maxOf(rollouts.keys()) + 1,
    rekey: new Set(m3m4.rekey),
  });
  for (const row of m3m4.deviceUpdates) {
    const entry: DeviceEntry = {
      row,
      told: undefined,
      ...(row.state === DeviceUpdateState.Installing
        ? { sensorGoAhead: { kind: "restored", bootedAt: ctx.now.mono } }
        : {}),
      event: eventBody(steps.slice, row),
      eventAt: undefined,
      busyHolds: 0,
      armedSince: row.held === UpdateHeld.Armed ? ctx.now.mono : undefined,
      forced: false,
      discard: false,
      deviceHeld: undefined,
    };
    putEntry(steps, entry);
  }

  const open = [...rollouts.values()].find((r) => r.row.endedMs === null);
  let soakDue = false;
  if (open?.row.stage === RolloutStage.Soak) {
    const left =
      open.row.soakUntilMs === null
        ? fw.soakMs
        : clamp(open.row.soakUntilMs - ctx.now.wall, fw.soakMs);
    soakDue = left === 0;
    if (!soakDue) {
      steps.timer(
        { module: "firmware", kind: "soakEnd", rollout: rolloutId(open.row.id) },
        monoAfterMs(ctx.now.mono, left),
      );
    }
  }
  for (const entry of steps.slice.updates.values()) {
    const { row } = entry;
    const device = row.deviceId;
    const inOpen = open?.row.id === row.rolloutId;
    if (inOpen && INSTALLING_STATES.has(row.state)) {
      const role = workingRole(ctx.view, device);
      if (role !== undefined) {
        steps.timer(
          { module: "firmware", kind: "trialWatch", device },
          monoAfterMs(ctx.now.mono, trialWatchMs(ctx.deps.rules, role)),
        );
      }
    }
    if (row.bleNonce !== null || row.bleExpiresMs !== null) {
      const left = row.bleExpiresMs === null ? 0 : row.bleExpiresMs - ctx.now.wall;
      if (inOpen && left > 0) {
        steps.timer(
          { module: "firmware", kind: "sessionExpiry", device },
          monoAfterMs(ctx.now.mono, clamp(left, fw.bluetoothSessionMs)),
        );
      } else {
        // Its life ended while the hub was off: the session is over.
        const ended = { ...row, bleNonce: null, bleExpiresMs: null };
        putEntry(steps, { ...entry, row: ended, event: eventBody(steps.slice, ended) });
        steps.push(writeUpdate(ended));
      }
    }
    if (inOpen && row.held === UpdateHeld.Armed) {
      const next =
        row.remindedMs === null
          ? fw.armedReminderAfterMs
          : clamp(row.remindedMs + fw.armedReminderEveryMs - ctx.now.wall, fw.armedReminderEveryMs);
      if (next === 0) reminderDue(steps, ctx, device);
      else {
        steps.timer(
          { module: "firmware", kind: "armedReminder", device },
          monoAfterMs(ctx.now.mono, next),
        );
      }
    }
    if (inOpen && row.held === UpdateHeld.GatewayBusy) {
      steps.timer(
        { module: "firmware", kind: "gatewayBusyRetry", device },
        monoAfterMs(ctx.now.mono, fw.gatewayBusyRetryMs),
      );
    }
  }
  // An expired deadline is settled in this boot step, as the dispatcher cannot see it yet.
  if (soakDue) soakEnded(steps, ctx);
  else advance(steps, ctx);
}

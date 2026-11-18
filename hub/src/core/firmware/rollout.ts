/**
 * A rollout's stages (docs/m3-updates-design.md section 4, "How a rollout proceeds", D139):
 * approval, the pilots one at a time (sensor, siren, gateway), the soak after the last pilot
 * confirms, then the rest; done when every planned device still paired is confirmed. A rollback,
 * a refusal that is not a hold, a device not heard after its go-ahead, or a pilot that fails in its
 * soak pauses it; a person resumes or cancels. Every stage change is a "now" row.
 *
 * `advance` moves the open rollout on and looks at each of its devices: a siren or gateway is
 * offered at once on its own link; a sensor is offered in a reply to its next packet, so here only
 * its hold is shown and `offerWaiting` (view.ts) turns true.
 */
import { Role } from "@hsn/protocol";
import type { Context } from "../model/handler.ts";
import { type DeviceId, HUB_DEVICE, rolloutId, type Seq } from "../model/ids.ts";
import { DeviceUpdateState, type RolloutRow, RolloutStage, UpdateHeld } from "../model/rows.ts";
import { monoAfterMs } from "../model/time.ts";
import { FETCHING_STATES, INSTALLING_STATES } from "./codes.ts";
import {
  currentPilot,
  decide,
  type Facts,
  openRollout,
  ownLink,
  sessionOf,
  workingRole,
} from "./decide.ts";
import { actionOf, alreadyTold, deliver, revokeDevice } from "./deliver.ts";
import { inProgress, putEntry, setHeld, transition } from "./entries.ts";
import type { Steps } from "./out.ts";
import { firmwareDecision, pausedDetail, writeRollout } from "./records.ts";
import type { Rollout } from "./state.ts";

export function factsOf(ctx: Context): Facts {
  return { view: ctx.view, rules: ctx.deps.rules, now: ctx.now };
}

/** Replaces a rollout's row, written now. */
export function putRollout(steps: Steps, rollout: Rollout, row: RolloutRow): Rollout {
  const next = { ...rollout, row };
  const rollouts = new Map(steps.slice.rollouts);
  rollouts.set(row.id, next);
  steps.set({ ...steps.slice, rollouts });
  steps.push(writeRollout(row));
  return next;
}

const soakKey = (rollout: Rollout) =>
  ({ module: "firmware", kind: "soakEnd", rollout: rolloutId(rollout.row.id) }) as const;

/** The rollout's devices still paired with this hub. */
function workingDevices(ctx: Context, rollout: Rollout): readonly DeviceId[] {
  return rollout.devices.filter((id) => workingRole(ctx.view, id) !== undefined);
}

/** Every planned device still paired is confirmed. */
function allConfirmed(steps: Steps, ctx: Context, rollout: Rollout): boolean {
  return workingDevices(ctx, rollout).every(
    (id) => steps.slice.updates.get(id)?.row.state === DeviceUpdateState.Confirmed,
  );
}

/** Pauses the open rollout for `reason` (null: a person asked), naming the device that caused it. */
export function pause(
  steps: Steps,
  ctx: Context,
  reason: number | null,
  device: DeviceId | null,
  cause: Seq | undefined,
): void {
  const rollout = openRollout(steps.slice);
  if (rollout === undefined || rollout.row.stage === RolloutStage.Paused) return;
  steps.clear(soakKey(rollout));
  putRollout(steps, rollout, {
    ...rollout.row,
    stage: RolloutStage.Paused,
    pausedReason: reason,
    pausedDevice: device,
  });
  steps.pushResult(
    firmwareDecision(ctx, "rollout_paused", {
      value: rollout.row.id,
      ...(device === null ? {} : { device }),
      ...(reason === null ? {} : { detail: pausedDetail(device ?? HUB_DEVICE, reason) }),
      ...(cause === undefined ? {} : { cause }),
    }),
  );
  stopForced(steps, ctx, rollout);
}

/**
 * A forced gateway's download (action 6) is stopped by a pause, of any cause: it delays the
 * gateway's replies, which only a person's "update now anyway" for a rollout under way allows. The
 * gateway is told to keep what it holds and wait (5) and its grant is taken back (`paused`); the
 * hub keeps the force, so a resume offers it 6 again, as the device itself keeps the force for this
 * image whatever ordinary offer follows. Cancelling ends it ("nothing", 0); a new rollout starts
 * with no device forced.
 */
function stopForced(steps: Steps, ctx: Context, rollout: Rollout): void {
  for (const device of rollout.devices) {
    const entry = steps.slice.updates.get(device);
    if (
      entry?.forced !== true ||
      entry.row.rolloutId !== rollout.row.id ||
      !FETCHING_STATES.has(entry.row.state)
    ) {
      continue;
    }
    revokeDevice(steps, device, "paused");
    deliver(steps, ctx, device, { kind: "wait", held: undefined }, undefined, true);
  }
}

/** Starts the soak: an hour ‡ after the last pilot confirms. */
function startSoak(steps: Steps, ctx: Context, rollout: Rollout): void {
  const soakMs = ctx.deps.rules.firmware.soakMs;
  const next = putRollout(steps, rollout, {
    ...rollout.row,
    stage: RolloutStage.Soak,
    soakUntilMs: ctx.now.wall + soakMs,
  });
  steps.timer(soakKey(next), monoAfterMs(ctx.now.mono, soakMs));
}

/** The soak ended: the rest begins. */
export function soakEnded(steps: Steps, ctx: Context): void {
  const rollout = openRollout(steps.slice);
  if (rollout?.row.stage !== RolloutStage.Soak) return;
  putRollout(steps, rollout, { ...rollout.row, stage: RolloutStage.Rest });
  advance(steps, ctx);
}

/**
 * The stage a paused rollout returns to: the pilots while one is not confirmed; the soak while its
 * hour has not passed (by the wall clock of `soak_until_ms`), or from now if it never began; then
 * the rest.
 */
export function resumeStage(steps: Steps, ctx: Context, rollout: Rollout): void {
  const pilotLeft = currentPilot(steps.slice, ctx.view, rollout) !== undefined;
  const base = { ...rollout.row, pausedReason: null, pausedDevice: null };
  if (pilotLeft) {
    putRollout(steps, rollout, { ...base, stage: RolloutStage.Pilots });
    return;
  }
  const soakMs = ctx.deps.rules.firmware.soakMs;
  if (rollout.row.soakUntilMs === null) {
    const next = putRollout(steps, rollout, {
      ...base,
      stage: RolloutStage.Soak,
      soakUntilMs: ctx.now.wall + soakMs,
    });
    steps.timer(soakKey(next), monoAfterMs(ctx.now.mono, soakMs));
    return;
  }
  const left = Math.min(soakMs, rollout.row.soakUntilMs - ctx.now.wall);
  if (left > 0) {
    const next = putRollout(steps, rollout, { ...base, stage: RolloutStage.Soak });
    steps.timer(soakKey(next), monoAfterMs(ctx.now.mono, left));
    return;
  }
  putRollout(steps, rollout, { ...base, stage: RolloutStage.Rest });
}

/** Ends the rollout as done or cancelled. */
export function end(
  steps: Steps,
  ctx: Context,
  rollout: Rollout,
  stage: typeof RolloutStage.Done | typeof RolloutStage.Cancelled,
  fields: { readonly cause?: Seq; readonly actor?: string },
): Rollout {
  steps.clear(soakKey(rollout));
  const next = putRollout(steps, rollout, { ...rollout.row, stage, endedMs: ctx.now.wall });
  steps.pushResult(
    firmwareDecision(ctx, stage === RolloutStage.Done ? "rollout_done" : "rollout_cancelled", {
      value: rollout.row.id,
      ...(fields.actor === undefined ? {} : { detail: fields.actor }),
      ...(fields.cause === undefined ? {} : { cause: fields.cause }),
    }),
  );
  return next;
}

/**
 * Cancels the open rollout: every device it can still stop is cancelled and its grants taken back;
 * one that holds part of the image is told to discard it at its next contact (a siren or gateway at
 * once). A device already installing or on trial cannot be stopped and is left to come back.
 */
export function cancel(
  steps: Steps,
  ctx: Context,
  rollout: Rollout,
  cause: Seq,
  actor: string,
): Rollout {
  const ended = end(steps, ctx, rollout, RolloutStage.Cancelled, { cause, actor });
  for (const device of rollout.devices) {
    const entry = steps.slice.updates.get(device);
    if (entry?.row.rolloutId !== rollout.row.id) continue;
    const state = entry.row.state;
    if (!inProgress(state) || INSTALLING_STATES.has(state)) continue;
    const holding =
      state === DeviceUpdateState.Offered ||
      state === DeviceUpdateState.Fetching ||
      state === DeviceUpdateState.Verified;
    revokeDevice(steps, device);
    steps.clear({ module: "firmware", kind: "armedReminder", device });
    steps.clear({ module: "firmware", kind: "gatewayBusyRetry", device });
    steps.clear({ module: "firmware", kind: "sessionExpiry", device });
    transition(steps, ctx, device, DeviceUpdateState.Cancelled, {
      held: UpdateHeld.No,
      bleNonce: null,
      bleExpiresMs: null,
    });
    const after = steps.slice.updates.get(device);
    if (after !== undefined) putEntry(steps, { ...after, discard: holding, armedSince: undefined });
    const role = workingRole(ctx.view, device);
    if (holding && role !== undefined && role !== Role.Sensor) {
      const link = ownLink(steps.slice, ctx.view, device, role);
      if (link !== undefined) deliver(steps, ctx, device, { kind: "nothing" }, undefined, true);
    }
  }
  return ended;
}

/**
 * Moves the open rollout on: the pilots to the soak, the rest to done; then each of its devices.
 * Called after anything that may change what a device may do.
 */
export function advance(steps: Steps, ctx: Context): void {
  const rollout = openRollout(steps.slice);
  if (rollout === undefined) return;
  if (rollout.row.stage === RolloutStage.Pilots || rollout.row.stage === RolloutStage.Rest) {
    if (allConfirmed(steps, ctx, rollout)) {
      end(steps, ctx, rollout, RolloutStage.Done, {});
      return;
    }
    if (
      rollout.row.stage === RolloutStage.Pilots &&
      currentPilot(steps.slice, ctx.view, rollout) === undefined
    ) {
      startSoak(steps, ctx, rollout);
    }
  }
  for (const device of rollout.devices) advanceDevice(steps, ctx, device);
}

/** Holds that end when their condition does; a needed phone and a busy gateway end otherwise. */
const CONDITION_HOLDS: ReadonlySet<UpdateHeld> = new Set([
  UpdateHeld.Armed,
  UpdateHeld.Battery,
  UpdateHeld.WaitingTurn,
  UpdateHeld.CountdownAlarmOrSiteMove,
  UpdateHeld.KeyChange,
]);

/** Shows the hold a decision names; one whose condition has gone is cleared. */
function showHold(
  steps: Steps,
  ctx: Context,
  current: UpdateHeld,
  decision: ReturnType<typeof decide>,
  device: DeviceId,
): void {
  if (decision.kind === "wait" && decision.held !== undefined) {
    setHeld(steps, ctx, device, decision.held);
  } else if (decision.kind !== "nothing" && CONDITION_HOLDS.has(current)) {
    setHeld(steps, ctx, device, UpdateHeld.No);
  }
}

/**
 * One device of the open rollout: a siren or gateway is offered what the hub decides on its own
 * link, unless it was told that already on that link; a sensor's hold is shown. A device in a
 * state that waits for the device itself (offered, fetching, installing) is left alone.
 */
export function advanceDevice(steps: Steps, ctx: Context, device: DeviceId): void {
  const rollout = openRollout(steps.slice);
  const entry = steps.slice.updates.get(device);
  const role = workingRole(ctx.view, device);
  if (rollout === undefined || entry?.row.rolloutId !== rollout.row.id || role === undefined) {
    return;
  }
  const decision = decide(steps.slice, factsOf(ctx), device, "radio");
  if (decision.kind === "wait" || decision.kind === "nothing" || role === Role.Sensor) {
    showHold(steps, ctx, entry.row.held, decision, device);
    // A sensor is offered only in a reply, when it next asks (offerWaiting).
    return;
  }
  const action = actionOf(decision);
  const told = entry.told;
  const link =
    decision.kind === "fetch" && (decision.via === "link" || decision.via === "forced")
      ? decision.link
      : undefined;
  const sameLink = told?.link === undefined || link === undefined || told.link === link;
  if (alreadyTold(told, action, sessionOf(entry, ctx.now)) && sameLink) return;
  deliver(steps, ctx, device, decision, undefined, true);
}

/**
 * A device's own word on its update (docs/m3-updates-design.md sections 4 and 5): Update query
 * (0x06), Update status (0x07) and Started (0x05) as `intake` accepts them, the shell's transfer
 * progress, and the device's timers.
 *
 * - **A sensor's query and status are always answered** with an Update offer bound to the packet
 *   (`updateOffer.answers`): the hub's current decision (decide.ts), "keep and wait" or "nothing"
 *   when there is nothing to do. `sensors` therefore answers neither itself. A siren's or
 *   gateway's packets need no answer; it is offered on its own link when there is something to do.
 * - **Statuses** move the state: fetching, verified, installing, confirmed; a refusal is a hold
 *   (battery, armed, no Wi-Fi or hub not found: needs a phone, a gateway always busy), a break
 *   counted against `brokenTries` ‡, or a refusal that pauses the rollout (the image or the store
 *   is wrong). "How a failed update is reported" is this file's table.
 * - **Started** tells the outcome of a go-ahead: on trial, confirmed, or rolled back (with the
 *   failed version), and whether the running image is on trial (no offer then).
 */
import {
  MessageType,
  type MessageOf,
  Role,
  UpdateHolding,
  UpdateReason,
  UpdateStage,
} from "@hsn/protocol";
import type { Context } from "../model/handler.ts";
import type { DeviceId, LinkId } from "../model/ids.ts";
import type { Arrival, Internal } from "../model/messages.ts";
import {
  DeviceUpdateState,
  type FirmwareImageRow,
  NO_CONTACT_REASON,
  PILOT_FAILED_REASON,
  ROLLED_BACK_REASON,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../model/rows.ts";
import { monoAfterMs } from "../model/time.ts";
import { batteryPercent } from "../health/view.ts";
import { sameBytes } from "../registry/view.ts";
import {
  CRASH_RESET_CAUSES,
  IMAGE_HEADER_BYTES,
  INSTALLING_STATES,
  versionNumber,
} from "./codes.ts";
import { decide, type Decision, openRollout, seenOf, type Where } from "./decide.ts";
import { deliver, imageOfEntry, revokeDevice } from "./deliver.ts";
import {
  change,
  forgetTold,
  inProgress,
  publishForceAvailability,
  putEntry,
  setHeld,
  transition,
} from "./entries.ts";
import type { Steps } from "./out.ts";
import { firmwareDecision } from "./records.ts";
import { advance, advanceDevice, factsOf, pause } from "./rollout.ts";
import type { DeviceEntry, Seen } from "./state.ts";

type Accepted = Extract<Internal, { readonly kind: "accepted" }>;

function setSeen(steps: Steps, device: DeviceId, seen: Partial<Seen>): void {
  const before = seenOf(steps.slice, device);
  const after = { ...before, ...seen };
  if (
    after.onTrial === before.onTrial &&
    after.wifiDetails === before.wifiDetails &&
    after.externalPower === before.externalPower &&
    after.link === before.link &&
    steps.slice.seen.has(device)
  ) {
    return;
  }
  const map = new Map(steps.slice.seen);
  map.set(device, after);
  steps.set({ ...steps.slice, seen: map });
}

/** The entry of a device in the open rollout, with the rollout's image; undefined otherwise. */
function inRollout(
  steps: Steps,
  device: DeviceId,
): { readonly entry: DeviceEntry; readonly image: FirmwareImageRow } | undefined {
  const rollout = openRollout(steps.slice);
  const entry = steps.slice.updates.get(device);
  if (rollout === undefined || entry?.row.rolloutId !== rollout.row.id) return undefined;
  const image = imageOfEntry(steps.slice, entry);
  return image === undefined ? undefined : { entry, image };
}

function whereOf(arrival: Arrival): Where {
  return arrival.path === "lora" ? "radio" : arrival.link;
}

/**
 * Any accepted packet: the device's own link is noted (a siren's Wi-Fi, a gateway's link), and an
 * update packet or Started handled. A device newly heard on a link is offered again if it waits.
 */
export function onAccepted(steps: Steps, ctx: Context, message: Accepted): void {
  const { device, arrival } = message;
  const relinked = arrival.path !== "lora" && seenOf(steps.slice, device).link !== arrival.link;
  if (relinked) setSeen(steps, device, { link: arrival.link });
  switch (message.message.type) {
    case MessageType.UpdateQuery:
      onQuery(steps, ctx, message, message.message);
      return;
    case MessageType.UpdateStatus:
      onStatus(steps, ctx, message, message.message);
      return;
    case MessageType.Started:
      onStarted(steps, ctx, message, message.message);
      return;
    default: {
      // Any other packet: the device is heard, so what it waits for is looked at again (a new
      // link, a hold that ended without a message of its own, such as a siren's test).
      const state = steps.slice.updates.get(device)?.row.state;
      if (relinked || state === DeviceUpdateState.Planned || state === DeviceUpdateState.Verified) {
        advanceDevice(steps, ctx, device);
      }
      return;
    }
  }
}

/** A sensor's packet is answered with the hub's decision, bound to it. */
function answerSensor(steps: Steps, ctx: Context, message: Accepted, answer?: Decision): void {
  if (message.role !== Role.Sensor || !message.newest) return;
  const decision =
    answer ?? decide(steps.slice, factsOf(ctx), message.device, whereOf(message.arrival));
  deliver(
    steps,
    ctx,
    message.device,
    decision,
    { counter: message.counter, record: message.record },
    true,
  );
  if (decision.kind !== "install") return;
  const entry = steps.slice.updates.get(message.device);
  if (entry === undefined) return;
  const { arrival } = message;
  const sensorGoAhead: DeviceEntry["sensorGoAhead"] =
    arrival.path === "lora" &&
    message.message.type === MessageType.UpdateStatus &&
    message.message.stage === UpdateStage.Verified
      ? {
          kind: "radio",
          counter: message.counter,
          endedAt: arrival.endedAt,
          rate: arrival.dataRate,
        }
      : undefined;
  if (sensorGoAhead !== undefined || entry.sensorGoAhead !== undefined) {
    putEntry(steps, { ...entry, sensorGoAhead });
  }
}

/** Update query: what the device holds, its Wi-Fi details and power; then the hub's answer. */
function onQuery(
  steps: Steps,
  ctx: Context,
  message: Accepted,
  query: MessageOf<typeof MessageType.UpdateQuery>,
): void {
  const { device } = message;
  setSeen(steps, device, {
    wifiDetails: query.flags.hasWifiDetails,
    externalPower: query.flags.externalPower,
  });
  const found = inRollout(steps, device);
  // Only sensors require an answer. A wait offer could replace a siren's pending go-ahead.
  if (message.role !== Role.Sensor && found?.entry.row.state === DeviceUpdateState.Installing)
    return;
  if (found !== undefined && sameBytes(query.imageId, found.image.imageId)) {
    const state = found.entry.row.state;
    const early =
      state === DeviceUpdateState.Planned ||
      state === DeviceUpdateState.Offered ||
      state === DeviceUpdateState.Fetching;
    if (query.held === UpdateHolding.Verified) {
      if (early) {
        verified(steps, ctx, device, found.image, message);
      } else if (
        state === DeviceUpdateState.Installing &&
        query.bytesHeld === found.entry.row.bytes &&
        found.entry.sensorGoAhead?.kind === "restored" &&
        missedRadioGoAhead(ctx, found.entry, message)
      ) {
        waitForGoAhead(steps, ctx, device);
      }
    } else if (query.held === UpdateHolding.Part && early) {
      if (state !== DeviceUpdateState.Fetching) {
        transition(steps, ctx, device, DeviceUpdateState.Fetching, { bytes: query.bytesHeld });
      } else {
        change(steps, ctx, device, { bytes: query.bytesHeld });
      }
    }
  }
  // A query is the device asking afresh, on this link: whatever it was told before is told again.
  forgetTold(steps, device);
  if (message.role === Role.Sensor) {
    answerSensor(steps, ctx, message);
  } else {
    const decision = decide(steps.slice, factsOf(ctx), device, whereOf(message.arrival));
    deliver(steps, ctx, device, decision, undefined, true);
  }
  advance(steps, ctx);
}

function verified(
  steps: Steps,
  ctx: Context,
  device: DeviceId,
  image: FirmwareImageRow,
  message: Accepted,
): void {
  steps.clear({ module: "firmware", kind: "sessionExpiry", device });
  revokeDevice(steps, device);
  transition(
    steps,
    ctx,
    device,
    DeviceUpdateState.Verified,
    {
      bytes: image.bytes + IMAGE_HEADER_BYTES,
      bleNonce: null,
      bleExpiresMs: null,
      held: UpdateHeld.No,
      // The download's tries are over; from here `attempts` counts installs that did not take.
      attempts: 0,
    },
    { kind: "firmware_verified", value: image.version, cause: message.record },
  );
}

/** The reasons that only hold the device: nothing is wrong with the image. */
function onRefused(
  steps: Steps,
  ctx: Context,
  message: Accepted,
  entry: DeviceEntry,
  reason: number,
): void {
  const device = entry.row.deviceId;
  const fw = ctx.deps.rules.firmware;
  const backToPlanned = { state: DeviceUpdateState.Planned, lastReason: reason } as const;
  revokeDevice(steps, device);
  switch (reason) {
    case UpdateReason.NoWifi:
    case UpdateReason.HubNotFound:
      // Not tried by Wi-Fi again in this rollout: a phone is needed (UP6). No pause.
      change(steps, ctx, device, { ...backToPlanned, method: UpdateMethod.JoinWifi });
      setHeld(steps, ctx, device, UpdateHeld.NeedsPhone);
      forgetTold(steps, device);
      return;
    case UpdateReason.Battery:
    case UpdateReason.Armed: {
      const held = reason === UpdateReason.Battery ? UpdateHeld.Battery : UpdateHeld.Armed;
      change(steps, ctx, device, backToPlanned);
      const after = steps.slice.updates.get(device);
      if (after !== undefined) {
        putEntry(steps, {
          ...after,
          told: undefined,
          deviceHeld: { held, percent: batteryPercent(ctx.view, ctx.deps.rules, device) },
        });
      }
      setHeld(steps, ctx, device, held);
      return;
    }
    case UpdateReason.OnTrial:
      change(steps, ctx, device, backToPlanned);
      setSeen(steps, device, { onTrial: true });
      forgetTold(steps, device);
      return;
    case UpdateReason.WindowEnded:
    case UpdateReason.SessionRefused:
      // The Bluetooth session is over; the person may ask for another.
      steps.clear({ module: "firmware", kind: "sessionExpiry", device });
      change(steps, ctx, device, { ...backToPlanned, bleNonce: null, bleExpiresMs: null });
      forgetTold(steps, device);
      return;
    case UpdateReason.RadioBusy: {
      // The gateway keeps its part; offered again after an hour ‡, three times ‡, then a person.
      const holds = entry.busyHolds + 1;
      putEntry(steps, { ...entry, busyHolds: holds, forced: false });
      change(steps, ctx, device, backToPlanned);
      setHeld(steps, ctx, device, UpdateHeld.GatewayBusy);
      publishForceAvailability(steps, ctx, device);
      forgetTold(steps, device);
      if (holds < fw.gatewayBusyMaxHolds) {
        steps.timer(
          { module: "firmware", kind: "gatewayBusyRetry", device },
          monoAfterMs(ctx.now.mono, fw.gatewayBusyRetryMs),
        );
      }
      return;
    }
    case UpdateReason.LinkLost:
    case UpdateReason.Flash:
    case UpdateReason.HashMismatch: {
      // Broken during the download: the device resumes; after the third ‡, refused and paused.
      const attempts = entry.row.attempts + 1;
      if (attempts < fw.brokenTries) {
        change(steps, ctx, device, { attempts, lastReason: reason });
        forgetTold(steps, device);
        return;
      }
      refuse(steps, ctx, device, reason, attempts, message);
      return;
    }
    default:
      // Refused before writing (wrong hub, role, size, signature, header) or at the install: the
      // image or the store is wrong, not the device.
      refuse(steps, ctx, device, reason, entry.row.attempts, message);
      return;
  }
}

/** `firmware_refused`, and the rollout paused. */
function refuse(
  steps: Steps,
  ctx: Context,
  device: DeviceId,
  reason: number,
  attempts: number,
  message: Accepted | undefined,
): void {
  steps.clear({ module: "firmware", kind: "trialWatch", device });
  revokeDevice(steps, device);
  transition(
    steps,
    ctx,
    device,
    DeviceUpdateState.Refused,
    { lastReason: reason, attempts, held: UpdateHeld.No },
    {
      kind: "firmware_refused",
      value: reason,
      ...(message === undefined ? {} : { cause: message.record }),
    },
  );
  pause(steps, ctx, reason, device, message?.record);
}

/** A fresh LoRa report of the verified image after the old reply window proves the sensor returned. */
function missedRadioGoAhead(ctx: Context, entry: DeviceEntry, report: Accepted): boolean {
  const previous = entry.sensorGoAhead;
  if (
    previous === undefined ||
    report.arrival.path !== "lora" ||
    !report.newest ||
    report.role !== Role.Sensor
  ) {
    return false;
  }
  if (previous.kind === "restored") {
    // The earlier hub's longest possible radio reply window has now closed.
    const longestMs = Math.max(...ctx.deps.rules.replies.eventListenMs);
    return report.arrival.endedAt > monoAfterMs(previous.bootedAt, longestMs);
  }
  if (report.counter <= previous.counter) return false;
  const listenMs = ctx.deps.rules.replies.eventListenMs[previous.rate];
  return listenMs !== undefined && report.arrival.endedAt > monoAfterMs(previous.endedAt, listenMs);
}

/** A verified sensor that returned may get a go-ahead after the install conditions are checked again. */
function waitForGoAhead(steps: Steps, ctx: Context, device: DeviceId): void {
  forgetGoAhead(steps, device);
  steps.clear({ module: "firmware", kind: "trialWatch", device });
  change(steps, ctx, device, { state: DeviceUpdateState.Verified });
}

/** Forgets the unanswered go-ahead once this run knows the device's actual stage. */
function forgetGoAhead(steps: Steps, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry?.sensorGoAhead !== undefined) putEntry(steps, { ...entry, sensorGoAhead: undefined });
}

/** Update status: the device's stage. */
function onStatus(
  steps: Steps,
  ctx: Context,
  message: Accepted,
  status: MessageOf<typeof MessageType.UpdateStatus>,
): void {
  const { device } = message;
  const found = inRollout(steps, device);
  if (found !== undefined && sameBytes(status.imageId, found.image.imageId)) {
    const { entry, image } = found;
    const state = entry.row.state;
    switch (status.stage) {
      case UpdateStage.Fetching:
        if (state === DeviceUpdateState.Offered) {
          transition(steps, ctx, device, DeviceUpdateState.Fetching, {
            bytes: status.bytesWritten,
          });
        } else if (state === DeviceUpdateState.Fetching) {
          change(steps, ctx, device, { bytes: status.bytesWritten });
        }
        break;
      case UpdateStage.Verified:
        if (
          state === DeviceUpdateState.Planned ||
          state === DeviceUpdateState.Offered ||
          state === DeviceUpdateState.Fetching
        ) {
          verified(steps, ctx, device, image, message);
        } else if (
          state === DeviceUpdateState.Installing &&
          status.bytesWritten === entry.row.bytes &&
          missedRadioGoAhead(ctx, entry, message)
        ) {
          // Accepting the bound go-ahead ends the sensor's Verified retries. A fresh retry after
          // its window proves it missed the answer. Check the install conditions again for this try.
          waitForGoAhead(steps, ctx, device);
        }
        break;
      case UpdateStage.Refused:
        if (inProgress(state) && !INSTALLING_STATES.has(state)) {
          onRefused(steps, ctx, message, entry, status.reason);
        } else if (INSTALLING_STATES.has(state)) {
          // The install itself failed (imageCheck at `select`): refused, and the rollout paused.
          refuse(steps, ctx, device, status.reason, entry.row.attempts, message);
        }
        break;
      case UpdateStage.Installing:
        if (state === DeviceUpdateState.Verified) {
          // The device installs without a go-ahead this run knows of: the go-ahead was given
          // before a restart. It is watched as one.
          deliver(steps, ctx, device, { kind: "install" }, undefined, false);
        }
        forgetGoAhead(steps, device);
        break;
      case UpdateStage.Confirmed:
        if (inProgress(state)) confirmed(steps, ctx, device, image, message);
        break;
      case UpdateStage.Cancelled:
        if (inProgress(state) && !INSTALLING_STATES.has(state)) {
          // It discarded what it held: it starts again from nothing.
          change(steps, ctx, device, { state: DeviceUpdateState.Planned, bytes: 0 });
          forgetTold(steps, device);
        }
        break;
      default:
        break;
    }
  } else if (status.stage === UpdateStage.Cancelled) {
    const entry = steps.slice.updates.get(device);
    if (entry?.discard === true) putEntry(steps, { ...entry, discard: false });
  }
  if (status.stage === UpdateStage.Installing) {
    answerSensor(steps, ctx, message, { kind: "wait", held: undefined });
    return;
  }
  answerSensor(steps, ctx, message);
  advance(steps, ctx);
}

function confirmed(
  steps: Steps,
  ctx: Context,
  device: DeviceId,
  image: FirmwareImageRow,
  message: Accepted,
): void {
  setSeen(steps, device, { onTrial: false });
  forgetGoAhead(steps, device);
  steps.clear({ module: "firmware", kind: "trialWatch", device });
  revokeDevice(steps, device);
  transition(
    steps,
    ctx,
    device,
    DeviceUpdateState.Confirmed,
    {
      held: UpdateHeld.No,
      bytes: image.bytes + IMAGE_HEADER_BYTES,
      bleNonce: null,
      bleExpiresMs: null,
    },
    { kind: "firmware_confirmed", value: image.version, cause: message.record },
  );
}

/** Started: the running image, on trial or not; a rollback; a pilot that crashed in its soak. */
function onStarted(
  steps: Steps,
  ctx: Context,
  message: Accepted,
  started: MessageOf<typeof MessageType.Started>,
): void {
  const { device } = message;
  const image = message.startedImage;
  const onTrial = image?.flags.onTrial ?? false;
  setSeen(steps, device, { onTrial });
  const found = inRollout(steps, device);
  if (found === undefined) return;
  const { entry, image: row } = found;
  const running = versionNumber(started.firmwareVersion);
  const state = entry.row.state;
  const rollout = openRollout(steps.slice);
  const timedOut =
    state === DeviceUpdateState.Refused && entry.row.lastReason === NO_CONTACT_REASON;
  const rollback =
    image?.flags.rolledBack === true && versionNumber(image.failedVersion) === row.version;
  const updateAttempted = INSTALLING_STATES.has(state) || timedOut;
  if (
    !entry.row.sameVersion ||
    running !== row.version ||
    onTrial ||
    (rollback && updateAttempted)
  ) {
    forgetGoAhead(steps, device);
  }

  if (rollback) {
    if (
      entry.row.sameVersion
        ? updateAttempted
        : inProgress(state) || state === DeviceUpdateState.Confirmed || timedOut
    ) {
      steps.clear({ module: "firmware", kind: "trialWatch", device });
      revokeDevice(steps, device);
      transition(
        steps,
        ctx,
        device,
        DeviceUpdateState.RolledBack,
        { held: UpdateHeld.No, lastReason: null },
        { kind: "firmware_rolled_back", value: row.version, cause: message.record },
      );
      pause(steps, ctx, ROLLED_BACK_REASON, device, message.record);
    }
  } else if (!entry.row.sameVersion && running === row.version && inProgress(state)) {
    if (onTrial) {
      if (state !== DeviceUpdateState.OnTrial) {
        transition(
          steps,
          ctx,
          device,
          DeviceUpdateState.OnTrial,
          { held: UpdateHeld.No },
          { kind: "firmware_on_trial", value: row.version, cause: message.record },
        );
      }
    } else {
      confirmed(steps, ctx, device, row, message);
    }
  } else if (INSTALLING_STATES.has(state) && running !== row.version && !onTrial) {
    installDidNotTake(steps, ctx, device, entry.row.attempts, message);
  }

  const crashed = CRASH_RESET_CAUSES.has(started.resetCause) || started.lastFatalError !== 0;
  if (
    crashed &&
    rollout?.row.stage === RolloutStage.Soak &&
    rollout.pilots.includes(device) &&
    steps.slice.updates.get(device)?.row.state === DeviceUpdateState.Confirmed
  ) {
    pause(steps, ctx, PILOT_FAILED_REASON, device, message.record);
  }
  advance(steps, ctx);
}

/**
 * An install that did not take: after the go-ahead the device came back on its old image, not on
 * trial and with no rollback flag (a power cut tore its confirmation of the new one, or it never
 * selected it). Not a rollback and not a loss of contact: it still holds the verified image (its
 * next update query says so) and is given the go-ahead again when the conditions hold. Each such
 * return counts as an attempt; at `brokenTries` ‡ it is refused `imageCheck` (the new version would
 * not start on this device), which the person sees as the device refused with that reason and the
 * rollout paused naming it, as for any refusal of the image.
 */
function installDidNotTake(
  steps: Steps,
  ctx: Context,
  device: DeviceId,
  attempts: number,
  message: Accepted,
): void {
  steps.clear({ module: "firmware", kind: "trialWatch", device });
  const tries = attempts + 1;
  if (tries >= ctx.deps.rules.firmware.brokenTries) {
    refuse(steps, ctx, device, UpdateReason.ImageCheck, tries, message);
    return;
  }
  change(steps, ctx, device, { state: DeviceUpdateState.Verified, attempts: tries });
  forgetTold(steps, device);
}

/** A pilot went silent in its soak (`sensor_silent`, `siren_silent`, `gateway_offline`). */
export function onSilent(steps: Steps, ctx: Context, device: DeviceId): void {
  const rollout = openRollout(steps.slice);
  if (rollout?.row.stage !== RolloutStage.Soak || !rollout.pilots.includes(device)) return;
  pause(steps, ctx, PILOT_FAILED_REASON, device, undefined);
}

/** The trial watch ran out: no Started, or no confirmation, after the go-ahead (`noContact`). */
export function trialWatchDue(steps: Steps, ctx: Context, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined || !INSTALLING_STATES.has(entry.row.state)) return;
  refuse(steps, ctx, device, NO_CONTACT_REASON, entry.row.attempts, undefined);
  advance(steps, ctx);
}

/**
 * A Bluetooth session's life is over: by its timer while the hub runs, or found over at a restart
 * when it ended while the hub was off (`boot.ts`). The one rule for both: its nonce goes, and an
 * update offered or fetching over Bluetooth, not yet verified, goes back to planned, so it waits
 * for its holds, the pause and its turn again; one fetching over Wi-Fi or its own link goes on.
 *
 * What the device was last told needs no forgetting here. A sensor's query forgets it before it
 * is answered (`onQuery`); at a restart it is memory, already gone. Every other reading goes
 * through `alreadyTold`, and what a device is told while a session lives is "open Bluetooth" with
 * the session's nonce: with the nonce gone, that matches no plan the device can be told next, so
 * the new plan goes out at its next contact. Any other word it had (a wait, while on trial) is the
 * one it would be told again.
 */
export function sessionEnded(steps: Steps, ctx: Context, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined) return;
  const planned =
    entry.row.method === UpdateMethod.Bluetooth &&
    (entry.row.state === DeviceUpdateState.Offered ||
      entry.row.state === DeviceUpdateState.Fetching);
  change(steps, ctx, device, {
    bleNonce: null,
    bleExpiresMs: null,
    ...(planned ? { state: DeviceUpdateState.Planned } : {}),
  });
}

/** A gateway held as always busy is offered again. */
export function busyRetryDue(steps: Steps, ctx: Context, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry?.row.held !== UpdateHeld.GatewayBusy) return;
  setHeld(steps, ctx, device, UpdateHeld.No);
  advance(steps, ctx);
}

/** D91's reminder for a sensor held armed: after a day ‡, then daily. */
export function reminderDue(steps: Steps, ctx: Context, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry?.row.held !== UpdateHeld.Armed) return;
  const fw = ctx.deps.rules.firmware;
  const since = entry.armedSince ?? ctx.now.mono;
  const days = Math.floor((ctx.now.mono - since) / 1000 / 86_400_000);
  change(steps, ctx, device, { remindedMs: ctx.now.wall });
  steps.pushResult(firmwareDecision(ctx, "firmware_reminder", { device, value: days }));
  steps.timer(
    { module: "firmware", kind: "armedReminder", device },
    monoAfterMs(ctx.now.mono, fw.armedReminderEveryMs),
  );
}

/** The shell served a granted transfer this far: routine progress, offered to fetching. */
export function onProgress(
  steps: Steps,
  ctx: Context,
  link: LinkId,
  image: Uint8Array,
  bytes: number,
): void {
  const held = steps.slice.grants.get(link);
  if (held === undefined) return;
  const row = steps.slice.images.get(held.image);
  const entry = steps.slice.updates.get(held.device);
  if (row === undefined || entry === undefined || !sameBytes(row.imageId, image)) return;
  if (entry.row.state === DeviceUpdateState.Offered) {
    transition(steps, ctx, held.device, DeviceUpdateState.Fetching, { bytes });
  } else if (entry.row.state === DeviceUpdateState.Fetching) {
    change(steps, ctx, held.device, { bytes });
  }
}

/** A link closed: its grant goes (the shell drops it itself), and who was on it is forgotten. */
export function onLinkClosed(steps: Steps, link: LinkId): void {
  if (steps.slice.grants.has(link)) {
    const grants = new Map(steps.slice.grants);
    grants.delete(link);
    steps.set({ ...steps.slice, grants });
  }
  for (const [device, seen] of steps.slice.seen) {
    if (seen.link === link) setSeen(steps, device, { link: undefined });
  }
  for (const entry of steps.slice.updates.values()) {
    if (entry.told?.link === link) forgetTold(steps, entry.row.deviceId);
  }
}

/** A gateway's session was proven on a link: its own link for transfers. */
export function onGatewayUp(steps: Steps, ctx: Context, gateway: DeviceId, link: LinkId): void {
  setSeen(steps, gateway, { link });
  advanceDevice(steps, ctx, gateway);
}

/** A device removed: its update in the open rollout ends there. */
export function onDeviceRemoved(steps: Steps, ctx: Context, device: DeviceId): void {
  const entry = steps.slice.updates.get(device);
  if (entry !== undefined && inProgress(entry.row.state)) {
    for (const kind of [
      "trialWatch",
      "sessionExpiry",
      "armedReminder",
      "gatewayBusyRetry",
      "progressEvent",
    ] as const) {
      steps.clear({ module: "firmware", kind, device });
    }
    revokeDevice(steps, device);
    transition(steps, ctx, device, DeviceUpdateState.Cancelled, { held: UpdateHeld.No });
  }
  if (steps.slice.seen.has(device)) {
    const seen = new Map(steps.slice.seen);
    seen.delete(device);
    steps.set({ ...steps.slice, seen });
  }
  advance(steps, ctx);
}

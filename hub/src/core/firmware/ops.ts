/**
 * firmware's operations (docs/m3-updates-design.md section 4, "App operations and events";
 * `OP_OWNERS`): `firmware.*` and `rollout.*`, as `v2OpRequest` brings them. Every one needs
 * *manage system* (MS); `firmware.upload` also the console (C), since an owner's own build is
 * confirmed there. `app` checks both for an app's request before it sends one; firmware checks them
 * again, as the owner, so the rule holds whoever sends the request. The hub computer (`hsn`) and
 * the console have every permission (HD 9, D61).
 */
import { Role } from "@hsn/protocol";
import {
  type AppErrorV2,
  type AppOpV2,
  FIRMWARE_BLUETOOTH_REFUSALS,
  OFFER_AND_ROLLOUT_REFUSALS,
  type RolloutDeviceObject,
  type RolloutObject,
} from "@hsn/protocol/app";
import type { Effect } from "../model/effects.ts";
import type { Context } from "../model/handler.ts";
import { type DeviceId, deviceId, rolloutId, type Seq } from "../model/ids.ts";
import type { Actor, AnswerTo } from "../model/messages.ts";
import {
  DeviceUpdateState,
  type DeviceUpdateRow,
  type FirmwareImageRow,
  RolloutStage,
  UpdateHeld,
  UpdateMethod,
} from "../model/rows.ts";
import { monoAfterMs } from "../model/time.ts";
import { hasGlobal } from "../people/view.ts";
import { armedForUser } from "../alarm/view.ts";
import { sensorsOnlyHeardBy } from "../gateways/view.ts";
import { batteryPercent } from "../health/view.ts";
import { deviceById, firmwareText, registeredDevices } from "../registry/view.ts";
import { siteRow } from "../site/view.ts";
import {
  decodeIds,
  encodeIds,
  hasRole,
  hex,
  holdName,
  IMAGE_HEADER_BYTES,
  methodName,
  pausedReasonName,
  reasonName,
  sessionGranted,
  stageName,
  stateName,
  versionText,
} from "./codes.ts";
import {
  climateOf,
  imageGone,
  lowBattery,
  openRollout,
  seenOf,
  sessionOf,
  workingRole,
} from "./decide.ts";
import { deliver } from "./deliver.ts";
import { eventBody, inProgress, published, putEntry, setHeld, transition } from "./entries.ts";
import type { Steps } from "./out.ts";
import { actorText, firmwareDecision, writeUpdate } from "./records.ts";
import { advance, cancel, factsOf, pause, putRollout, resumeStage } from "./rollout.ts";
import type { DeviceEntry, Rollout } from "./state.ts";
import {
  download,
  fetch,
  liveImage,
  liveImages,
  imageObject,
  offersReply,
  remove,
  upload,
} from "./store.ts";

/** Who may ask, beyond MS: `firmware.upload` only on the console or from `hsn`. */
function refusalFor(ctx: Context, actor: Actor, op: AppOpV2): AppErrorV2 | undefined {
  if (!hasGlobal(ctx.view, actor, "manageSystem")) {
    return { code: "unauthorized", detail: { permission: "manageSystem" } };
  }
  if (op.op === "firmware.upload" && actor.kind !== "computer" && actor.kind !== "console") {
    return { code: "consoleOnly", detail: {} };
  }
  return undefined;
}

/** A rollout as the `rollout.*` replies show it. */
export function rolloutObject(steps: Steps, rollout: Rollout): RolloutObject {
  const { row } = rollout;
  const image = steps.slice.images.get(row.image);
  const reason = row.stage === RolloutStage.Paused ? pausedReasonName(row.pausedReason) : undefined;
  return {
    id: row.id,
    image: row.image,
    version: versionText(image?.version ?? 0),
    stage: stageName(row.stage),
    devices: [...rollout.devices],
    pilots: [...rollout.pilots],
    approvedBy: row.approvedBy,
    approvedMs: row.approvedMs,
    soakUntilMs: row.soakUntilMs,
    paused: reason === undefined ? null : { reason, device: row.pausedDevice },
    endedMs: row.endedMs,
  };
}

/** A planned device as `rollout.status` shows it. */
function rolloutDevice(steps: Steps, entry: DeviceEntry): RolloutDeviceObject {
  const body = eventBody(steps.slice, entry.row);
  return {
    device: entry.row.deviceId,
    state: stateName(entry.row.state),
    held: holdName(entry.row.held),
    method: methodName(entry.row.method),
    bytes: entry.row.bytes,
    of: body.of,
    lastReason: reasonName(entry.row.lastReason) ?? null,
  };
}

/** The rollout `rollout.status` shows: the open one, else the latest. */
function latestRollout(steps: Steps): Rollout | undefined {
  const open = openRollout(steps.slice);
  if (open !== undefined) return open;
  let latest: Rollout | undefined;
  for (const rollout of steps.slice.rollouts.values()) {
    if (latest === undefined || rollout.row.id > latest.row.id) latest = rollout;
  }
  return latest;
}

/** The device object's `update` (m3-updates section 4), null when it has none. */
export function updateObject(entry: DeviceEntry | undefined) {
  if (entry === undefined || entry.row.state === DeviceUpdateState.None) return null;
  return {
    state: stateName(entry.row.state),
    held: holdName(entry.row.held),
    method: methodName(entry.row.method),
  };
}

/** States in which a device has not yet got the image: a Bluetooth session can bring it. */
const FETCHABLE: ReadonlySet<DeviceUpdateState> = new Set([
  DeviceUpdateState.Planned,
  DeviceUpdateState.Offered,
  DeviceUpdateState.Fetching,
]);

/** The offer's window byte counts tens of seconds (§6, m3-updates section 5). */
const WINDOW_UNIT_S = 10;

/** The roles of the protocol firmware updates (sensors, sirens, gateways). */
const DEVICE_ROLES: readonly number[] = [Role.Sensor, Role.Siren, Role.Gateway];

function firmwareList(steps: Steps, ctx: Context, answerTo: AnswerTo): void {
  const devices = registeredDevices(ctx.view)
    .filter((row) => workingRole(ctx.view, row.id) !== undefined && DEVICE_ROLES.includes(row.role))
    .map((row) => ({
      device: row.id,
      version: firmwareText(row.firmware),
      update: updateObject(steps.slice.updates.get(row.id)),
    }));
  steps.answer(answerTo, { images: liveImages(steps).map(imageObject), devices });
}

/**
 * The pilots (section 4): those named, and for each other role present one chosen by the hub: a
 * disarmed sensor with a good battery (Wi-Fi details come with the site's, D47), any siren, a
 * gateway that is not the only one hearing a sensor; where nothing fits that well, the lowest id.
 */
function choosePilots(
  steps: Steps,
  ctx: Context,
  devices: readonly DeviceId[],
  named: readonly DeviceId[],
): readonly DeviceId[] {
  const pilots = [...named];
  const rules = ctx.deps.rules;
  const wifi = siteRow(ctx.view).wifiName.length > 0;
  for (const role of DEVICE_ROLES) {
    const have = pilots.filter((id) => deviceById(ctx.view, id)?.role === role).length;
    if (have >= rules.firmware.pilotsPerRole) continue;
    const candidates = devices.filter(
      (id) => workingRole(ctx.view, id) === role && !pilots.includes(id),
    );
    const score = (id: DeviceId): number => {
      if (role === Role.Sensor) {
        const percent = batteryPercent(ctx.view, rules, id);
        return (
          (armedForUser(ctx.view, id) ? 0 : 4) +
          (percent !== null && percent >= rules.firmware.batteryFloorPercent ? 2 : 0) +
          (wifi && seenOf(steps.slice, id).wifiDetails !== false ? 1 : 0)
        );
      }
      if (role === Role.Gateway)
        return sensorsOnlyHeardBy(ctx.view, id, rules).length === 0 ? 1 : 0;
      return 0;
    };
    const ranked = candidates.toSorted((a, b) => score(b) - score(a) || a - b);
    pilots.push(...ranked.slice(0, rules.firmware.pilotsPerRole - have));
  }
  return pilots.toSorted((a, b) => a - b);
}

function rolloutStart(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  actor: Actor,
  record: Seq,
  body: Extract<AppOpV2, { readonly op: "rollout.start" }>["body"],
): void {
  const image = liveImage(steps, body.image);
  if (image === undefined) {
    steps.refuse(answerTo, { code: "notFound", detail: { what: "image", id: body.image } });
    return;
  }
  if (openRollout(steps.slice) !== undefined) {
    steps.refuse(answerTo, OFFER_AND_ROLLOUT_REFUSALS.rolloutOpen);
    return;
  }
  const working = (id: number) => workingRole(ctx.view, deviceId(id)) !== undefined;
  let devices: readonly DeviceId[];
  if (body.devices === undefined || body.devices === "all") {
    devices = registeredDevices(ctx.view)
      .filter((row) => working(row.id) && hasRole(image.roles, row.role))
      .map((row) => row.id);
  } else {
    const missing = body.devices.find((id) => !working(id));
    if (missing !== undefined) {
      steps.refuse(answerTo, { code: "notFound", detail: { what: "device", id: missing } });
      return;
    }
    const wrong = body.devices.filter(
      (id) => !hasRole(image.roles, deviceById(ctx.view, deviceId(id))?.role ?? 0),
    );
    if (wrong.length > 0) {
      steps.refuse(answerTo, {
        code: "invalid",
        detail: { field: "devices", reason: "wrongRole", refs: wrong },
      });
      return;
    }
    devices = body.devices.map(deviceId);
  }
  if (devices.length === 0) {
    steps.refuse(answerTo, { code: "invalid", detail: { field: "devices", reason: "range" } });
    return;
  }
  const named = (body.pilots ?? []).map(deviceId);
  const strangers = named.filter((id) => !devices.includes(id));
  const perRole = DEVICE_ROLES.some(
    (role) =>
      named.filter((id) => deviceById(ctx.view, id)?.role === role).length >
      ctx.deps.rules.firmware.pilotsPerRole,
  );
  if (strangers.length > 0 || perRole) {
    steps.refuse(answerTo, {
      code: "invalid",
      detail: {
        field: "pilots",
        reason: "range",
        ...(strangers.length > 0 ? { refs: strangers } : {}),
      },
    });
    return;
  }
  const pilots = choosePilots(steps, ctx, devices, named);
  const id = rolloutId(steps.slice.nextRollout);
  const row = {
    id,
    image: image.id,
    devices: encodeIds(devices),
    pilots: encodeIds(pilots),
    stage: RolloutStage.Pilots,
    approvedBy: actorText(actor),
    approvedMs: ctx.now.wall,
    soakUntilMs: null,
    pausedReason: null,
    pausedDevice: null,
    endedMs: null,
  };
  const rollout: Rollout = { row, devices: decodeIds(row.devices), pilots: decodeIds(row.pilots) };
  const rollouts = new Map(steps.slice.rollouts);
  rollouts.set(id, rollout);
  steps.set({ ...steps.slice, rollouts, nextRollout: steps.slice.nextRollout + 1 });
  putRollout(steps, rollout, row);
  for (const device of devices) {
    const role = workingRole(ctx.view, device);
    const fresh: DeviceUpdateRow = {
      deviceId: device,
      rolloutId: id,
      sameVersion: deviceById(ctx.view, device)?.firmware === image.version,
      state: DeviceUpdateState.Planned,
      method: role === Role.Sensor ? UpdateMethod.JoinWifi : UpdateMethod.OwnLink,
      held: UpdateHeld.No,
      bytes: 0,
      attempts: 0,
      lastReason: null,
      sinceMs: ctx.now.wall,
      bleNonce: null,
      bleExpiresMs: null,
      remindedMs: null,
    };
    for (const kind of [
      "trialWatch",
      "sessionExpiry",
      "armedReminder",
      "gatewayBusyRetry",
    ] as const) {
      steps.clear({ module: "firmware", kind, device });
    }
    const entry: DeviceEntry = {
      row: fresh,
      told: undefined,
      event: undefined,
      eventAt: undefined,
      busyHolds: 0,
      armedSince: undefined,
      forced: false,
      discard: false,
      deviceHeld: undefined,
    };
    putEntry(steps, published(steps, entry));
    steps.push(writeUpdate(fresh));
  }
  steps.pushResult(
    firmwareDecision(ctx, "rollout_started", {
      value: id,
      detail: actorText(actor),
      cause: record,
    }),
  );
  advance(steps, ctx);
  const now = steps.slice.rollouts.get(id);
  steps.answer(
    answerTo,
    now === undefined ? rolloutObject(steps, rollout) : rolloutObject(steps, now),
  );
}

/** The rollout a `rollout.*` operation names, if it is the open one; else answered. */
function namedOpen(steps: Steps, answerTo: AnswerTo, id: number): Rollout | undefined {
  const named = steps.slice.rollouts.get(rolloutId(id));
  if (named === undefined) {
    steps.refuse(answerTo, { code: "notFound", detail: { what: "rollout", id } });
    return undefined;
  }
  if (named.row.endedMs !== null) {
    steps.refuse(answerTo, { code: "invalid", detail: { field: "rollout", reason: "range" } });
    return undefined;
  }
  return named;
}

function rolloutPause(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  record: Seq,
  id: number,
): void {
  if (namedOpen(steps, answerTo, id) === undefined) return;
  pause(steps, ctx, null, null, record);
  const after = steps.slice.rollouts.get(rolloutId(id));
  if (after !== undefined) steps.answer(answerTo, rolloutObject(steps, after));
}

/** Puts a device back to planned for another try: after a refusal, a rollback, a busy hold. */
function retryDevice(steps: Steps, ctx: Context, device: DeviceId, forced: boolean): void {
  const entry = steps.slice.updates.get(device);
  if (entry === undefined) return;
  putEntry(steps, {
    ...entry,
    forced,
    busyHolds: forced ? entry.busyHolds : 0,
    told: undefined,
    deviceHeld: undefined,
  });
  if (!inProgress(entry.row.state) || entry.row.held === UpdateHeld.GatewayBusy) {
    steps.clear({ module: "firmware", kind: "gatewayBusyRetry", device });
    if (!inProgress(entry.row.state)) {
      transition(steps, ctx, device, DeviceUpdateState.Planned, { attempts: 0, lastReason: null });
    }
    setHeld(steps, ctx, device, UpdateHeld.No);
  }
}

function rolloutResume(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  actor: Actor,
  record: Seq,
  body: Extract<AppOpV2, { readonly op: "rollout.resume" }>["body"],
): void {
  const rollout = namedOpen(steps, answerTo, body.rollout);
  if (rollout === undefined) return;
  if (imageGone(steps.slice, rollout)) {
    // Its image was dropped as damaged: added again, the rollout may go on.
    steps.refuse(answerTo, { code: "notFound", detail: { what: "image", id: rollout.row.image } });
    return;
  }
  if (body.device !== undefined) {
    const device = deviceId(body.device);
    if (!rollout.devices.includes(device)) {
      steps.refuse(answerTo, {
        code: "invalid",
        detail: { field: "device", reason: "unknownReference" },
      });
      return;
    }
    if (body.force === true && workingRole(ctx.view, device) !== Role.Gateway) {
      steps.refuse(answerTo, { code: "invalid", detail: { field: "force", reason: "range" } });
      return;
    }
    retryDevice(steps, ctx, device, body.force === true);
  }
  if (rollout.row.stage === RolloutStage.Paused) {
    const paused = rollout.row.pausedDevice;
    if (paused !== null && body.device === undefined) retryDevice(steps, ctx, paused, false);
    const now = steps.slice.rollouts.get(rollout.row.id) ?? rollout;
    resumeStage(steps, ctx, now);
    steps.pushResult(
      firmwareDecision(ctx, "rollout_resumed", {
        value: rollout.row.id,
        detail: actorText(actor),
        cause: record,
      }),
    );
  }
  advance(steps, ctx);
  const after = steps.slice.rollouts.get(rollout.row.id);
  if (after !== undefined) steps.answer(answerTo, rolloutObject(steps, after));
}

function rolloutCancel(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  actor: Actor,
  record: Seq,
  id: number,
): void {
  const rollout = namedOpen(steps, answerTo, id);
  if (rollout === undefined) return;
  const ended = cancel(steps, ctx, rollout, record, actorText(actor));
  steps.answer(answerTo, rolloutObject(steps, ended));
}

function rolloutStatus(steps: Steps, answerTo: AnswerTo): void {
  const rollout = latestRollout(steps);
  const devices =
    rollout === undefined
      ? []
      : rollout.devices.flatMap((id) => {
          const entry = steps.slice.updates.get(id);
          return entry?.row.rolloutId === rollout.row.id ? [rolloutDevice(steps, entry)] : [];
        });
  steps.answer(answerTo, {
    rollout: rollout === undefined ? null : rolloutObject(steps, rollout),
    devices,
  });
}

/** Where the shell sends a session's reply: the app connection or the control line that asked. */
type SessionTo = Extract<Effect, { readonly kind: "bluetoothSession" }>["to"];

/**
 * The session's reply for the shell (`bluetoothSession`, which adds the key it derives from the
 * device's key and `nonce`) and the answer the asking module records: the marker of `codes.ts`,
 * never the key or the nonce. `app` records it in `commands` and `people` keeps it for the `seq`;
 * `control` records it in `commands`; neither sends it, as the shell's reply is the one sent.
 */
function sendSession(
  steps: Steps,
  answerTo: AnswerTo,
  to: SessionTo,
  session: {
    readonly device: DeviceId;
    readonly address: number;
    readonly role: number;
    readonly image: FirmwareImageRow;
    readonly nonce: Uint8Array;
    readonly expiresAtMs: number;
    readonly expiresInMs: number;
    readonly windowTens: number;
  },
): void {
  const { device, address, image } = session;
  steps.push({
    kind: "bluetoothSession",
    to,
    device,
    address,
    nonce: session.nonce,
    reply: {
      device,
      address,
      imageId: hex(image.imageId),
      version: versionText(image.version),
      fileBytes: image.bytes + IMAGE_HEADER_BYTES,
      sha256: hex(image.sha256),
      windowS: session.windowTens * WINDOW_UNIT_S,
      expiresInMs: session.expiresInMs,
      // A sensor learns of it at its next reply; a siren or gateway is told at once.
      needsWake: session.role === Role.Sensor,
    },
  });
  steps.answer(answerTo, sessionGranted(device, session.expiresAtMs));
}

/**
 * `firmware.bluetooth {device}` (section 5, step 1): a change like any other, answered in the step
 * that grants it. Refusals in order: not paired, no image planned (none open naming the device, its
 * image dropped as damaged, or the device past fetching), on trial; then, for a new session, the
 * holds (armed, battery, countdown, alarm, site move); then a key change. A new session takes a
 * nonce from the input's entropy, committed (`ble_nonce`, its expiry) before the shell derives the
 * session key and replies.
 *
 * Asked again while the device's session lives (a new `seq`, another client, the console, or a
 * retry of the `seq` that was given it, which `app` sends here only while that session lives), it
 * is answered with the same session: the same nonce, so the same key, and the time left of its
 * life. Nothing else is done: no nonce drawn, no timer, no write, no decision, no offer. The holds
 * do not refuse it, since a live session goes ahead of them (`decide.ts`); the refusals before them
 * and a key change do, since with them the session serves nothing or its key is not the one given.
 */
function bluetooth(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  actor: Actor,
  record: Seq,
  id: number,
): void {
  const device = deviceId(id);
  const refusals = FIRMWARE_BLUETOOTH_REFUSALS;
  const row = deviceById(ctx.view, device);
  const role = workingRole(ctx.view, device);
  if (row === undefined || role === undefined || !DEVICE_ROLES.includes(role)) {
    steps.refuse(answerTo, refusals.notPaired);
    return;
  }
  const rollout = openRollout(steps.slice);
  const entry = steps.slice.updates.get(device);
  const image = rollout === undefined ? undefined : steps.slice.images.get(rollout.row.image);
  if (
    entry === undefined ||
    image?.removedMs !== null ||
    entry.row.rolloutId !== rollout?.row.id ||
    !FETCHABLE.has(entry.row.state)
  ) {
    steps.refuse(answerTo, refusals.noImage);
    return;
  }
  if (seenOf(steps.slice, device).onTrial) {
    steps.refuse(answerTo, refusals.onTrial);
    return;
  }
  const live = sessionOf(entry, ctx.now);
  if (live === undefined) {
    const facts = factsOf(ctx);
    if (role === Role.Sensor && armedForUser(ctx.view, device)) {
      steps.refuse(answerTo, refusals.armed);
      return;
    }
    if (lowBattery(steps.slice, facts, device, role)) {
      steps.refuse(answerTo, refusals.battery);
      return;
    }
    const climate = climateOf(ctx.view);
    if (climate !== "quiet") {
      steps.refuse(answerTo, refusals[climate]);
      return;
    }
  }
  if (steps.slice.rekey.has(device)) {
    steps.refuse(answerTo, refusals.keyChange);
    return;
  }
  const to: SessionTo | undefined =
    answerTo.kind === "app"
      ? { kind: "app", conn: answerTo.conn, id: answerTo.id }
      : answerTo.kind === "control"
        ? { kind: "control", request: answerTo.request }
        : undefined;
  if (to === undefined) {
    steps.refuse(answerTo, { code: "unavailable", detail: {} });
    return;
  }
  const fw = ctx.deps.rules.firmware;
  const session = {
    device,
    address: row.address,
    role,
    image,
    windowTens: fw.bluetoothWindowTens,
  };
  const liveUntil = entry.row.bleExpiresMs;
  if (live !== undefined && liveUntil !== null) {
    sendSession(steps, answerTo, to, {
      ...session,
      nonce: live,
      expiresAtMs: liveUntil,
      expiresInMs: liveUntil - ctx.now.wall,
    });
    return;
  }
  const nonce = ctx.entropy.take(8);
  if (nonce.isErr()) {
    steps.fail(nonce.error);
    return;
  }
  steps.timer(
    { module: "firmware", kind: "sessionExpiry", device },
    monoAfterMs(ctx.now.mono, fw.bluetoothSessionMs),
  );
  const expiresAtMs = ctx.now.wall + fw.bluetoothSessionMs;
  const changed: DeviceUpdateRow = {
    ...entry.row,
    bleNonce: nonce.value,
    bleExpiresMs: expiresAtMs,
  };
  putEntry(steps, published(steps, { ...entry, row: changed, told: undefined }));
  steps.push(writeUpdate(changed));
  steps.pushResult(
    firmwareDecision(ctx, "firmware_session_opened", {
      device,
      detail: actorText(actor),
      cause: record,
    }),
  );
  sendSession(steps, answerTo, to, {
    ...session,
    nonce: nonce.value,
    expiresAtMs,
    expiresInMs: fw.bluetoothSessionMs,
  });
  if (role !== Role.Sensor) {
    deliver(steps, ctx, device, { kind: "fetch", via: "bluetooth" }, undefined, true);
  }
}

/**
 * One of firmware's operations, answered with `opAnswer`; a granted session's reply, with its key,
 * is also the shell's to send (`bluetoothSession`).
 */
export function firmwareOp(
  steps: Steps,
  ctx: Context,
  op: AppOpV2,
  actor: Actor,
  answerTo: AnswerTo,
  record: Seq,
): void {
  const refusal = refusalFor(ctx, actor, op);
  if (refusal !== undefined) {
    steps.refuse(answerTo, refusal);
    return;
  }
  switch (op.op) {
    case "firmware.list":
      firmwareList(steps, ctx, answerTo);
      return;
    case "firmware.offers":
      steps.answer(answerTo, offersReply(steps));
      return;
    case "firmware.fetch":
      fetch(steps, ctx, answerTo, actor, record, op.body.version);
      return;
    case "firmware.upload":
      upload(steps, ctx, answerTo, actor, record, op.body);
      return;
    case "firmware.remove":
      remove(steps, ctx, answerTo, actor, record, op.body.image);
      return;
    case "firmware.download":
      download(steps, answerTo, op.body.image);
      return;
    case "firmware.bluetooth":
      bluetooth(steps, ctx, answerTo, actor, record, op.body.device);
      return;
    case "rollout.start":
      rolloutStart(steps, ctx, answerTo, actor, record, op.body);
      return;
    case "rollout.pause":
      rolloutPause(steps, ctx, answerTo, record, op.body.rollout);
      return;
    case "rollout.resume":
      rolloutResume(steps, ctx, answerTo, actor, record, op.body);
      return;
    case "rollout.cancel":
      rolloutCancel(steps, ctx, answerTo, actor, record, op.body.rollout);
      return;
    case "rollout.status":
      rolloutStatus(steps, answerTo);
      return;
    default:
      steps.refuse(answerTo, { code: "notBuilt", detail: { op: op.op } });
      return;
  }
}

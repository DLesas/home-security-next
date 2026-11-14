/**
 * The site module's handler (hub-design.md section 2, module 9; section 8, "Changing the site's
 * channel or rate"; protocol.md §7; D115): the over-the-air move of the site's channel and rate
 * from the hub's side, and the site's own settings.
 *
 * - **Request** (`hsn site change`): refused while a move is in progress or when nothing would
 *   change; otherwise the move starts announcing. Its row is written now and `siteMove` tells the
 *   sensors module, which gives every sensor a version announcing the next settings, in the same
 *   commit, before any reply carries them.
 * - **Announce**: a sensor's newest packet naming a version that carries the move confirms it
 *   (`siteConfirmed`, written now by sensors); one silent through 4 † of its intervals raises
 *   `move_stalled`, once. The hub never switches by itself while one has not confirmed.
 * - **Switch**, when every sensor confirmed, or when forced, and never while a countdown or the
 *   alarm runs: the row's channel and rate become the target, written now, and `siteMove`
 *   switched lets gateways, sirens, sensors and slots make their new settings in the same commit.
 * - **Follow**: a sensor's packet on the new channel and rate follows it (`siteFollowed`); a siren's
 *   LoRa packet on them, or the sirens module's `siteFollowed`, follows a siren. The move is done
 *   when all have followed, or when the silence grace has run out for the rest (`move_done`).
 * - **Cancel** and **force**, only while announcing; a restart resumes at its stage.
 */
import { ok, type Result } from "neverthrow";
import type { ControlReply } from "../model/control.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import { type DeviceId, HUB_DEVICE, type RequestId, type Seq } from "../model/ids.ts";
import type { Internal, SiteChangeAction } from "../model/messages.ts";
import {
  DeviceState,
  MoveStage,
  type MoveStageName,
  NEXT_SETTING_STAYS,
  type SensorConfigRow,
  type SiteRow,
} from "../model/rows.ts";
import type { HubRules } from "../model/rules.ts";
import { type Mono, monoAfterMs, msBetween } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import {
  clearTimer,
  decisionMessage,
  DEFAULT_HEARTBEAT_UNITS,
  effectiveIntervalMs,
  foldOut,
  sensorEntry,
  sensorIntervalMs,
  versionCarriesMove,
  versionNamed,
} from "../sensors/view.ts";
import { countdownOrAlarmRunning } from "../alarm/view.ts";
import { decision } from "../util/records.ts";
import type { SensorPart, SiteSlice } from "./state.ts";
import { hasFollowed, moveOfRow, oneRateMask, onSiteSettings, rateOfRow } from "./view.ts";

type Out = Internal | Effect;
type Step = Result<Handled<"site">, CoreFault>;

/** Routine readings are kept 30 days, events a year (D57; section 6, "Retention"). */
const RETENTION_ROUTINE_DAYS = 30;
const RETENTION_EVENT_DAYS = 365;
/** A protocol `Role` (§6). */
const ROLE_SENSOR = 1;
const ROLE_SIREN = 2;

/** The site row of a hub that has none yet: no channel, the default rate ‡ (section 8). */
export function defaultSiteRow(rules: HubRules): SiteRow {
  return {
    channel: null,
    rateMask: oneRateMask(rules.site.defaultRate),
    moveId: 0,
    moveStage: MoveStage.None,
    moveChannel: null,
    moveRate: null,
    moveActor: null,
    moveRequestedMs: null,
    moveForced: false,
    moveSwitchedBoot: null,
    moveSwitchedMono: null,
    wifiName: new Uint8Array(),
    wifiPassword: new Uint8Array(),
    countdownDefaultS: rules.arming.countdownDefaultS,
    autoStopS: rules.arming.autoStopS,
    replyPowerDbm: rules.powers.defaultTxPowerDbm,
    sirenPowerDbm: rules.powers.sirenTxPowerDbm,
    retentionRoutineDays: RETENTION_ROUTINE_DAYS,
    retentionEventDays: RETENTION_EVENT_DAYS,
  };
}

function rowWrite(row: SiteRow): Effect {
  return { kind: "write", durability: "now", op: { table: "site", op: "upsert", row } };
}

function answer(request: RequestId, reply: ControlReply): Internal {
  return { kind: "answer", request, reply };
}

function refusal(
  request: RequestId,
  code: Extract<ControlReply, { ok: false }>["error"]["code"],
  message: string,
  names?: readonly string[],
): Internal {
  const error = names === undefined ? { code, message } : { code, message, names };
  return answer(request, { ok: false, error });
}

/** The interval a sensor keeps (§7), or the default's at the site's rate before sensors holds it. */
function intervalOf(ctx: Context, sensor: DeviceId): number {
  return (
    sensorIntervalMs(ctx.view, sensor) ??
    effectiveIntervalMs(DEFAULT_HEARTBEAT_UNITS, rateOfRow(ctx.view.site.row, ctx.deps.rules))
  );
}

function nameOf(ctx: Context, sensor: DeviceId): string {
  return sensorEntry(ctx.view, sensor)?.name ?? `device-${sensor}`;
}

function stageOf(row: SiteRow): MoveStageName | undefined {
  return moveOfRow(row)?.stage;
}

/** `move_stalled` for a sensor waited for since `since`, after 4 † of its intervals (section 8). */
function stallTimer(
  ctx: Context,
  sensor: DeviceId,
  since: Mono,
  intervalMs: number,
): TimerOf<"site"> {
  return {
    at: monoAfterMs(since, ctx.deps.rules.siteMove.stallIntervals * intervalMs),
    key: { module: "site", kind: "moveStalled", sensor },
  };
}

/** The sensors of the move still to confirm, in order of pairing. */
function unconfirmed(slice: SiteSlice): readonly DeviceId[] {
  return [...slice.sensors]
    .filter(([, part]) => part.confirmed !== slice.row.moveId)
    .map(([device]) => device)
    .toSorted((a, b) => a - b);
}

/** The sensors and sirens not yet followed, the left-behind apart. */
function notFollowed(slice: SiteSlice): readonly DeviceId[] {
  const sensors = [...slice.sensors]
    .filter(([device, part]) => part.followed !== slice.row.moveId && !slice.leftBehind.has(device))
    .map(([device]) => device);
  const sirens = [...slice.sirens].filter(([, followed]) => !followed).map(([device]) => device);
  return [...sensors, ...sirens].toSorted((a, b) => a - b);
}

/** Device ids as `detail` bytes, u32 little-endian each, for the decisions that name several. */
function idsDetail(devices: readonly DeviceId[]): Uint8Array {
  const detail = new Uint8Array(devices.length * 4);
  const view = new DataView(detail.buffer);
  devices.forEach((device, i) => {
    view.setUint32(i * 4, device, true);
  });
  return detail;
}

function siteMoveMessage(row: SiteRow, stage: MoveStageName): Internal {
  const channel =
    row.moveChannel === null || row.moveChannel === NEXT_SETTING_STAYS
      ? undefined
      : row.moveChannel;
  const rate =
    row.moveRate === null || row.moveRate === NEXT_SETTING_STAYS ? undefined : row.moveRate;
  return { kind: "siteMove", move: row.moveId, stage, channel, rate, forced: row.moveForced };
}

// ——— Boot and devices ———

function onBoot(
  slice: SiteSlice,
  snapshot: DurableSnapshot,
  ctx: Context,
  bootId: SiteSlice["boot"],
): Step {
  const row = snapshot.site ?? defaultSiteRow(ctx.deps.rules);
  const live = snapshot.devices.filter((d) => d.state !== DeviceState.Removed);
  const configs = new Map(snapshot.sensorConfig.map((config) => [config.deviceId, config]));
  const sensors = new Map<DeviceId, SensorPart>(
    live
      .filter((d) => d.role === ROLE_SENSOR)
      .map((d) => [
        d.id,
        {
          confirmed: configs.get(d.id)?.moveConfirmed ?? 0,
          followed: configs.get(d.id)?.moveFollowed ?? 0,
          waitingSince: ctx.now.mono,
        },
      ]),
  );
  // A siren's follow is not saved (section 6 has no column for it); after a restart it follows again.
  const sirens = new Map<DeviceId, boolean>(
    live
      .filter((d) => d.role === ROLE_SIREN)
      .map((d) => [d.id, row.moveStage !== MoveStage.Switched]),
  );
  const leftBehind = new Set(
    live.filter((d) => d.state === DeviceState.LeftBehind).map((d) => d.id),
  );
  const mark = snapshot.deviceState.find((state) => state.deviceId === HUB_DEVICE);
  // The switch time is re-expressed like a countdown; with the downtime unknown (D113) the grace
  // counts from this start (section 8, "A restart in each stage").
  const sameBootMark =
    mark !== undefined && row.moveSwitchedMono !== null && mark.boot === row.moveSwitchedBoot;
  const switchedBeforeStopMs = sameBootMark
    ? msBetween(row.moveSwitchedMono, mark.lastSeenMono)
    : undefined;
  const next: SiteSlice = {
    ...slice,
    timers: [],
    boot: bootId,
    startedAt: ctx.now.mono,
    row,
    sensors,
    sirens,
    leftBehind,
    switchedAt: row.moveStage === MoveStage.Switched ? ctx.now.mono : undefined,
    before: undefined,
    switchedBeforeStopMs,
  };
  // Sensors has not read the snapshot yet (it runs after site), so its rows are read here.
  const unitsOf = (sensor: DeviceId): number =>
    configs.get(sensor)?.heartbeatUnits ?? DEFAULT_HEARTBEAT_UNITS;
  const intervalAtBoot = (sensor: DeviceId): number =>
    bootInterval(configs.get(sensor), ctx.deps.rules, row);
  const timers =
    row.moveStage === MoveStage.Announcing
      ? unconfirmed(next).map((sensor) =>
          stallTimer(ctx, sensor, ctx.now.mono, intervalAtBoot(sensor)),
        )
      : row.moveStage === MoveStage.Switched
        ? [graceTimer(ctx, next, ctx.now.mono, unitsOf)]
        : [];
  return ok({ slice: { ...next, timers }, out: [] });
}

/** A sensor's interval from its saved row, or the default's at the site's rate. */
function bootInterval(config: SensorConfigRow | undefined, rules: HubRules, row: SiteRow): number {
  return config === undefined
    ? effectiveIntervalMs(DEFAULT_HEARTBEAT_UNITS, rateOfRow(row, rules))
    : effectiveIntervalMs(config.heartbeatUnits, config.sendRate);
}

/** A sensor's heartbeat units as sensors holds them, or the default. */
function unitsNow(ctx: Context): (sensor: DeviceId) => number {
  return (sensor) =>
    sensorEntry(ctx.view, sensor)?.config.heartbeatUnits ?? DEFAULT_HEARTBEAT_UNITS;
}

/**
 * The end of the silence grace after a switch (section 8): 4 † of the longest interval of any
 * sensor, old or new; the move is done then for whoever has not followed.
 */
function graceTimer(
  ctx: Context,
  slice: SiteSlice,
  switchedAt: Mono,
  unitsOf: (sensor: DeviceId) => number,
): TimerOf<"site"> {
  const rules = ctx.deps.rules;
  const longest = Math.max(
    0,
    ...[...slice.sensors.keys()].map((sensor) => {
      const units = unitsOf(sensor);
      const newRate = rateOfRow(slice.row, rules);
      const oldRate = slice.before?.rate ?? newRate;
      return Math.max(effectiveIntervalMs(units, oldRate), effectiveIntervalMs(units, newRate));
    }),
  );
  return {
    at: monoAfterMs(switchedAt, rules.siteMove.silenceGraceIntervals * longest),
    key: { module: "site", kind: "followGraceEnd" },
  };
}

function onDeviceAdded(slice: SiteSlice, device: DeviceId, role: number, ctx: Context): SiteSlice {
  if (role === ROLE_SIREN) {
    // After the switch, pairing gives the new settings: nothing to follow (section 8).
    return {
      ...slice,
      sirens: new Map(slice.sirens).set(device, stageOf(slice.row) !== "switched"),
    };
  }
  if (role !== ROLE_SENSOR) return slice;
  const announcing = slice.row.moveStage === MoveStage.Announcing;
  const switched = slice.row.moveStage === MoveStage.Switched;
  // Paired during the announcement: waited for like every other sensor; after the switch, it is
  // paired with the new settings, so it has nothing to follow (section 8, "Pairing during a move").
  const part: SensorPart = {
    confirmed: 0,
    followed: switched ? slice.row.moveId : 0,
    waitingSince: ctx.now.mono,
  };
  return {
    ...slice,
    sensors: new Map(slice.sensors).set(device, part),
    timers: announcing
      ? [...slice.timers, stallTimer(ctx, device, ctx.now.mono, intervalOf(ctx, device))]
      : slice.timers,
  };
}

function onDeviceRemoved(slice: SiteSlice, device: DeviceId): SiteSlice {
  const sensors = new Map(slice.sensors);
  sensors.delete(device);
  const sirens = new Map(slice.sirens);
  sirens.delete(device);
  const leftBehind = new Set(slice.leftBehind);
  leftBehind.delete(device);
  return {
    ...slice,
    sensors,
    sirens,
    leftBehind,
    timers: clearTimer(slice.timers, { module: "site", kind: "moveStalled", sensor: device }),
  };
}

// ——— The move's commands ———

function startMove(
  slice: SiteSlice,
  request: Extract<Internal, { kind: "siteChangeRequested" }>,
  action: Extract<SiteChangeAction, { kind: "start" }>,
  ctx: Context,
): Step {
  const { row } = slice;
  const rules = ctx.deps.rules;
  const stage = stageOf(row);
  if (stage === "announcing" || stage === "switched") {
    return ok({
      slice,
      out: [refusal(request.request, "moveInProgress", `move ${row.moveId} is ${stage}`)],
    });
  }
  const rate = rateOfRow(row, rules);
  const channelChanges = action.channel !== undefined && action.channel !== row.channel;
  const rateChanges = action.rate !== undefined && action.rate !== rate;
  if (!channelChanges && !rateChanges) {
    return ok({
      slice,
      out: [refusal(request.request, "nothingToChange", "the target is the current setting")],
    });
  }
  const moveChannel = channelChanges ? action.channel : NEXT_SETTING_STAYS;
  const moveRate = rateChanges ? action.rate : NEXT_SETTING_STAYS;
  const nextRow: SiteRow = {
    ...row,
    moveId: row.moveId + 1,
    moveStage: MoveStage.Announcing,
    moveChannel,
    moveRate,
    moveActor: request.actor,
    moveRequestedMs: ctx.now.wall,
    moveForced: false,
    moveSwitchedBoot: null,
    moveSwitchedMono: null,
  };
  const sensors = new Map(
    [...slice.sensors].map(([device, part]) => [
      device,
      { ...part, confirmed: 0, waitingSince: ctx.now.mono },
    ]),
  );
  const next: SiteSlice = {
    ...slice,
    row: nextRow,
    sensors,
    timers: [...sensors.keys()].map((sensor) =>
      stallTimer(ctx, sensor, ctx.now.mono, intervalOf(ctx, sensor)),
    ),
  };
  return decisionMessage(
    ctx,
    {
      kind: "move_requested",
      device: null,
      cause: request.record,
      // The move's number; its target as a reply's next settings carry it (§6): the channel, then
      // the rate, one byte each, 0xFF for one that stays.
      value: nextRow.moveId,
      detail: new Uint8Array([moveChannel, moveRate]),
    },
    "now",
  ).map((recorded) => ({
    slice: next,
    out: [
      rowWrite(nextRow),
      siteMoveMessage(nextRow, "announcing"),
      recorded,
      answer(request.request, {
        ok: true,
        result: {
          kind: "siteChange",
          channel: channelChanges ? action.channel : (row.channel ?? 0),
          rate: rateChanges ? action.rate : rate,
          sensors: sensors.size,
        },
      }),
    ],
  }));
}

function cancelMove(slice: SiteSlice, request: RequestId, record: Seq, ctx: Context): Step {
  if (slice.row.moveStage !== MoveStage.Announcing) {
    return ok({
      slice,
      out: [refusal(request, "notAnnouncing", "switched; a move back is a new move")],
    });
  }
  const row: SiteRow = { ...slice.row, moveStage: MoveStage.Cancelled };
  const next: SiteSlice = { ...slice, row, timers: [] };
  return decisionMessage(
    ctx,
    { kind: "move_cancelled", device: null, cause: record, value: row.moveId },
    "routine",
  ).map((recorded) => ({
    slice: next,
    out: [
      rowWrite(row),
      siteMoveMessage(row, "cancelled"),
      recorded,
      answer(request, {
        ok: true,
        result: { kind: "siteChangeCancel", sensors: slice.sensors.size },
      }),
    ],
  }));
}

function forceMove(
  slice: SiteSlice,
  request: RequestId,
  record: Seq,
  yes: boolean,
  ctx: Context,
): Step {
  if (slice.row.moveStage !== MoveStage.Announcing) {
    return ok({
      slice,
      out: [refusal(request, "notAnnouncing", "switched; a move back is a new move")],
    });
  }
  const behind = unconfirmed(slice);
  const names = behind.map((sensor) => nameOf(ctx, sensor));
  if (!yes) {
    // Nothing is switched; each sensor that would be left behind is named (the bench's
    // `move_unconfirmed`).
    const named = foldOut(behind, undefined, (state, sensor) =>
      decisionMessage(
        ctx,
        { kind: "move_unconfirmed", device: sensor, cause: record, value: slice.row.moveId },
        "routine",
      ).map((recorded) => ({ state, out: [recorded] })),
    );
    return named.map(({ out }) => ({
      slice,
      out: [
        ...out,
        answer(request, {
          ok: true,
          result: { kind: "siteChangeForce", switched: false, leftBehind: names },
        }),
      ],
    }));
  }
  const row: SiteRow = { ...slice.row, moveForced: true };
  const forced: SiteSlice = { ...slice, row };
  // Forced, the switch still waits for a running countdown or alarm (section 8, "Switch").
  return trySwitch(forced, ctx).map((done) => ({
    slice: done.slice,
    out: [
      ...(done.slice.row.moveStage === MoveStage.Switched ? [] : [rowWrite(row)]),
      ...done.out,
      answer(request, {
        ok: true,
        result: {
          kind: "siteChangeForce",
          switched: done.slice.row.moveStage !== MoveStage.Announcing,
          leftBehind: names,
        },
      }),
    ],
  }));
}

function statusOf(slice: SiteSlice, request: RequestId, ctx: Context): Internal {
  const move = moveOfRow(slice.row);
  const wallOf = (at: Mono): number =>
    Math.max(0, Math.round(ctx.now.wall + msBetween(ctx.now.mono, at)));
  const grace = slice.timers.find((timer) => timer.key.kind === "followGraceEnd");
  const rules = ctx.deps.rules;
  const moveView =
    move === undefined
      ? null
      : {
          id: move.id,
          stage: move.stage,
          channel: move.channel ?? slice.row.channel ?? 0,
          rate: move.rate ?? rateOfRow(slice.row, rules),
          forced: move.forced,
          confirmed: slice.sensors.size - unconfirmed(slice).length,
          followed: [...slice.sensors.values()].filter((part) => part.followed === move.id).length,
          total: slice.sensors.size,
          waiting: (move.stage === "announcing" ? unconfirmed(slice) : notFollowed(slice))
            .filter((device) => slice.sensors.has(device))
            .map((device) => ({
              name: nameOf(ctx, device),
              sinceMs: wallOf(slice.sensors.get(device)?.waitingSince ?? ctx.now.mono),
            })),
          graceEndsMs: grace === undefined ? null : wallOf(grace.at),
        };
  return answer(request, { ok: true, result: { kind: "siteChangeStatus", move: moveView } });
}

// ——— Switch, follow, done ———

/** Switches when the move is ready: all confirmed or forced, and no countdown or alarm running. */
function trySwitch(slice: SiteSlice, ctx: Context): Step {
  const { row } = slice;
  if (row.moveStage !== MoveStage.Announcing) return ok({ slice, out: [] });
  const behind = unconfirmed(slice);
  if (behind.length > 0 && !row.moveForced) return ok({ slice, out: [] });
  if (countdownOrAlarmRunning(ctx.view)) {
    // Due, but it waits for the countdown or alarm to end (section 8, "Switch"): said once.
    if (slice.switchWaiting) return ok({ slice, out: [] });
    return decisionMessage(
      ctx,
      { kind: "move_switch_waiting", device: null, cause: null, value: row.moveId },
      "routine",
    ).map((recorded) => ({ slice: { ...slice, switchWaiting: true }, out: [recorded] }));
  }
  const rules = ctx.deps.rules;
  const before = { channel: row.channel, rate: rateOfRow(row, rules) };
  const channel =
    row.moveChannel === null || row.moveChannel === NEXT_SETTING_STAYS
      ? row.channel
      : row.moveChannel;
  const rate =
    row.moveRate === null || row.moveRate === NEXT_SETTING_STAYS ? before.rate : row.moveRate;
  const switchedRow: SiteRow = {
    ...row,
    channel,
    rateMask: oneRateMask(rate),
    moveStage: MoveStage.Switched,
    moveSwitchedBoot: slice.boot,
    moveSwitchedMono: ctx.now.mono,
  };
  const leftBehind = row.moveForced ? new Set([...slice.leftBehind, ...behind]) : slice.leftBehind;
  const sirens = new Map([...slice.sirens.keys()].map((siren) => [siren, false]));
  const switched: SiteSlice = {
    ...slice,
    row: switchedRow,
    leftBehind,
    sirens,
    switchedAt: ctx.now.mono,
    before,
    timers: [],
    switchWaiting: false,
  };
  const withGrace = {
    ...switched,
    timers: [graceTimer(ctx, switched, ctx.now.mono, unitsNow(ctx))],
  };
  const switchedDecision = decisionMessage(
    ctx,
    { kind: "move_switched", device: null, cause: null, value: row.moveForced ? 1 : 0 },
    "now",
  );
  // A forced move leaves each unconfirmed sensor behind: `move_forced` names it, the registry
  // sets it to state 5 in `devices` (section 8, "Force"), and sensors raise that alert instead
  // of silence (`leftBehind`, read through this module's view).
  const forcedDecisions = foldOut(row.moveForced ? behind : [], undefined, (state, sensor) =>
    decision(ctx, "now", {
      kind: "move_forced",
      device: sensor,
      cause: null,
      value: row.moveId,
    }).map(({ seq, message }) => ({
      state,
      out: [
        message,
        { kind: "deviceLeftBehind" as const, device: sensor, move: row.moveId, cause: seq },
      ],
    })),
  );
  return switchedDecision.andThen((recorded) =>
    forcedDecisions.andThen((forcedOut) =>
      tryDone(withGrace, ctx).map((done) => ({
        slice: done.slice,
        out: [
          rowWrite(switchedRow),
          siteMoveMessage(switchedRow, "switched"),
          recorded,
          ...forcedOut.out,
          ...done.out,
        ],
      })),
    ),
  );
}

/** Ends the move when every sensor and siren followed, or `graceOver` (section 8, "Follow"). */
function tryDone(slice: SiteSlice, ctx: Context, graceOver = false): Step {
  if (slice.row.moveStage !== MoveStage.Switched) return ok({ slice, out: [] });
  const missing = notFollowed(slice);
  if (missing.length > 0 && !graceOver) return ok({ slice, out: [] });
  const row: SiteRow = { ...slice.row, moveStage: MoveStage.Done };
  return decisionMessage(
    ctx,
    {
      kind: "move_done",
      device: null,
      cause: null,
      value: missing.length,
      detail: idsDetail(missing),
    },
    "now",
  ).map((recorded) => ({
    slice: { ...slice, row, timers: [], switchedAt: undefined },
    out: [rowWrite(row), siteMoveMessage(row, "done"), recorded],
  }));
}

function confirm(slice: SiteSlice, sensor: DeviceId, cause: Seq, ctx: Context): Step {
  const part = slice.sensors.get(sensor);
  if (part === undefined) return ok({ slice, out: [] });
  const move = slice.row.moveId;
  const next: SiteSlice = {
    ...slice,
    sensors: new Map(slice.sensors).set(sensor, { ...part, confirmed: move }),
    timers: clearTimer(slice.timers, { module: "site", kind: "moveStalled", sensor }),
  };
  return decisionMessage(
    ctx,
    { kind: "move_confirmed", device: sensor, cause, value: move },
    "routine",
  ).map((recorded) => ({
    slice: next,
    out: [{ kind: "siteConfirmed", move, sensor, cause }, recorded],
  }));
}

function follow(
  slice: SiteSlice,
  device: DeviceId,
  cause: Seq,
  ctx: Context,
  announce: boolean,
): Step {
  const move = slice.row.moveId;
  const part = slice.sensors.get(device);
  const next: SiteSlice =
    part !== undefined
      ? { ...slice, sensors: new Map(slice.sensors).set(device, { ...part, followed: move }) }
      : { ...slice, sirens: new Map(slice.sirens).set(device, true) };
  return decisionMessage(ctx, { kind: "device_followed", device, cause, value: move }, "now").map(
    (recorded) => ({
      slice: next,
      out: [
        ...(announce ? [{ kind: "siteFollowed" as const, move, device, cause }] : []),
        recorded,
      ],
    }),
  );
}

function onAccepted(
  slice: SiteSlice,
  message: Extract<Internal, { kind: "accepted" }>,
  ctx: Context,
): Step {
  const { device, record } = message;
  const row = slice.row;
  if (row.moveStage === MoveStage.Announcing && message.newest && slice.sensors.has(device)) {
    const version = versionNamed(message.message);
    const part = slice.sensors.get(device);
    if (
      version !== undefined &&
      part?.confirmed !== row.moveId &&
      versionCarriesMove(ctx.view, device, version, row.moveId)
    ) {
      return confirm(slice, device, record, ctx);
    }
    return ok({ slice, out: [] });
  }
  if (row.moveStage !== MoveStage.Switched) return ok({ slice, out: [] });
  const view = { ...ctx.view, site: slice };
  const sensorPending =
    slice.sensors.has(device) && !hasFollowed(view, device) && !slice.leftBehind.has(device);
  const sirenPending = slice.sirens.get(device) === false;
  if ((sensorPending || sirenPending) && onSiteSettings(view, ctx.deps.rules, message.arrival)) {
    return follow(slice, device, record, ctx, true);
  }
  return ok({ slice, out: [] });
}

function onTimer(slice: SiteSlice, key: TimerOf<"site">["key"], ctx: Context): Step {
  if (key.kind === "followGraceEnd") return tryDone(slice, ctx, true);
  const timers = clearTimer(slice.timers, key);
  if (slice.row.moveStage !== MoveStage.Announcing)
    return ok({ slice: { ...slice, timers }, out: [] });
  return decisionMessage(
    ctx,
    { kind: "move_stalled", device: key.sensor, cause: null, value: slice.row.moveId },
    "now",
  ).map((recorded) => ({ slice: { ...slice, timers }, out: [recorded] }));
}

/** `hsn site set` (section 9): channel and rate only before the first sensor or siren is paired. */
function setSite(
  slice: SiteSlice,
  message: Extract<Internal, { kind: "siteSettingsRequest" }>,
  ctx: Context,
): Step {
  const { change } = message;
  const radioChange = change.channel !== undefined || change.rate !== undefined;
  if (radioChange && (slice.sensors.size > 0 || slice.sirens.size > 0)) {
    return ok({
      slice,
      out: [
        refusal(
          message.request,
          "sitePaired",
          "channel and rate change over the air now: hsn site change",
        ),
      ],
    });
  }
  const row: SiteRow = {
    ...slice.row,
    channel: change.channel ?? slice.row.channel,
    rateMask: change.rate === undefined ? slice.row.rateMask : oneRateMask(change.rate),
    countdownDefaultS: change.countdown ?? slice.row.countdownDefaultS,
    autoStopS: change.autoStop ?? slice.row.autoStopS,
  };
  const next = { ...slice, row };
  return ok({
    slice: next,
    out: [
      rowWrite(row),
      answer(message.request, {
        ok: true,
        result: { kind: "siteSet", site: siteShown(next, ctx) },
      }),
    ],
  });
}

/** The site as `hsn site show` and `site set` answer it (section 9). */
export function siteShown(
  slice: SiteSlice,
  ctx: Context,
): Extract<Extract<ControlReply, { ok: true }>["result"], { kind: "siteSet" }>["site"] {
  const { row } = slice;
  return {
    channel: row.channel,
    rate: rateOfRow(row, ctx.deps.rules),
    countdownS: row.countdownDefaultS,
    autoStopS: row.autoStopS,
    wifiName: row.wifiName.length === 0 ? null : new TextDecoder().decode(row.wifiName),
    replyPowerDbm: row.replyPowerDbm,
    sirenPowerDbm: row.sirenPowerDbm,
  };
}

function onChange(
  slice: SiteSlice,
  message: Extract<Internal, { kind: "siteChangeRequested" }>,
  ctx: Context,
): Step {
  const { action } = message;
  switch (action.kind) {
    case "start":
      return startMove(slice, message, action, ctx);
    case "status":
      return ok({ slice, out: [statusOf(slice, message.request, ctx)] });
    case "cancel":
      return cancelMove(slice, message.request, message.record, ctx);
    case "force":
      return forceMove(slice, message.request, message.record, action.yes, ctx);
  }
}

function handleMessage(slice: SiteSlice, message: Internal, ctx: Context): Step {
  switch (message.kind) {
    case "boot":
      return onBoot(slice, message.snapshot, ctx, message.boot.id);
    case "deviceAdded":
      return ok({ slice: onDeviceAdded(slice, message.device, message.role, ctx), out: [] });
    case "deviceRemoved":
      return ok({ slice: onDeviceRemoved(slice, message.device), out: [] });
    case "siteChangeRequested":
      return onChange(slice, message, ctx);
    case "siteSettingsRequest":
      return setSite(slice, message, ctx);
    case "siteWifiRequest": {
      const row: SiteRow = { ...slice.row, wifiName: message.name, wifiPassword: message.password };
      return ok({
        slice: { ...slice, row },
        out: [rowWrite(row), answer(message.request, { ok: true, result: { kind: "siteWifi" } })],
      });
    }
    case "accepted":
      return onAccepted(slice, message, ctx);
    case "answer": {
      // The channel survey (gateways module) chose the site's channel: it is the site's (section 8).
      const { reply } = message;
      if (!reply.ok || reply.result.kind !== "siteSurvey") return ok({ slice, out: [] });
      if (reply.result.channel === slice.row.channel) return ok({ slice, out: [] });
      const row: SiteRow = { ...slice.row, channel: reply.result.channel };
      return ok({ slice: { ...slice, row }, out: [rowWrite(row)] });
    }
    case "siteFollowed":
      // The sirens module says a siren reported its new version (section 8, "Follow").
      return slice.sirens.get(message.device) === false
        ? follow(slice, message.device, message.cause, ctx, false)
        : ok({ slice, out: [] });
    case "downtimeKnown": {
      // The switch time re-expressed with the downtime now known (section 8, D113).
      if (slice.switchedBeforeStopMs === undefined || slice.row.moveStage !== MoveStage.Switched) {
        return ok({ slice, out: [] });
      }
      const switchedAt = monoAfterMs(
        slice.startedAt,
        -(message.downtimeMs + slice.switchedBeforeStopMs),
      );
      const next = { ...slice, switchedAt, switchedBeforeStopMs: undefined };
      return ok({
        slice: { ...next, timers: [graceTimer(ctx, next, switchedAt, unitsNow(ctx))] },
        out: [],
      });
    }
    case "timer":
      return message.key.module === "site"
        ? onTimer(slice, message.key, ctx)
        : ok({ slice, out: [] });
    default:
      return ok({ slice, out: [] });
  }
}

/**
 * The site module's handler. After every message, a move ready to switch switches and a
 * switched one whose followers are all in is done: the end of a countdown or the alarm reaches
 * the site only through the messages it causes (section 8, "Switch").
 */
export const handleSite: Handler<"site"> = (slice, message, ctx) =>
  handleMessage(slice, message, ctx).andThen((handled) => {
    const view = { ...ctx.view, site: handled.slice };
    const settled = { ...ctx, view };
    return trySwitch(handled.slice, settled).andThen((switched) =>
      (switched.slice.row.moveStage === MoveStage.Switched && message.kind !== "boot"
        ? tryDone(switched.slice, settled)
        : ok({ slice: switched.slice, out: [] as readonly Out[] })
      ).map((done) => ({ slice: done.slice, out: [...handled.out, ...switched.out, ...done.out] })),
    );
  });

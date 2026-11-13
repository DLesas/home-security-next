/**
 * The sensors module's handler (hub-design.md section 2, module 10; section 8, "When to reply",
 * "The reply rate", "Silence", "Arming and the countdown"; D72, D107, D108, D114, D115).
 *
 * - Settings: each sensor's `sensor_config` row is written now with every change; a change to a
 *   carried setting (arming, countdown, heartbeat, link check, rates, correction, next settings)
 *   bumps the version, kept with its reply rate in the last 16 (D72).
 * - Replies: a heartbeat is answered when the version it holds differs or it asks, at the fixed
 *   moment, unless the step runs more than 700 ms ‡ after its end; door, cover, button, Started
 *   and log entries always, as soon as possible within the sensor's listening (section 8).
 * - The disarmed notice twice, 2 s apart, the same bytes (D24, section 4).
 * - Silence after n × I + 30 s ‡ with D107's n, chosen daily; held back across a site switch.
 * - A site move's versions: announcing, cancelling, switching (section 8, D115).
 */
import { ok, type Result } from "neverthrow";
import { MessageType } from "@hsn/protocol";
import type { ControlReply } from "../model/control.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import type { DeviceId, RequestId } from "../model/ids.ts";
import type { Arrival, Internal, SensorSettingsChange } from "../model/messages.ts";
import {
  ArmState,
  NEXT_SETTING_STAYS,
  PacketPath,
  type SensorConfigRow,
  TxOutcome,
} from "../model/rows.ts";
import { monoAfterMs, msBetween } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import { isLeftBehind, latestMove, onSiteSettings, switchedMove } from "../site/view.ts";
import { nextHeartbeatTenths } from "../slots/view.ts";
import { armedSince, replyArming } from "../alarm/view.ts";
import { sensorSilenceHeldBack } from "../gateways/view.ts";
import {
  changeConfig,
  configWrite,
  firstConfig,
  newEntry,
  pairedCounter,
  realIntervalMs,
  restoreEntries,
  ROLE_SENSOR,
  withEntry,
  withSilenceTimer,
} from "./entries.ts";
import { isStatus, observe, versionNamed } from "./observe.ts";
import { isKnownRate } from "./radio.ts";
import {
  clearTimer,
  decisionMessage,
  foldOut,
  orFault,
  recordMessage,
  setTimer,
} from "./records.ts";
import {
  eventLatest,
  heartbeatMoment,
  type Outgoing,
  radioOut,
  replyMessage,
  send,
} from "./reply.ts";
import { boundReplyRate, chooseReplyRate } from "./reply-rate.ts";
import { keptVersion } from "./settings.ts";
import {
  dayOf,
  isPoorLink,
  lossFraction,
  lossOverDays,
  MILLISECONDS_PER_DAY,
  missedHeartbeats,
} from "./silence.ts";
import type { SensorEntry, SensorsSlice } from "./state.ts";

type Out = Internal | Effect;
type Step = Result<Handled<"sensors">, CoreFault>;
type Accepted = Extract<Internal, { kind: "accepted" }>;
type Lora = Extract<Arrival, { path: "lora" }>;

/** `poor_link`'s value is the loss in parts per thousand (model/decisions.ts). */
const PER_MILLE = 1000;
/** `loss_daily` rows are kept 30 days (section 6). */
const LOSS_DAYS_KEPT = 30;
/** SNR on the wire is quarter decibels (§6, forwarded packet). */
const QUARTERS_PER_DB = 4;

const DAILY_LOSS_KEY = { module: "sensors", kind: "dailyLoss" } as const;

function unchanged(slice: SensorsSlice): Step {
  return ok({ slice, out: [] });
}

/** The slice with `entry` and its silence timer. */
function settle(ctx: Context, slice: SensorsSlice, entry: SensorEntry): SensorsSlice {
  const view = { ...ctx.view, sensors: withEntry(slice, entry) };
  return {
    ...withEntry(slice, entry),
    timers: withSilenceTimer({ ...ctx, view }, slice.timers, entry),
  };
}

// ——— Replies ———

/**
 * The version a reply carries (section 8, "Follow"): after a switch, a packet that still came
 * on the old settings is answered with the version that announced the move; otherwise the
 * current one.
 */
function versionFor(ctx: Context, entry: SensorEntry, arrival: Lora): SensorConfigRow {
  if (
    switchedMove(ctx.view) !== undefined &&
    entry.announcing !== undefined &&
    !onSiteSettings(ctx.view, ctx.deps.rules, arrival)
  ) {
    return entry.announcing;
  }
  return entry.config;
}

/**
 * True when this packet is the sensor's first on the new settings of a switched move. The site
 * module has already seen it, and may have ended the move with it, so a move done counts too.
 */
function isFollowing(ctx: Context, entry: SensorEntry, arrival: Arrival): boolean {
  const move = latestMove(ctx.view);
  return (
    (move?.stage === "switched" || move?.stage === "done") &&
    entry.config.moveFollowed !== move.id &&
    onSiteSettings(ctx.view, ctx.deps.rules, arrival)
  );
}

/**
 * The rate a reply goes at (section 8, "Which rate a packet goes at"): with flag bit 7, or the
 * first on a move's new settings, the rate it arrived at; otherwise the reply rate of the version
 * it names, from the last 16 kept; for one not kept, the arrival rate. An unlisted arrival rate
 * gives the sending rate.
 */
function replyRateFor(
  entry: SensorEntry,
  named: number | undefined,
  atSendRate: boolean,
  following: boolean,
  arrival: Lora,
): number {
  const arrived = isKnownRate(arrival.dataRate) ? arrival.dataRate : entry.config.sendRate;
  if (atSendRate || following || named === undefined) return arrived;
  return keptVersion(entry.config, named)?.replyRate ?? arrived;
}

/**
 * What one accepted packet needs in answer: a reply, or nothing (section 8, "When to reply").
 * `heldUnits` is the correction the sensor holds with the version the packet names, as it was
 * before this packet changed any setting.
 */
function planReply(
  ctx: Context,
  entry: SensorEntry,
  accepted: Accepted,
  heldUnits: number,
): Result<Outgoing | "skipped" | undefined, CoreFault> {
  const { message, arrival, counter, record } = accepted;
  // A sensor's packets come through a gateway; on a link there is no radio path back (§5).
  if (arrival.path !== "lora") return ok(undefined);
  const rules = ctx.deps.rules;
  const following = isFollowing(ctx, entry, arrival);
  const settings = versionFor(ctx, entry, arrival);
  // The countdown this very packet may have started: alarm runs before sensors (section 2).
  const arming = replyArming(ctx.view, entry.device, ctx.now.mono);
  const left = arming.countdownStarted ? arming.secondsLeft : undefined;
  const base = { entry, binding: counter, gateway: arrival.gateway, cause: record };

  if (message.type === MessageType.Heartbeat) {
    const wanted = message.flags.replyWanted || message.settingsVersion !== settings.version;
    if (!wanted) return ok(undefined);
    // Decided too late, the gateway would only answer "too late" (section 8; §6, 20 ms †).
    if (msBetween(arrival.endedAt, ctx.now.mono) > rules.replies.heartbeatTooLateMs)
      return ok("skipped");
    const rate = replyRateFor(
      entry,
      message.settingsVersion,
      message.flags.listeningAtSendRate,
      following,
      arrival,
    );
    const aheadMs = realIntervalMs(entry) * rules.slots.minIntervalFractionAhead;
    return orFault(ctx, nextHeartbeatTenths(ctx.view, entry.device, arrival.endedAt, aheadMs)).map(
      (tenths): Outgoing => ({
        ...base,
        message: replyMessage(settings, left, tenths),
        timing: heartbeatMoment(
          ctx,
          entry.device,
          heldUnits,
          arrival.gateway,
          arrival.gatewayMicros,
        ),
        rate,
        purpose: "heartbeatReply",
        // Link checks are routine (30 days); a reply that carries a new version is an event.
        table: message.settingsVersion === settings.version ? "routine" : "event",
        slotFor: tenths > 0 ? counter : undefined,
      }),
    );
  }

  // Door, cover, button, Started and log entries: always answered (§6, §7).
  // A log entries packet names no version: the sensor's most recent status packet decides (section 8).
  const isLog = message.type === MessageType.LogEntries;
  const named = isLog ? entry.status?.version : versionNamed(message);
  const atSendRate = isLog
    ? entry.status?.listeningAtSendRate === true
    : isStatus(message) && message.flags.listeningAtSendRate;
  const rate = replyRateFor(entry, named, atSendRate, following, arrival);
  const arrivalRate = isKnownRate(arrival.dataRate) ? arrival.dataRate : entry.config.sendRate;
  // Only a reply to Started names a next heartbeat: the early one, at least 30 s ‡ after it.
  const tenths =
    message.type === MessageType.Started
      ? orFault(
          ctx,
          nextHeartbeatTenths(
            ctx.view,
            entry.device,
            arrival.endedAt,
            rules.slots.earlyHeartbeatAfterStartedMs,
          ),
        )
      : ok(0);
  return tenths.andThen((next) =>
    eventLatest(ctx, arrival.endedAt, arrivalRate, rate).map((timing): Outgoing => ({
      ...base,
      message: replyMessage(settings, left, next),
      timing,
      rate,
      purpose: "eventReply",
      table: "event",
      slotFor: next > 0 ? counter : undefined,
    })),
  );
}

/** One accepted sensor packet: what it tells, its settings, its reply, its silence timer. */
function onAccepted(slice: SensorsSlice, accepted: Accepted, ctx: Context): Step {
  const entry = slice.sensors.get(accepted.device);
  if (entry === undefined || accepted.role !== ROLE_SENSOR) return unchanged(slice);
  const following = isFollowing(ctx, entry, accepted.arrival);
  return observe(ctx, entry, accepted, following).andThen((observed) => {
    const day = dayOf(ctx.now.wall);
    const loss = observed.entry.loss.get(day);
    const writes: Out[] = [
      ...(observed.changed ? [configWrite(observed.entry.config)] : []),
      ...(loss === undefined
        ? []
        : [
            {
              kind: "write" as const,
              durability: "routine" as const,
              op: {
                table: "loss_daily" as const,
                op: "upsert" as const,
                row: { deviceId: entry.device, day, ...loss },
              },
            },
          ]),
    ];
    const observedSlice = settle(ctx, slice, observed.entry);
    const view = { ...ctx.view, sensors: observedSlice };
    // The correction the sensor holds: its version's, known for the current one before this
    // packet bumped it; for an older version, the current one's is the best guess.
    const named = versionNamed(accepted.message);
    const announcing = entry.announcing;
    const heldUnits =
      announcing !== undefined && announcing.version === named
        ? announcing.correctionUnits
        : entry.config.correctionUnits;
    const planned = planReply({ ...ctx, view }, observed.entry, accepted, heldUnits);
    return planned.andThen((plan): Step => {
      const before = [...observed.out, ...writes];
      if (plan === undefined) return ok({ slice: observedSlice, out: before });
      if (plan === "skipped") {
        return decisionMessage(
          ctx,
          { kind: "reply_skipped", device: entry.device, cause: accepted.record, value: null },
          "routine",
        ).map((recorded) => ({ slice: observedSlice, out: [...before, recorded] }));
      }
      return send(ctx, observedSlice, plan).map((sent) => ({
        slice: sent.slice,
        out: [...before, ...sent.out],
      }));
    });
  });
}

// ——— The disarmed notice (D24) ———

function onCountdownCancelled(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "countdownCancelled" }>,
  ctx: Context,
): Step {
  const entry = slice.sensors.get(message.sensor);
  if (entry === undefined) return unchanged(slice);
  const { disarmedNoticeCopies, disarmedNoticeGapMs } = ctx.deps.rules.replies;
  const notice: Outgoing = {
    entry,
    message: { type: MessageType.DisarmedNotice },
    // Bound to the countdown's newest report (§4).
    binding: message.newestCounter,
    // Through the gateway the countdown's latest reply went through; any connected one otherwise.
    gateway: message.replyGateway,
    timing: { kind: "asap", latest: undefined },
    rate: message.replyRate,
    purpose: "disarmedNotice",
    table: "event",
    cause: message.cause,
    slotFor: undefined,
  };
  return send(ctx, slice, notice).map((sent) => {
    const copiesLeft = disarmedNoticeCopies - 1;
    const key = { module: "sensors", kind: "disarmedNoticeCopy", sensor: entry.device } as const;
    const notices = new Map(sent.slice.notices);
    if (copiesLeft > 0) {
      notices.set(entry.device, {
        packet: sent.sealed.packet,
        counter: sent.sealed.counter,
        binding: message.newestCounter,
        gateway: message.replyGateway,
        rate: message.replyRate,
        copiesLeft,
      });
    }
    const timers =
      copiesLeft > 0
        ? setTimer(sent.slice.timers, key, monoAfterMs(ctx.now.mono, disarmedNoticeGapMs))
        : sent.slice.timers;
    return { slice: { ...sent.slice, notices, timers }, out: sent.out };
  });
}

/** The notice's next copy: the same sealed bytes, so the same counter (section 4). */
function onNoticeCopy(slice: SensorsSlice, sensor: DeviceId, ctx: Context): Step {
  const key = { module: "sensors", kind: "disarmedNoticeCopy", sensor } as const;
  const notice = slice.notices.get(sensor);
  const timers = clearTimer(slice.timers, key);
  if (notice === undefined) return unchanged({ ...slice, timers });
  const copy = {
    message: { type: MessageType.DisarmedNotice } as const,
    gateway: notice.gateway,
    timing: { kind: "asap", latest: undefined } as const,
    rate: notice.rate,
    purpose: "disarmedNotice" as const,
    table: "event" as const,
    cause: undefined,
    slotFor: undefined,
  };
  return radioOut(ctx, { ...slice, timers }, copy, sensor, notice.packet, notice.counter).map(
    (sent) => {
      const notices = new Map(sent.slice.notices);
      const copiesLeft = notice.copiesLeft - 1;
      if (copiesLeft > 0) notices.set(sensor, { ...notice, copiesLeft });
      else notices.delete(sensor);
      const next =
        copiesLeft > 0
          ? setTimer(
              sent.slice.timers,
              key,
              monoAfterMs(ctx.now.mono, ctx.deps.rules.replies.disarmedNoticeGapMs),
            )
          : sent.slice.timers;
      return { slice: { ...sent.slice, notices, timers: next }, out: sent.out };
    },
  );
}

// ——— Outcomes ———

/** A packet's outcome: its `tx` row (section 6), a slot given, and the decisions it causes (section 7). */
function onRadioResult(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "radioResult" }>,
  ctx: Context,
): Step {
  const flight = slice.inFlight.get(message.ref);
  if (flight?.device !== message.device) return unchanged(slice);
  const inFlight = new Map(slice.inFlight);
  inFlight.delete(message.ref);
  const entry = slice.sensors.get(flight.device);
  const sent = message.outcome === TxOutcome.Sent;
  const slotted =
    entry !== undefined && sent && flight.slotFor !== undefined
      ? withEntry(slice, { ...entry, slotFrom: flight.slotFor })
      : slice;
  const next = { ...slotted, inFlight };
  return ctx.records.take().andThen((seq) => {
    const tx = recordMessage("routine", {
      kind: "tx",
      table: flight.table,
      row: {
        seq,
        atMs: ctx.now.wall,
        clockOk: ctx.now.wallTrusted,
        deviceId: flight.device,
        type: flight.type,
        counter: flight.counter,
        path: PacketPath.Lora,
        gatewayId: message.gateway ?? null,
        requestCounter: message.requestCounter ?? null,
        rate: flight.rate,
        power: flight.power,
        outcome: message.outcome,
        gwSentUs: message.sentGatewayMicros ?? null,
        body: flight.body,
      },
    });
    // A missed moment or a busy radio is the outcome on the `tx` row, not a decision (section 6).
    return ok({ slice: next, out: [tx] });
  });
}

// ——— Settings ———

/** `config` changed and written now, with the entry and its timers settled. */
function rewrite(
  ctx: Context,
  slice: SensorsSlice,
  entry: SensorEntry,
  change: Parameters<typeof changeConfig>[2],
  extra: Partial<SensorEntry> = {},
): { readonly slice: SensorsSlice; readonly out: readonly Out[] } {
  const changed = changeConfig(ctx, entry.config, change);
  const next = { ...entry, ...extra, config: changed.config };
  return {
    slice: settle(ctx, slice, next),
    out: changed.changed ? [configWrite(changed.config)] : [],
  };
}

function onArmedChanged(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "armedChanged" }>,
  ctx: Context,
): Step {
  const entry = slice.sensors.get(message.sensor);
  if (entry === undefined) return unchanged(slice);
  // When it was armed is the alarm module's to say (`sensor_config.armed_boot`, `armed_mono`).
  const since = armedSince(ctx.view, message.sensor);
  const times =
    since !== undefined
      ? { armedBoot: since.boot, armedMono: since.mono }
      : message.arm === ArmState.Disarmed
        ? { armedBoot: null, armedMono: null }
        : { armedBoot: slice.boot, armedMono: ctx.now.mono };
  return ok(rewrite(ctx, slice, entry, { arm: message.arm, ...times }));
}

function settingsAnswer(request: RequestId, reply: ControlReply): Internal {
  return { kind: "answer", request, reply };
}

/** The columns `hsn sensor set` changes (section 9): a number fixes a rate or correction, "learn" frees it. */
function requestedChange(change: SensorSettingsChange): Parameters<typeof changeConfig>[2] {
  return {
    ...(change.countdown === undefined ? {} : { countdownS: change.countdown }),
    ...(change.heartbeat === undefined ? {} : { heartbeatUnits: change.heartbeat }),
    ...(change.linkCheck === undefined ? {} : { linkCheckEvery: change.linkCheck }),
    ...(change.replyRate === undefined
      ? {}
      : change.replyRate === "learn"
        ? { replyRateFixed: false }
        : { replyRate: change.replyRate, replyRateFixed: true }),
    ...(change.correction === undefined
      ? {}
      : change.correction === "learn"
        ? { correctionFixed: false }
        : { correctionUnits: change.correction, correctionFixed: true }),
  };
}

function onSettingsRequest(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "sensorSettingsRequest" }>,
  ctx: Context,
): Step {
  const entry = slice.sensors.get(message.sensor);
  if (entry === undefined) {
    return ok({
      slice,
      out: [
        settingsAnswer(message.request, {
          ok: false,
          error: { code: "unknownDevice", message: "no such sensor" },
        }),
      ],
    });
  }
  const done = rewrite(ctx, slice, entry, requestedChange(message.change));
  const config = done.slice.sensors.get(entry.device)?.config ?? entry.config;
  return ok({
    slice: done.slice,
    out: [
      ...done.out,
      settingsAnswer(message.request, {
        ok: true,
        result: { kind: "sensorSet", name: entry.name, version: config.version },
      }),
    ],
  });
}

// ——— The site move (D115) ———

/** The reply rate chosen again at a switch, bounded by the new sending rate (section 8). */
function replyRateAtSwitch(ctx: Context, entry: SensorEntry, sendRate: number): number {
  const rules = ctx.deps.rules;
  if (entry.config.replyRateFixed) return boundReplyRate(rules, sendRate, entry.config.replyRate);
  const best = entry.snr.at(-1)?.gateway;
  return chooseReplyRate(rules, {
    snrDb: entry.snr.filter((s) => s.gateway === best).map((s) => s.snrQuarterDb / QUARTERS_PER_DB),
    sendRate,
    current: boundReplyRate(rules, sendRate, entry.config.replyRate),
    replyPowerDbm: ctx.view.site.row.replyPowerDbm,
    fasterAllowed: true,
  });
}

function onSiteMove(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "siteMove" }>,
  ctx: Context,
): Step {
  const entries = [...slice.sensors.values()].toSorted((a, b) => a.device - b.device);
  const each = (
    change: (
      entry: SensorEntry,
    ) => { change: Parameters<typeof changeConfig>[2]; extra?: Partial<SensorEntry> } | undefined,
  ) =>
    foldOut(entries, slice, (current, entry) => {
      const wanted = change(entry);
      // Unchanged, its silence timer is still settled again: the move may hold it back or not.
      if (wanted === undefined) return ok({ state: settle(ctx, current, entry), out: [] });
      const done = rewrite(ctx, current, entry, wanted.change, wanted.extra);
      return ok({ state: done.slice, out: done.out });
    }).map(({ state, out }) => ({ slice: state, out }));
  switch (message.stage) {
    case "announcing":
      // Every sensor gets a version carrying the next settings, before any reply does (section 8).
      return each(() => ({
        change: {
          nextChannel: message.channel ?? NEXT_SETTING_STAYS,
          nextRate: message.rate ?? NEXT_SETTING_STAYS,
        },
      }));
    case "cancelled":
      // A new version announcing nothing; a sensor clears its next settings at its next reply (§7).
      return each(() => ({
        change: { nextChannel: NEXT_SETTING_STAYS, nextRate: NEXT_SETTING_STAYS },
      }));
    case "switched":
      // Each sensor's next version: the new sending rate, nothing announced, the reply rate chosen
      // again; until it follows, packets on the old settings get the announcing version. One left
      // behind by a forced move keeps its settings: it must be paired again (section 8, "Force").
      return each((entry) => {
        // Left behind by a forced move: no new version, and that alert instead of silence.
        if (isLeftBehind(ctx.view, entry.device)) return undefined;
        const sendRate = message.rate ?? entry.config.sendRate;
        return {
          change: {
            sendRate,
            replyRate: replyRateAtSwitch(ctx, entry, sendRate),
            nextChannel: NEXT_SETTING_STAYS,
            nextRate: NEXT_SETTING_STAYS,
          },
          extra: { announcing: entry.config, slotFrom: undefined },
        };
      });
    case "done":
      return ok({
        slice: {
          ...slice,
          sensors: new Map(
            [...slice.sensors].map(([d, e]) => [d, { ...e, announcing: undefined }]),
          ),
        },
        out: [],
      });
  }
}

// ——— Silence (D107) ———

function onSilence(slice: SensorsSlice, sensor: DeviceId, ctx: Context): Step {
  const key = { module: "sensors", kind: "silence", sensor } as const;
  const entry = slice.sensors.get(sensor);
  const timers = clearTimer(slice.timers, key);
  if (entry === undefined || entry.silent || isLeftBehind(ctx.view, sensor)) {
    return unchanged({ ...slice, timers });
  }
  // While the gateway that alone heard it is silent, the sensor raises none of its own (D97);
  // it is looked at again an interval later.
  if (sensorSilenceHeldBack(ctx.view, sensor, ctx.deps.rules)) {
    return unchanged({
      ...slice,
      timers: setTimer(timers, key, monoAfterMs(ctx.now.mono, realIntervalMs(entry))),
    });
  }
  return decisionMessage(
    ctx,
    { kind: "sensor_silent", device: sensor, cause: null, value: entry.missed },
    "now",
  ).map((recorded) => ({
    slice: { ...withEntry(slice, { ...entry, silent: true }), timers },
    out: [recorded],
  }));
}

/** The daily choice of n for every sensor (D107), with `poor_link` above 20 % loss. */
function onDailyLoss(slice: SensorsSlice, ctx: Context): Step {
  const rules = ctx.deps.rules;
  const today = dayOf(ctx.now.wall);
  const count = slice.sensors.size;
  return foldOut([...slice.sensors.values()], slice, (current, entry) => {
    const loss = new Map([...entry.loss].filter(([day]) => day > today - LOSS_DAYS_KEPT));
    const rows = [...loss].map(([day, counts]) => ({ deviceId: entry.device, day, ...counts }));
    const totals = lossOverDays(rules, rows, today);
    const missed = missedHeartbeats(rules, totals, realIntervalMs(entry), count);
    const updated = settle(ctx, current, { ...entry, loss, missed });
    if (!isPoorLink(rules, totals) || totals === undefined) return ok({ state: updated, out: [] });
    return decisionMessage(
      ctx,
      {
        kind: "poor_link",
        device: entry.device,
        cause: null,
        value: Math.round(lossFraction(totals) * PER_MILLE),
      },
      "now",
    ).map((recorded) => ({ state: updated, out: [recorded] }));
  }).map(({ state, out }) => ({
    slice: {
      ...state,
      timers: setTimer(
        state.timers,
        DAILY_LOSS_KEY,
        monoAfterMs(ctx.now.mono, MILLISECONDS_PER_DAY),
      ),
    },
    out,
  }));
}

function onTimer(slice: SensorsSlice, key: TimerOf<"sensors">["key"], ctx: Context): Step {
  switch (key.kind) {
    case "disarmedNoticeCopy":
      return onNoticeCopy(slice, key.sensor, ctx);
    case "silence":
      return onSilence(slice, key.sensor, ctx);
    case "dailyLoss":
      return onDailyLoss(slice, ctx);
  }
}

// ——— Devices ———

function onBoot(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "boot" }>,
  ctx: Context,
): Step {
  return restoreEntries(ctx, message.snapshot).map((sensors) => {
    const base: SensorsSlice = {
      ...slice,
      boot: message.boot.id,
      startedAt: ctx.now.mono,
      sensors,
      inFlight: new Map(),
      notices: new Map(),
      timers: [],
    };
    const settled = [...sensors.values()].reduce(
      (current, entry) => settle(ctx, current, entry),
      base,
    );
    const timers =
      sensors.size === 0
        ? settled.timers
        : setTimer(settled.timers, DAILY_LOSS_KEY, monoAfterMs(ctx.now.mono, MILLISECONDS_PER_DAY));
    return { slice: { ...settled, timers }, out: [] };
  });
}

function onDeviceAdded(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "deviceAdded" }>,
  ctx: Context,
): Step {
  if (message.role !== ROLE_SENSOR) return unchanged(slice);
  const config = firstConfig(ctx, message.device);
  const entry = newEntry(
    ctx,
    message.device,
    message.address,
    message.name,
    config,
    pairedCounter(),
  );
  const settled = settle(ctx, slice, entry);
  const daily = settled.timers.some((t) => t.key.kind === "dailyLoss")
    ? settled.timers
    : setTimer(settled.timers, DAILY_LOSS_KEY, monoAfterMs(ctx.now.mono, MILLISECONDS_PER_DAY));
  // Written now with the device's other rows, in the step that adds it (section 9).
  return ok({ slice: { ...settled, timers: daily }, out: [configWrite(config)] });
}

function onDeviceRemoved(slice: SensorsSlice, device: DeviceId): Step {
  const sensors = new Map(slice.sensors);
  sensors.delete(device);
  const notices = new Map(slice.notices);
  notices.delete(device);
  const timers = slice.timers.filter((t) => !("sensor" in t.key) || t.key.sensor !== device);
  return unchanged({ ...slice, sensors, notices, timers });
}

/** A move's confirmation or follow, written now (section 8). */
function onMoveMark(
  slice: SensorsSlice,
  sensor: DeviceId,
  ctx: Context,
  mark: "confirmed" | "followed",
  move: number,
): Step {
  const entry = slice.sensors.get(sensor);
  if (entry === undefined) return unchanged(slice);
  const change = mark === "confirmed" ? { moveConfirmed: move } : { moveFollowed: move };
  const extra = mark === "followed" ? { announcing: undefined } : {};
  return ok(rewrite(ctx, slice, entry, change, extra));
}

/** The sensors module's handler. */
export const handleSensors: Handler<"sensors"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "boot":
      return onBoot(slice, message, ctx);
    case "deviceAdded":
      return onDeviceAdded(slice, message, ctx);
    case "deviceRemoved":
      return onDeviceRemoved(slice, message.device);
    case "accepted":
      return onAccepted(slice, message, ctx);
    case "armedChanged":
      return onArmedChanged(slice, message, ctx);
    case "countdownCancelled":
      return onCountdownCancelled(slice, message, ctx);
    case "radioResult":
      return onRadioResult(slice, message, ctx);
    case "sensorSettingsRequest":
      return onSettingsRequest(slice, message, ctx);
    case "siteMove":
      return onSiteMove(slice, message, ctx);
    case "siteConfirmed":
      return onMoveMark(slice, message.sensor, ctx, "confirmed", message.move);
    case "siteFollowed":
      return onMoveMark(slice, message.device, ctx, "followed", message.move);
    case "timer":
      return message.key.module === "sensors" ? onTimer(slice, message.key, ctx) : unchanged(slice);
    default:
      return unchanged(slice);
  }
};

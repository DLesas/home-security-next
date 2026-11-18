/**
 * What a sensor's status packets do to the alarm (hub-design.md section 8, "Arming and the
 * countdown"; section 7, "Late door reports"; AL2b, AL3, AL4, D50, D67, D86, D106, D114).
 *
 * Only door changed reports start a countdown, sound a siren or change an arming state: they are
 * committed before they are answered, so they cannot be replayed (section 5). A heartbeat that
 * shows a door state or change count the hub did not expect is a warning, nothing more (D114).
 */
import { ok } from "neverthrow";
import { MessageType, type MessageOf } from "@hsn/protocol";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import type { DomainMessage } from "../model/messages.ts";
import { type AlarmTriggerKind, AlarmTriggerKind as TriggerKind, ArmState } from "../model/rows.ts";
import { type Mono, MICROS_PER_MILLISECOND, MILLISECONDS_PER_SECOND } from "../model/time.ts";
import { addTrigger, type SirenSource, waitForClose } from "./alarm.ts";
import { setArm } from "./arm-state.ts";
import { type Changing, decide, then, unchanged, writeNow } from "./out.ts";
import type { AlarmSlice, Countdown, SensorArming } from "./state.ts";
import { afterSeconds, secondsUntil } from "./time.ts";

type Accepted = Extract<DomainMessage, { readonly kind: "accepted" }>;
type SensorStatus = MessageOf<
  | typeof MessageType.Heartbeat
  | typeof MessageType.DoorChanged
  | typeof MessageType.CoverChanged
  | typeof MessageType.Button
>;

/** The door change count wraps at 256 (§6). */
const CHANGE_COUNT_MODULO = 256;

/** How far the count moved from `from` to `to`, modulo 256. */
function changesBetween(from: number, to: number): number {
  return (((to - from) % CHANGE_COUNT_MODULO) + CHANGE_COUNT_MODULO) % CHANGE_COUNT_MODULO;
}

/** A sensor status message, or undefined for any other message. */
export function sensorStatus(message: Accepted["message"]): SensorStatus | undefined {
  switch (message.type) {
    case MessageType.Heartbeat:
    case MessageType.DoorChanged:
    case MessageType.CoverChanged:
    case MessageType.Button:
      return message;
    default:
      return undefined;
  }
}

/** When the packet finished arriving on the hub's clock; a sensor's packets come through a gateway (§5). */
function packetEnd(accepted: Accepted, ctx: Context): Mono {
  return accepted.arrival.path === "lora" ? accepted.arrival.endedAt : ctx.now.mono;
}

/** The sensor's armed time on this boot's clock, or undefined when armed in an earlier run. */
function armedAt(slice: AlarmSlice, arming: SensorArming): Mono | undefined {
  return arming.armedBoot === slice.boot && arming.armedMono !== null
    ? arming.armedMono
    : undefined;
}

function withSensor(slice: AlarmSlice, sensor: DeviceId, arming: SensorArming): AlarmSlice {
  return { ...slice, sensors: new Map(slice.sensors).set(sensor, arming) };
}

/** A sensor status packet accepted from a sensor this module knows. */
export function onSensorStatus(
  slice: AlarmSlice,
  ctx: Context,
  accepted: Accepted,
  status: SensorStatus,
): Changing {
  const arming = slice.sensors.get(accepted.device);
  if (arming === undefined) return unchanged(slice);
  const local =
    accepted.newest && status.flags.localAlarmSounded
      ? decide(ctx, "now", {
          kind: "local_alarm_reported",
          device: accepted.device,
          cause: accepted.record,
        }).map(({ message }) => ({ slice, out: [message] }))
      : unchanged(slice);
  return then(local, (current) => {
    if (status.type === MessageType.DoorChanged)
      return onDoorReport(current, ctx, accepted, status);
    if (!accepted.newest) return unchanged(current);
    if (status.type === MessageType.Heartbeat) return onHeartbeat(current, ctx, accepted, status);
    return ok({
      slice: withSensor(current, accepted.device, { ...arming, doorNow: status.flags.doorOpen }),
      out: [],
    });
  });
}

/**
 * A heartbeat changes nothing but the door state shown for arming: a door state or change count
 * that contradicts the door reports is recorded once as a warning (section 8, D114).
 */
function onHeartbeat(
  slice: AlarmSlice,
  ctx: Context,
  accepted: Accepted,
  status: SensorStatus,
): Changing {
  const sensor = accepted.device;
  const arming = slice.sensors.get(sensor);
  if (arming === undefined) return unchanged(slice);
  const door = arming.door;
  const stateDiffers = door !== undefined && door.open !== status.flags.doorOpen;
  const countAhead =
    door === undefined ? 0 : changesBetween(door.changeCount, status.doorChangeCount);
  const warnState = stateDiffers && !arming.doorWarned;
  const warnCount = countAhead > 0 && arming.changesWarned !== status.doorChangeCount;
  const next: SensorArming = {
    ...arming,
    doorNow: status.flags.doorOpen,
    doorWarned: stateDiffers,
    changesWarned: countAhead > 0 ? status.doorChangeCount : undefined,
  };
  const changed = unchanged(withSensor(slice, sensor, next));
  const afterState = warnState
    ? then(changed, (s) =>
        decide(ctx, "now", {
          kind: "door_state_unexpected",
          device: sensor,
          cause: accepted.record,
        }).map(({ message }) => ({ slice: s, out: [message] })),
      )
    : changed;
  return warnCount
    ? then(afterState, (s) =>
        decide(ctx, "now", {
          kind: "door_changes_missed",
          device: sensor,
          cause: accepted.record,
          value: countAhead,
        }).map(({ message }) => ({ slice: s, out: [message] })),
      )
    : afterState;
}

/** A door changed report: an opening is judged; a closing re-arms a waiting sensor (section 8). */
function onDoorReport(
  slice: AlarmSlice,
  ctx: Context,
  accepted: Accepted,
  status: SensorStatus,
): Changing {
  const sensor = accepted.device;
  const arming = slice.sensors.get(sensor);
  if (arming === undefined) return unchanged(slice);
  const missed =
    accepted.newest && arming.door !== undefined
      ? changesBetween(arming.door.changeCount, status.doorChangeCount) - 1
      : 0;
  const recorded: AlarmSlice = accepted.newest
    ? withSensor(slice, sensor, {
        ...arming,
        door: { open: status.flags.doorOpen, changeCount: status.doorChangeCount },
        doorNow: status.flags.doorOpen,
        doorWarned: false,
        changesWarned: undefined,
      })
    : slice;
  const counted =
    missed > 0
      ? decide(ctx, "now", {
          kind: "door_changes_missed",
          device: sensor,
          cause: accepted.record,
          value: missed,
        }).map(({ message }) => ({ slice: recorded, out: [message] }))
      : unchanged(recorded);
  return then(counted, (current) =>
    status.flags.doorOpen
      ? onOpening(current, ctx, accepted, status)
      : onClosing(current, ctx, accepted),
  );
}

/** A closing moves either waiting state to armed, with a version change; nothing else (section 8). */
function onClosing(slice: AlarmSlice, ctx: Context, accepted: Accepted): Changing {
  const arming = slice.sensors.get(accepted.device);
  const waiting =
    arming?.arm === ArmState.WaitsForCloseAfterArming ||
    arming?.arm === ArmState.WaitsForCloseAfterAlarm;
  if (arming === undefined || !waiting || !accepted.newest) return unchanged(slice);
  return decide(ctx, "now", { kind: "armed", device: accepted.device, cause: accepted.record }).map(
    ({ seq, message }) => {
      const changed = setArm(slice, accepted.device, arming, ArmState.Armed, seq, arming.armedMono);
      return { slice: changed.slice, out: [message, ...changed.out] };
    },
  );
}

/**
 * A door-open report, opened at the packet's end less its age (D106):
 * - disarmed or waiting: recorded only (AL2b);
 * - a countdown running: `countdown_continued`, and it becomes the countdown's newest report
 *   (closing never cancels, D86; a second opening does not restart, AL3);
 * - opened more than the tolerance before arming: the door was open at arming, so it waits for it
 *   to close (D114);
 * - otherwise a countdown, or, when it would already have ended, the late-report rules.
 */
function onOpening(
  slice: AlarmSlice,
  ctx: Context,
  accepted: Accepted,
  status: SensorStatus,
): Changing {
  const sensor = accepted.device;
  const arming = slice.sensors.get(sensor);
  if (arming === undefined) return unchanged(slice);
  if (arming.arm !== ArmState.Armed) {
    return decide(ctx, "now", {
      kind: "report_while_disarmed",
      device: sensor,
      cause: accepted.record,
    }).map(({ message }) => ({ slice, out: [message] }));
  }
  const running = slice.countdowns.get(sensor);
  if (running !== undefined) return continueCountdown(slice, ctx, accepted, running);
  const opened = afterSeconds(packetEnd(accepted, ctx), -status.eventAgeSeconds);
  const armed = armedAt(slice, arming);
  const tolerance = ctx.deps.rules.arming.openedBeforeArmingToleranceMs * MICROS_PER_MILLISECOND;
  if (armed !== undefined && opened < armed - tolerance) {
    return accepted.newest
      ? waitForClose(slice, ctx, sensor, ArmState.WaitsForCloseAfterArming, accepted.record)
      : unchanged(slice);
  }
  const end = afterSeconds(opened, arming.countdownS);
  if (end > ctx.now.mono) return startCountdown(slice, ctx, accepted, opened, end);
  return judgeEnded(slice, ctx, {
    sensor,
    opened,
    end,
    cause: accepted.record,
    kind: arming.countdownS === 0 ? TriggerKind.ZeroCountdown : TriggerKind.LateReport,
  });
}

/** The countdown row (section 6), written now before the reply that announces it (D80, HB30). */
export function countdownRow(slice: AlarmSlice, sensor: DeviceId, countdown: Countdown) {
  return writeNow({
    table: "countdowns",
    op: "upsert",
    row: {
      sensorId: sensor,
      boot: slice.boot,
      openedMono: countdown.openedAt,
      deadlineMono: countdown.deadline,
      newestCounter: countdown.newestCounter,
      replyGatewayId: countdown.replyGateway ?? null,
      replyRate: countdown.replyRate,
      causeSeq: countdown.cause,
    },
  });
}

/**
 * The gateway and rate a reply to this packet goes by: the delivering gateway, and the rate the
 * packet arrived at. SPEC-QUESTION: without flag bit 7 the sensors module replies at the reply rate
 * of the version the packet names (section 8, "The reply rate"), which it decides after this
 * module runs and its view does not offer; the arrival rate is right for every one-rate site
 * (DR5 today), and the sensors module sends the disarmed notice, so it can choose the rate itself.
 */
function replyPath(accepted: Accepted): Pick<Countdown, "replyGateway" | "replyRate"> {
  const { arrival } = accepted;
  return arrival.path === "lora"
    ? { replyGateway: arrival.gateway, replyRate: arrival.dataRate }
    : { replyGateway: undefined, replyRate: 0 };
}

function startCountdown(
  slice: AlarmSlice,
  ctx: Context,
  accepted: Accepted,
  opened: Mono,
  end: Mono,
): Changing {
  const countdown: Countdown = {
    openedAt: opened,
    deadline: end,
    newestCounter: accepted.counter,
    ...replyPath(accepted),
    cause: accepted.record,
    restored: false,
  };
  const next: AlarmSlice = {
    ...slice,
    countdowns: new Map(slice.countdowns).set(accepted.device, countdown),
  };
  return decide(ctx, "now", {
    kind: "countdown_started",
    device: accepted.device,
    cause: accepted.record,
    value: secondsUntil(ctx.now.mono, end),
  }).map(({ message }) => ({
    slice: next,
    out: [countdownRow(next, accepted.device, countdown), message],
  }));
}

function continueCountdown(
  slice: AlarmSlice,
  ctx: Context,
  accepted: Accepted,
  countdown: Countdown,
): Changing {
  const newer = accepted.counter > countdown.newestCounter;
  const updated: Countdown = newer
    ? { ...countdown, newestCounter: accepted.counter, ...replyPath(accepted) }
    : countdown;
  const next: AlarmSlice = newer
    ? { ...slice, countdowns: new Map(slice.countdowns).set(accepted.device, updated) }
    : slice;
  return decide(ctx, "now", {
    kind: "countdown_continued",
    device: accepted.device,
    cause: accepted.record,
    value: secondsUntil(ctx.now.mono, countdown.deadline),
  }).map(({ message }) => ({
    slice: next,
    out: newer ? [countdownRow(next, accepted.device, updated), message] : [message],
  }));
}

/** An opening whose countdown has already ended, by a late report or across a restart (D106). */
export interface EndedOpening {
  readonly sensor: DeviceId;
  readonly opened: Mono;
  /** When its countdown ended, or would have. */
  readonly end: Mono;
  readonly cause: Accepted["record"];
  readonly kind: AlarmTriggerKind;
}

/**
 * D106: the sirens sound for what is left of their automatic stop counted from the countdown's
 * end; when even that has passed, only `late_report_notification`, naming when the door opened.
 * A zero countdown is the same rule with the end at the opening: an alarm at once (D86).
 */
export function judgeEnded(slice: AlarmSlice, ctx: Context, opening: EndedOpening): Changing {
  const now = ctx.now.mono;
  if (afterSeconds(opening.end, slice.autoStopS) > now) {
    const zero = opening.kind === TriggerKind.ZeroCountdown;
    // D102: a late report says when its countdown would have ended (`late_report_sirens`).
    const endWallMs = ctx.now.wall - (now - opening.end) / MICROS_PER_MILLISECOND;
    return addTrigger(slice, ctx, {
      sensor: opening.sensor,
      kind: opening.kind,
      base: opening.end,
      cause: opening.cause,
      starting: zero ? "alarm" : "late_report_sirens",
      ...(zero ? {} : { happenedAtMs: endWallMs }),
    });
  }
  const openedWallMs = ctx.now.wall - (now - opening.opened) / MICROS_PER_MILLISECOND;
  return decide(ctx, "now", {
    kind: "late_report_notification",
    device: opening.sensor,
    cause: opening.cause,
    value: Math.floor(openedWallMs / MILLISECONDS_PER_SECOND),
  }).map(({ message }) => ({ slice, out: [message] }));
}

/**
 * A countdown's end (AL3): if its sensor is still armed, an alarm trigger; the countdown row goes
 * either way. The automatic stop counts from the deadline.
 */
export function onCountdownEnd(
  slice: AlarmSlice,
  ctx: Context,
  sensor: DeviceId,
  sirens?: SirenSource,
  /** When it ended, wall milliseconds, for a countdown that ended before a stop (D102, D113). */
  happenedAtMs?: number,
): Changing {
  const countdown = slice.countdowns.get(sensor);
  if (countdown === undefined || countdown.deadline > ctx.now.mono) return unchanged(slice);
  const countdowns = new Map(slice.countdowns);
  countdowns.delete(sensor);
  const removed = ok({
    slice: { ...slice, countdowns },
    out: [writeNow({ table: "countdowns", op: "delete", key: { sensorId: sensor } })],
  });
  if (slice.sensors.get(sensor)?.arm !== ArmState.Armed) return removed;
  return then(removed, (current) =>
    addTrigger(
      current,
      ctx,
      {
        sensor,
        kind: TriggerKind.CountdownEnd,
        base: countdown.deadline,
        cause: countdown.cause,
        starting: "alarm",
        ...(happenedAtMs === undefined ? {} : { happenedAtMs }),
      },
      sirens,
    ),
  );
}

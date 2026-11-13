/**
 * The reply and the disarmed notice (hub-design.md section 8, "When to reply", "The reply rate"
 * and "Which gateway a packet goes through"; protocol.md §4, §6, §7). A reply carries the full
 * settings of one version, is bound to the counter of the packet it answers, takes the hub's next
 * counter to the sensor (its resume point written now when it asks for one, section 4), and goes
 * as a `radioOut` through the gateway that delivered the answered packet: a heartbeat reply at
 * the fixed moment on that gateway's clock, an event reply as soon as possible but no later than
 * the sensor still listens.
 */
import { err, ok, type Result } from "neverthrow";
import {
  Direction,
  MaxPacketLength,
  MessageType,
  type MessageOf,
  takeSendCounter,
  TransmitPriority,
} from "@hsn/protocol";
import type { PacketTable } from "../model/audit.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import { type DeviceId, type Seq, moduleSendRef } from "../model/ids.ts";
import type { Internal, RadioPurpose, RadioTiming } from "../model/messages.ts";
import type { SensorConfigRow } from "../model/rows.ts";
import { PACKAGE_SETTINGS_FIELDS, type SensorSettings } from "../model/settings.ts";
import { MICROS_PER_MILLISECOND, type Mono } from "../model/time.ts";
import { fromProtocol, safeCounterBinding, safeEncodeMessage } from "../util/protocol-safe.ts";
import { gatewayPowerDbm } from "../gateways/view.ts";
import { nextSettingFields, siteRow } from "../site/view.ts";
import { sensorWaitMs } from "../slots/view.ts";
import { airtimeMs, eventListenMs, REPLY_PACKET_BYTES } from "./radio.ts";
import { decisionMessage, fault, orFault } from "./records.ts";
import { carriedSettings } from "./settings.ts";
import type { InFlight, SensorEntry, SensorsSlice } from "./state.ts";

type Out = Internal | Effect;

const ORIGIN = "core/sensors/reply";
/** The gateway's microsecond clock is 32 bits on the wire (§6). */
const GATEWAY_CLOCK_WRAP = 2 ** 32;
/** The countdown remaining field is one byte of seconds (§6, Reply). */
const MAX_COUNTDOWN_LEFT_S = 255;

/** The settings fields of a reply, from one version's settings (model/settings.ts's mapping). */
function settingsFields(
  settings: SensorSettings,
): Omit<
  MessageOf<typeof MessageType.Reply>,
  "type" | "flags" | "countdownRemainingSeconds" | "nextHeartbeatTenths"
> {
  const f = PACKAGE_SETTINGS_FIELDS.reply;
  return {
    settingsVersion: settings[f.settingsVersion],
    countdownSeconds: settings[f.countdownSeconds],
    heartbeatIntervalUnits: settings[f.heartbeatIntervalUnits],
    linkCheckEvery: settings[f.linkCheckEvery],
    sendDataRate: settings[f.sendDataRate],
    replyDataRate: settings[f.replyDataRate],
    clockCorrectionTenPpm: settings[f.clockCorrectionTenPpm],
    // The site module is the one place the two next-setting fields are read (D115).
    ...nextSettingFields(settings),
  };
}

/**
 * The reply's "update available" flag: firmware transfer is defined in M3 (§14), so the hub of
 * M1a never sets it.
 */
export const NO_UPDATE = false;

/**
 * A reply carrying `config`'s settings (§6): armed and the countdown's seconds left while one
 * runs (D71), and the next heartbeat in tenths, 0 to keep the schedule.
 */
export function replyMessage(
  config: SensorConfigRow,
  countdownLeftS: number | undefined,
  nextHeartbeatTenths: number,
  updateAvailable = NO_UPDATE,
): MessageOf<typeof MessageType.Reply> {
  const settings = carriedSettings(config);
  const running = settings.armed && countdownLeftS !== undefined && countdownLeftS > 0;
  return {
    type: MessageType.Reply,
    ...settingsFields(settings),
    flags: { armed: settings.armed, countdownStarted: running, updateAvailable },
    countdownRemainingSeconds: running ? Math.min(MAX_COUNTDOWN_LEFT_S, countdownLeftS) : 0,
    nextHeartbeatTenths,
  };
}

/**
 * The fixed moment of a heartbeat reply: 1 s † after the heartbeat's end on its gateway's clock,
 * as the sensor counts it on its own clock (`sensorWaitMs`).
 */
export function heartbeatMoment(
  ctx: Context,
  sensor: DeviceId,
  heldUnits: number,
  gateway: DeviceId,
  endedMicros: number,
): RadioTiming {
  const waitMs = sensorWaitMs(
    ctx.view,
    sensor,
    heldUnits,
    ctx.deps.rules.replies.heartbeatReplyMomentMs,
  );
  const momentUs = Math.round(waitMs * MICROS_PER_MILLISECOND);
  return { kind: "at", gateway, gatewayMicros: (endedMicros + momentUs) % GATEWAY_CLOCK_WRAP };
}

/**
 * The latest moment an event reply may start (section 8): the answered packet's end plus the
 * event listen time at the rate it arrived at (§8 †), less the reply's airtime at its rate.
 */
export function eventLatest(
  ctx: Context,
  endedAt: Mono,
  arrivalRate: number,
  replyRate: number,
): Result<RadioTiming, CoreFault> {
  const listen = eventListenMs(ctx.deps.rules, arrivalRate);
  if (listen === undefined)
    return err(fault(ctx, ORIGIN, "no event listen time for the arrival rate"));
  return orFault(ctx, airtimeMs(replyRate, REPLY_PACKET_BYTES)).map((airtime) => ({
    kind: "asap",
    latest: (endedAt + Math.round((listen - airtime) * MICROS_PER_MILLISECOND)) as Mono,
  }));
}

/** One packet to send to a sensor through a gateway. */
export interface Outgoing {
  readonly entry: SensorEntry;
  readonly message:
    MessageOf<typeof MessageType.Reply> | MessageOf<typeof MessageType.DisarmedNotice>;
  /** The counter of the sensor packet it is bound to (§4). */
  readonly binding: number;
  readonly gateway: DeviceId | undefined;
  readonly timing: RadioTiming;
  readonly rate: number;
  readonly purpose: RadioPurpose;
  readonly table: PacketTable;
  /** The record of the packet it answers, for its decisions. */
  readonly cause: Seq | undefined;
  /** For a reply naming a next heartbeat: the answered counter, which gives a slot once sent. */
  readonly slotFor: number | undefined;
}

/** A sealed packet, the sensor with its counter taken, and the writes that counter asks for. */
export interface Sealed {
  readonly entry: SensorEntry;
  readonly packet: Uint8Array;
  readonly counter: number;
  readonly writes: readonly Effect[];
}

/**
 * Takes the hub's next counter to the sensor and seals `message` bound to `binding` (§4). A
 * counter that is a multiple of 1,024 has its resume point written now, in the same step, so the
 * send gate lets the packet pass after the commit (section 4).
 */
export function seal(
  ctx: Context,
  entry: SensorEntry,
  message: Outgoing["message"],
  binding: number,
): Result<Sealed, CoreFault> {
  return orFault(ctx, fromProtocol(takeSendCounter(entry.counter))).andThen((taken) =>
    orFault(ctx, safeCounterBinding(binding)).andThen((bound) =>
      orFault(
        ctx,
        ctx.deps.cipher.seal(entry.device, message, {
          direction: Direction.FromHub,
          address: entry.address,
          counter: taken.counter,
          binding: bound,
          maxLength: MaxPacketLength.Radio,
        }),
      ).map((packet): Sealed => ({
        entry: { ...entry, counter: taken.state },
        packet,
        counter: taken.counter,
        writes:
          taken.saveResumePoint === undefined
            ? []
            : [
                {
                  kind: "write",
                  durability: "now",
                  op: {
                    table: "send_counters",
                    op: "upsert",
                    row: { deviceId: entry.device, resumePoint: taken.saveResumePoint },
                  },
                },
              ],
      })),
    ),
  );
}

/**
 * Hands an already sealed packet to a gateway: a `radioOut` with a new reference, kept in flight
 * for its `tx` row when the outcome comes (section 6).
 */
export function radioOut(
  ctx: Context,
  slice: SensorsSlice,
  outgoing: Omit<Outgoing, "entry" | "binding">,
  device: DeviceId,
  packet: Uint8Array,
  counter: number,
): Result<{ readonly slice: SensorsSlice; readonly out: readonly Out[] }, CoreFault> {
  return orFault(ctx, safeEncodeMessage(outgoing.message)).map((plaintext) => {
    const ref = moduleSendRef("sensors", slice.nextRef);
    // At the gateway's default transmit power, from its settings (section 8, "Powers").
    const power =
      (outgoing.gateway === undefined
        ? undefined
        : gatewayPowerDbm(ctx.view, outgoing.gateway, outgoing.purpose)) ??
      siteRow(ctx.view).replyPowerDbm;
    const flight: InFlight = {
      device,
      purpose: outgoing.purpose,
      table: outgoing.table,
      type: outgoing.message.type,
      counter,
      // The plaintext after the type byte (section 6, `tx_*.body`).
      body: plaintext.slice(1),
      rate: outgoing.rate,
      power,
      slotFor: outgoing.slotFor,
      cause: outgoing.cause,
    };
    return {
      slice: {
        ...slice,
        nextRef: slice.nextRef + 1,
        inFlight: new Map(slice.inFlight).set(ref, flight),
      },
      out: [
        {
          kind: "radioOut",
          ref,
          device,
          packet,
          counter,
          gateway: outgoing.gateway,
          timing: outgoing.timing,
          dataRate: outgoing.rate,
          // Replies and notices at the gateway's default transmit power (section 8, "Powers").
          powerDbm: power,
          priority: TransmitPriority.Normal,
          purpose: outgoing.purpose,
        },
      ],
    };
  });
}

/** Seals and sends one packet, with the `reply` or `disarmed_notice` decision (D110). */
export function send(
  ctx: Context,
  slice: SensorsSlice,
  outgoing: Outgoing,
): Result<
  { readonly slice: SensorsSlice; readonly out: readonly Out[]; readonly sealed: Sealed },
  CoreFault
> {
  return seal(ctx, outgoing.entry, outgoing.message, outgoing.binding).andThen((sealed) => {
    const withEntry = {
      ...slice,
      sensors: new Map(slice.sensors).set(sealed.entry.device, sealed.entry),
    };
    const kind = outgoing.purpose === "disarmedNotice" ? "disarmed_notice" : "reply";
    const value = kind === "disarmed_notice" ? outgoing.binding : sealed.counter;
    const cause = outgoing.cause ?? null;
    return radioOut(
      ctx,
      withEntry,
      outgoing,
      sealed.entry.device,
      sealed.packet,
      sealed.counter,
    ).andThen((sent) => {
      const done = { slice: sent.slice, out: [...sealed.writes, ...sent.out], sealed };
      // A heartbeat's reply is recorded by its `tx_routine` row alone, kept 30 days like the
      // heartbeat (D57); an event's reply keeps its decision, which names the report it answers.
      if (outgoing.purpose === "heartbeatReply") return ok(done);
      return decisionMessage(
        ctx,
        { kind, device: sealed.entry.device, cause, value },
        "routine",
      ).map((recorded) => ({ ...done, out: [...done.out, recorded] }));
    });
  });
}

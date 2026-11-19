/**
 * What the sensors module sends a sensor besides its replies (docs/m3-updates-design.md sections 4,
 * 5 and 7): the Update offers firmware decides, and the Key changes after a restore. The sensor's
 * key is this module's (HD 2): firmware decides, this module seals.
 *
 * - **An Update offer** (0x83) is sent only in answer to one of the sensor's packets, bound to its
 *   counter (§4): the `answers` firmware names, which must be the sensor's newest accepted packet
 *   of this step. It goes the way that packet came: through the gateway that delivered it, as soon
 *   as possible while the sensor still listens (an update query or status is always answered and
 *   the sensor listens for it as for an event, §5), or on the network link it came on, a sensor's
 *   Wi-Fi joined for its update (§10). An offer that answers nothing is not sent: a sensor is only
 *   ever answered.
 * - **A Key change** (0x84) answers a packet under a key the hub held at the backup
 *   (`oldKeyPacket`), bound to its counter, sealed under the key the packet came under, the way
 *   the packet came: a heartbeat at its reply moment (the sensor listens then, §7), anything else
 *   as an event's reply, a packet on a link on that link. At most one every 10 s ‡ per sensor
 *   (`HubRules.keyChange`), with `key_change_sent` (its counter). Its key's write goes with it.
 * - **The switch** (`key_changed`): the sensor's counter starts again at 1, its resume point and
 *   new key written now, before the reply to the switching packet is sealed under the new key.
 */
import { err, ok, type Result } from "neverthrow";
import { MessageType } from "@hsn/protocol";
import type { KeyUsed } from "../model/cipher.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context, Handled } from "../model/handler.ts";
import { type DeviceId, moduleSendRef, type Seq } from "../model/ids.ts";
import type { Arrival, Internal } from "../model/messages.ts";
import { PacketPath, TxOutcome } from "../model/rows.ts";
import {
  afterSwitch,
  keyChangeAllowed,
  lastOldKey,
  makeKeyChange,
  recordedBody,
  switchedCounter,
  switchWrites,
  withKeyChange,
} from "../intake/view.ts";
import { safeEncodeMessage } from "../util/protocol-safe.ts";
import { isFollowing, type Lora, replyRateFor } from "./answer.ts";
import { isKnownRate } from "./radio.ts";
import { decisionMessage, orFault, recordMessage } from "./records.ts";
import {
  eventLatest,
  heartbeatMoment,
  type Outgoing,
  radioOut,
  seal,
  type SensorMessage,
} from "./reply.ts";
import type { SensorEntry, SensorsSlice } from "./state.ts";

type Out = Internal | Effect;
type Step = Result<Handled<"sensors">, CoreFault>;
interface Sent {
  readonly slice: SensorsSlice;
  readonly out: readonly Out[];
  readonly counter: number;
}

/** An answer to one of the sensor's packets, not a reply: an Update offer or a Key change. */
interface Answer {
  readonly entry: SensorEntry;
  readonly message: SensorMessage;
  /** The answered packet: its counter is the binding, its path the way back. */
  readonly counter: number;
  readonly arrival: Arrival;
  readonly cause: Seq;
  /** The type of the answered packet, for a heartbeat's reply moment. */
  readonly answeredType: number;
  /** The version the answered packet names and its flag bit 7, for the rate. */
  readonly named: number | undefined;
  readonly atSendRate: boolean;
  /** The key to seal under: a Key change's is the one its packet came under. */
  readonly under: KeyUsed | undefined;
}

/** The sensor's newest accepted packet, kept for the offer that may answer it in this step. */
export function rememberAnswerable(
  slice: SensorsSlice,
  accepted: Extract<Internal, { kind: "accepted" }>,
): SensorsSlice {
  if (!accepted.newest || !slice.sensors.has(accepted.device)) return slice;
  const answerable = new Map(slice.answerable).set(accepted.device, {
    record: accepted.record,
    counter: accepted.counter,
    arrival: accepted.arrival,
  });
  return { ...slice, answerable };
}

/** The `tx` row's path of a packet sent on a link (section 6). */
function linkPath(arrival: Exclude<Arrival, Lora>): PacketPath {
  return arrival.path === "usb" ? PacketPath.Usb : PacketPath.Wifi;
}

/** Seals the answer and sends it on the link its packet came on, recorded as handed to it. */
function onLink(
  ctx: Context,
  slice: SensorsSlice,
  answer: Answer,
  arrival: Exclude<Arrival, Lora>,
): Result<Sent, CoreFault> {
  return seal(ctx, answer.entry, answer.message, answer.counter, slice.keys, answer.under).andThen(
    (sealed) =>
      orFault(ctx, safeEncodeMessage(answer.message)).andThen((plaintext) =>
        ctx.records.take().map((seq): Sent => {
          const ref = moduleSendRef("sensors", slice.nextRef);
          const next: SensorsSlice = {
            ...slice,
            nextRef: slice.nextRef + 1,
            sensors: new Map(slice.sensors).set(sealed.entry.device, sealed.entry),
          };
          const device = sealed.entry.device;
          return {
            slice: next,
            counter: sealed.counter,
            out: [
              ...sealed.writes,
              {
                kind: "send",
                link: arrival.link,
                bytes: sealed.packet,
                ref,
                counters: [{ device, counter: sealed.counter }],
              },
              recordMessage("routine", {
                kind: "tx",
                table: "event",
                row: {
                  seq,
                  atMs: ctx.now.wall,
                  clockOk: ctx.now.wallTrusted,
                  deviceId: device,
                  type: answer.message.type,
                  counter: sealed.counter,
                  path: linkPath(arrival),
                  gatewayId: null,
                  requestCounter: null,
                  resultCounter: null,
                  rate: null,
                  power: null,
                  outcome: TxOutcome.HandedToLink,
                  gwSentUs: null,
                  body: recordedBody(answer.message.type, plaintext.slice(1)),
                },
              }),
            ],
          };
        }),
      ),
  );
}

/**
 * Sends the answer: on its packet's link, or through the gateway that delivered it. A Key change to
 * a heartbeat is sent even when its moment may be too late (section 8's 700 ms ‡ rule is for
 * replies): the key it carries is made and written in this step whatever happens, and a gateway
 * that is too late only says so.
 */
function sendAnswer(ctx: Context, slice: SensorsSlice, answer: Answer): Result<Sent, CoreFault> {
  const arrival = answer.arrival;
  if (arrival.path !== "lora") return onLink(ctx, slice, answer, arrival);
  const entry = answer.entry;
  const following = isFollowing(ctx, entry, arrival);
  const rate = replyRateFor(entry, answer.named, answer.atSendRate, following, arrival);
  const heartbeat = answer.answeredType === MessageType.Heartbeat;
  const arrivalRate = isKnownRate(arrival.dataRate) ? arrival.dataRate : entry.config.sendRate;
  const timing = heartbeat
    ? ok(
        heartbeatMoment(
          ctx,
          entry.device,
          entry.config.correctionUnits,
          arrival.gateway,
          arrival.gatewayMicros,
        ),
      )
    : eventLatest(ctx, arrival.endedAt, arrivalRate, rate);
  return timing.andThen((at) => {
    const outgoing: Omit<Outgoing, "entry" | "binding"> = {
      message: answer.message,
      gateway: arrival.gateway,
      timing: at,
      rate,
      purpose: heartbeat ? "heartbeatReply" : "eventReply",
      table: "event",
      cause: answer.cause,
      slotFor: undefined,
    };
    return seal(ctx, entry, answer.message, answer.counter, slice.keys, answer.under).andThen(
      (sealed) =>
        radioOut(
          ctx,
          { ...slice, sensors: new Map(slice.sensors).set(entry.device, sealed.entry) },
          outgoing,
          entry.device,
          sealed.packet,
          sealed.counter,
        ).map((sent) => ({
          slice: sent.slice,
          out: [...sealed.writes, ...sent.out],
          counter: sealed.counter,
        })),
    );
  });
}

/** The version a packet names and its flag bit 7, as a reply to it would go by (section 8). */
function namedOf(
  entry: SensorEntry,
  message: Extract<Internal, { kind: "oldKeyPacket" }>["message"] | undefined,
): { readonly named: number | undefined; readonly atSendRate: boolean } {
  switch (message?.type) {
    case MessageType.Heartbeat:
    case MessageType.DoorChanged:
    case MessageType.CoverChanged:
    case MessageType.Button:
      return {
        named: message.settingsVersion,
        atSendRate: message.flags.listeningAtSendRate,
      };
    case MessageType.Started:
      return { named: message.settingsVersion, atSendRate: false };
    default:
      // An update query or status, or log entries: the newest status packet decides (section 8).
      return {
        named: entry.status?.version,
        atSendRate: entry.status?.listeningAtSendRate === true,
      };
  }
}

/** Firmware's Update offer for a sensor, in answer to the packet it names (m3-updates section 5). */
export function onUpdateOffer(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "updateOffer" }>,
  ctx: Context,
): Step {
  const entry = slice.sensors.get(message.device);
  const answers = message.answers;
  const answered = slice.answerable.get(message.device);
  if (
    entry === undefined ||
    answers === undefined ||
    answered?.record !== answers.record ||
    answered.counter !== answers.counter
  ) {
    return ok({ slice, out: [] });
  }
  const named = namedOf(entry, undefined);
  return sendAnswer(ctx, slice, {
    entry,
    message: message.offer,
    counter: answers.counter,
    arrival: answered.arrival,
    cause: answers.record,
    answeredType: MessageType.UpdateQuery,
    ...named,
    under: undefined,
  }).map((sent) => ({ slice: sent.slice, out: sent.out }));
}

/**
 * A packet from a sensor under a key the hub held at the backup (D141): answered with a Key change,
 * at most one every 10 s ‡; never acted on otherwise.
 */
export function onOldKeyPacket(
  slice: SensorsSlice,
  message: Extract<Internal, { kind: "oldKeyPacket" }>,
  ctx: Context,
): Step {
  const entry = slice.sensors.get(message.device);
  const change = slice.keys.entries.get(message.device);
  if (entry === undefined || change === undefined) return ok({ slice, out: [] });
  if (!keyChangeAllowed(change, ctx.now.mono, ctx.deps.rules)) return ok({ slice, out: [] });
  const keyUsed = lastOldKey(ctx.view, message.device) ?? "current";
  return makeKeyChange(ctx, message.device, change, keyUsed).andThen((made) =>
    sendAnswer(ctx, slice, {
      entry,
      message: made.message,
      counter: message.counter,
      arrival: message.arrival,
      cause: message.record,
      answeredType: message.message.type,
      ...namedOf(entry, message.message),
      under: made.sealUnder,
    }).andThen((sent): Step =>
      decisionMessage(
        ctx,
        {
          kind: "key_change_sent",
          device: message.device,
          cause: message.record,
          value: sent.counter,
        },
        "routine",
      ).map((recorded) => ({
        slice: { ...sent.slice, keys: withKeyChange(sent.slice.keys, message.device, made.entry) },
        out: [...made.writes, ...sent.out, recorded],
      })),
    ),
  );
}

/**
 * The sensor's first packet under its new key (`key_changed`, from intake): the key and the counter
 * start again, written now with the packet (D141, §4). The counters it sent under the old key are
 * forgotten with it: the loss count and the slot start again too.
 */
export function onKeyChanged(slice: SensorsSlice, device: DeviceId, ctx: Context): Step {
  const entry = slice.sensors.get(device);
  if (entry === undefined) return ok({ slice, out: [] });
  const written = switchWrites(ctx, device, slice.keys.entries.get(device));
  if (written.isErr()) return err(written.error);
  const next: SensorEntry = {
    ...entry,
    counter: switchedCounter(ctx.deps.rules),
    lastCounter: 0,
    slotFrom: undefined,
  };
  return ok({
    slice: {
      ...slice,
      sensors: new Map(slice.sensors).set(device, next),
      keys: afterSwitch(slice.keys, device),
    },
    out: written.value,
  });
}

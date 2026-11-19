/**
 * Commands and settings to a siren (hub-design.md section 8, "What the siren should do, and
 * commands" and "Which gateway a packet goes through"; §7 "Siren command", steps 1 to 5; D73,
 * SR4). One packet is sealed once and sent on both paths: to every open WebSocket that carried an
 * accepted packet from the siren in the last 60 s ‡, and through the gateway that heard it best
 * on LoRa. It is repeated every 2 s on Wi-Fi and every 5 s on LoRa until a report confirms it, for
 * up to a minute. One at a time: a newer command replaces the one in flight; settings wait.
 */
import { ok, Result } from "neverthrow";
import {
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  type SirenAction,
  takeSendCounter,
  TransmitPriority,
} from "@hsn/protocol";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import { type DeviceId, type LinkId, type Seq, type SendRef, moduleSendRef } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { deviceById } from "../registry/view.ts";
import { failingCommitWrites, sealKeyOf } from "../intake/view.ts";
import { PacketPath, TxOutcome } from "../model/rows.ts";
import type { Mono } from "../model/time.ts";
import { safeEncodeMessage } from "../util/protocol-safe.ts";
import {
  after,
  type Changing,
  decide,
  fault,
  fromProtocolResult,
  type Out,
  then,
  txRecord,
  unchanged,
  writeNow,
} from "./out.ts";
import { commandRateFor, settingsMessage } from "./settings.ts";
import type { InFlight, SentPacket, SirenEntry, SirensSlice } from "./state.ts";

/** A report names the low 16 bits of the counter it acted on (§6, Siren report). */
const COUNTER_LOW_MASK = 0xffff;

/** What `siren_command`'s value packs: action × 65,536 + seconds (`DECISION_KINDS`). */
/** A siren command's body as §6 lays it out: the action (1 byte), the seconds (2 bytes, LE). */
function commandBody(action: number, seconds: number): Uint8Array {
  const body = new Uint8Array(3);
  const view = new DataView(body.buffer);
  view.setUint8(0, action);
  view.setUint16(1, seconds, true);
  return body;
}

/** The low 16 bits of a counter, as a report names it (§6). */
export function counterLow(counter: number): number {
  return counter & COUNTER_LOW_MASK;
}

/** A packet to put in flight: a command with its action and seconds, or a settings version. */
export type Packet =
  | { readonly purpose: "sirenCommand"; readonly action: number; readonly seconds: number }
  | { readonly purpose: "sirenSettings"; readonly moveSettings: boolean };

function messageOf(entry: SirenEntry, packet: Packet): Message {
  return packet.purpose === "sirenCommand"
    ? { type: MessageType.SirenCommand, action: packet.action, soundSeconds: packet.seconds }
    : settingsMessage(entry.settings);
}

/** The open sockets that carried an accepted packet from the siren in the last 60 s ‡. */
export function recentSockets(entry: SirenEntry, now: Mono, windowMs: number): readonly LinkId[] {
  return [...entry.paths.sockets]
    .filter(([, at]) => after(at, windowMs) >= now)
    .map(([link]) => link);
}

/**
 * The gateway for a LoRa command (section 8): the one that heard the siren best in the last 15
 * minutes ‡ among open sessions, the most recent on a tie; else any connected one, the lowest id;
 * else none, and the command goes on Wi-Fi only.
 */
export function bestGateway(
  slice: SirensSlice,
  entry: SirenEntry,
  now: Mono,
  windowMs: number,
): DeviceId | undefined {
  const heard = entry.paths.heard.filter(
    (copy) => slice.gateways.has(copy.gateway) && after(copy.at, windowMs) >= now,
  );
  const best = heard.reduce<(typeof heard)[number] | undefined>(
    (chosen, copy) =>
      chosen === undefined ||
      copy.snrQuarterDb > chosen.snrQuarterDb ||
      (copy.snrQuarterDb === chosen.snrQuarterDb && copy.at >= chosen.at)
        ? copy
        : chosen,
    undefined,
  );
  if (best !== undefined) return best.gateway;
  return [...slice.gateways].sort((a, b) => a - b)[0];
}

/** Which paths a transmission takes. */
interface Paths {
  readonly wifi: boolean;
  readonly lora: boolean;
}

/** The slice's next reference and the entry kept for the packet's `tx` row. */
export function remember(
  slice: SirensSlice,
  packet: SentPacket,
): { readonly slice: SirensSlice; readonly ref: SendRef } {
  const ref = moduleSendRef("sirens", slice.nextRef);
  return {
    ref,
    slice: { ...slice, nextRef: slice.nextRef + 1, sent: new Map(slice.sent).set(ref, packet) },
  };
}

/**
 * Sends the siren's packet in flight on the paths asked for: a `send` per recent socket and a
 * `radioOut` through the best gateway. A Wi-Fi packet's `tx` row is written as handed to the link;
 * a LoRa one's when its transmit result comes back (section 6).
 */
export function transmit(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  paths: Paths,
): Changing {
  const entry = slice.sirens.get(siren);
  const flight = entry?.inFlight;
  if (entry === undefined || flight === undefined) return unchanged(slice);
  const rules = ctx.deps.rules;
  const now = ctx.now.mono;
  const pruned = prune(slice, ctx);
  const sockets = paths.wifi ? recentSockets(entry, now, rules.sirens.wifiSocketWindowMs) : [];
  const gateway = paths.lora
    ? bestGateway(pruned, entry, now, rules.sirens.bestGatewayWindowMs)
    : undefined;
  const base = {
    siren,
    type: flight.type,
    counter: flight.counter,
    body: flight.body,
    at: now,
  };
  let current = pruned;
  const out: Internal[] = [];
  const effects: Out[number][] = [];
  const records: Result<Internal, CoreFault>[] = [];
  for (const link of sockets) {
    const kept = remember(current, {
      ...base,
      path: PacketPath.Wifi,
      gateway: undefined,
      rate: undefined,
      power: undefined,
    });
    current = kept.slice;
    effects.push({
      kind: "send",
      link,
      bytes: flight.packet,
      ref: kept.ref,
      counters: [{ device: siren, counter: flight.counter }],
    });
    records.push(
      txRecord(ctx, {
        deviceId: siren,
        type: flight.type,
        counter: flight.counter,
        path: PacketPath.Wifi,
        gatewayId: null,
        requestCounter: null,
        resultCounter: null,
        rate: null,
        power: null,
        outcome: TxOutcome.HandedToLink,
        gwSentUs: null,
        body: flight.body,
      }),
    );
  }
  if (gateway !== undefined) {
    const dataRate = commandRateFor(entry.history, entry.settings, entry.reported?.version);
    const powerDbm = rules.powers.sirenTxPowerDbm;
    const kept = remember(current, {
      ...base,
      path: PacketPath.Lora,
      gateway,
      rate: dataRate,
      power: powerDbm,
    });
    current = kept.slice;
    out.push({
      kind: "radioOut",
      ref: kept.ref,
      device: siren,
      packet: flight.packet,
      counter: flight.counter,
      gateway,
      timing: { kind: "asap", latest: undefined },
      dataRate,
      powerDbm,
      priority: TransmitPriority.SirenCommand,
      purpose: flight.purpose,
    });
  }
  return Result.combine(records).map((recorded) => ({
    slice: current,
    out: [...effects, ...recorded, ...out],
  }));
}

/** Drops kept packets whose outcome can no longer come (section 7, "A busy gateway"). */
function prune(slice: SirensSlice, ctx: Context): SirensSlice {
  const { giveUpMs } = ctx.deps.rules.sirens;
  const { resultNoLimitMs, resultGraceMs } = ctx.deps.rules.gateways;
  const horizon = giveUpMs + resultNoLimitMs + resultGraceMs;
  const kept = [...slice.sent].filter(([, packet]) => after(packet.at, horizon) >= ctx.now.mono);
  return kept.length === slice.sent.size ? slice : { ...slice, sent: new Map(kept) };
}

/**
 * Puts a new packet in flight, replacing any (§7, step 5), and sends it on both paths. It takes
 * the next hub counter, saving the next resume point now when the counter asks (section 4), and
 * records `siren_command` or `siren_settings`; with no path at all, `no_path` too.
 */
export function issue(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  packet: Packet,
  cause: Seq | undefined,
): Changing {
  const entry = slice.sirens.get(siren);
  // The address is the registry's (section 2: the registry owns devices' addresses).
  const address = deviceById(ctx.view, siren)?.address;
  if (entry === undefined || address === undefined) return unchanged(slice);
  const now = ctx.now.mono;
  const rules = ctx.deps.rules.sirens;
  const message = messageOf(entry, packet);
  return fromProtocolResult(ctx, takeSendCounter(entry.counter))
    .andThen((taken) =>
      ctx.deps.cipher
        .seal(siren, message, {
          direction: Direction.FromHub,
          address,
          counter: taken.counter,
          binding: NO_BINDING,
          maxLength: MaxPacketLength.Radio,
          // After the siren's switch to its new key in this run, its new key (D141).
          ...(sealKeyOf(slice.keys, siren) === "next" ? { key: "next" as const } : {}),
        })
        .andThen((sealed) => safeEncodeMessage(message).map((plain) => ({ sealed, plain })))
        .mapErr((error) => fault(ctx, error))
        .map(({ sealed, plain }) => ({ taken, sealed, plain })),
    )
    .andThen(({ taken, sealed, plain }) => {
      const flight: InFlight = {
        purpose: packet.purpose,
        action: packet.purpose === "sirenCommand" ? packet.action : undefined,
        seconds: packet.purpose === "sirenCommand" ? packet.seconds : 0,
        version: packet.purpose === "sirenSettings" ? entry.settings.version : undefined,
        counter: taken.counter,
        packet: sealed,
        type: message.type,
        body: plain.subarray(1),
        since: now,
        nextWifi: after(now, rules.wifiRepeatMs),
        nextLora: after(now, rules.loraRepeatMs),
        giveUpAt: after(now, rules.giveUpMs),
        slowRepeatAt: undefined,
        moveSettings: packet.purpose === "sirenSettings" && packet.moveSettings,
        cause,
      };
      // Settings replaced by a command wait for it; settings put in flight wait no more.
      const replaced = entry.inFlight?.purpose === "sirenSettings" ? entry.inFlight : undefined;
      const isSettings = packet.purpose === "sirenSettings";
      const next: SirenEntry = {
        ...entry,
        counter: taken.state,
        inFlight: flight,
        settingsWanted: !isSettings && (entry.settingsWanted || replaced !== undefined),
        moveSettings: !isSettings && (entry.moveSettings || replaced?.moveSettings === true),
      };
      const saved: Out =
        taken.saveResumePoint === undefined
          ? failingCommitWrites(slice.keys, siren, taken.state)
          : [
              writeNow({
                table: "send_counters",
                op: "upsert",
                row: { deviceId: siren, resumePoint: taken.saveResumePoint },
              }),
            ];
      const kind = packet.purpose === "sirenCommand" ? "siren_command" : "siren_settings";
      // A command: its action, and its body as the protocol lays it out (action, then the
      // seconds, 2 bytes little-endian, §6); settings: their version.
      const value = packet.purpose === "sirenCommand" ? packet.action : entry.settings.version;
      const detail =
        packet.purpose === "sirenCommand" ? commandBody(packet.action, packet.seconds) : undefined;
      const placed: SirensSlice = { ...slice, sirens: new Map(slice.sirens).set(siren, next) };
      return decide(ctx, "routine", kind, siren, cause, value, detail).andThen((decision) =>
        then(ok({ slice: placed, out: [...saved, decision] }), (s) =>
          then(transmit(s, ctx, siren, { wifi: true, lora: true }), (sent) =>
            noPathRecorded(sent, ctx, siren, cause),
          ),
        ),
      );
    });
}

/** `no_path` when a new packet found neither a socket nor a gateway (section 8). */
function noPathRecorded(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  cause: Seq | undefined,
): Changing {
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  const rules = ctx.deps.rules.sirens;
  const now = ctx.now.mono;
  const none =
    recentSockets(entry, now, rules.wifiSocketWindowMs).length === 0 &&
    bestGateway(slice, entry, now, rules.bestGatewayWindowMs) === undefined;
  return none
    ? decide(ctx, "now", "no_path", siren, cause).map((message) => ({ slice, out: [message] }))
    : unchanged(slice);
}

/** A command (§6, Siren command): seconds are capped by the siren's longest sound and the field. */
export function command(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  action: SirenAction,
  seconds: number,
  cause: Seq | undefined,
): Changing {
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  const capped = Math.min(seconds, entry.settings.maxSoundS, COUNTER_LOW_MASK);
  return issue(slice, ctx, siren, { purpose: "sirenCommand", action, seconds: capped }, cause);
}

/** The settings of the current version, now if nothing is in flight; else they wait (§7, step 5). */
export function sendSettings(
  slice: SirensSlice,
  ctx: Context,
  siren: DeviceId,
  moveSettings: boolean,
): Changing {
  const entry = slice.sirens.get(siren);
  if (entry === undefined) return unchanged(slice);
  if (entry.inFlight === undefined) {
    return issue(slice, ctx, siren, { purpose: "sirenSettings", moveSettings }, undefined);
  }
  const next: SirenEntry = {
    ...entry,
    settingsWanted: true,
    moveSettings: entry.moveSettings || moveSettings,
  };
  return ok({ slice: { ...slice, sirens: new Map(slice.sirens).set(siren, next) }, out: [] });
}

/** Resume points of every siren key, written again after a failed commit (section 4). */
export function resumePoints(slice: SirensSlice): Out {
  return [...slice.sirens].map(([siren, entry]) =>
    writeNow({
      table: "send_counters",
      op: "upsert",
      row: { deviceId: siren, resumePoint: entry.counter.resumePoint },
    }),
  );
}

/**
 * A packet from a gateway's address (hub-design.md section 8, "Gateway sessions" and "Accepting
 * a device packet"; protocol.md §3 to §6). It is opened under each session on its link (live,
 * then unproven), and only if none fits, as a hello with no binding. A session-bound packet
 * must carry a counter above the last one on that connection; its type must be one a gateway
 * sends on a session (§5). Then:
 *
 * - a forwarded packet is unwrapped into a device packet with the gateway's fields, its end
 *   mapped onto the hub's clock;
 * - a status is recorded and judged (settings version, noise, damaged packets);
 * - a transmit result goes back to the request's module;
 * - an interference report is a decision, written now;
 * - Started and log entries are recorded.
 *
 * Every refusal is a counted rejection and changes nothing else.
 */
import { err, Result } from "neverthrow";
import {
  InterferenceEvent,
  MaxPacketLength,
  type Message,
  type MessageOf,
  MessageType,
  NO_BINDING,
  type OpenedPacket,
  type PacketHeader,
  type ProtocolError,
  readPacketHeader,
} from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { RejectReason } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { LinkId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { monoAfterMs } from "../model/time.ts";
import { deviceAtAddress, linkKind, rejection } from "../links/view.ts";
import { done, type Outcome, setTimer, then, withGateway } from "./common.ts";
import { toHub, withSample } from "./clock.ts";
import { judgeStatus } from "./noise.ts";
import { deviceStateWrite } from "./persist.ts";
import { bodyOf, decision, logEntries, received } from "./records.ts";
import { acceptedMessage, handleHello, prove, sendSettings } from "./sessions.ts";
import { surveyStatus } from "./survey.ts";
import type { GatewayEntry, GatewaysSlice, Session, StatusReading } from "./state.ts";
import { handleTransmitResult } from "./transmit.ts";
import { safeCheckStrictlyHigher } from "../util/protocol-safe.ts";
import { asFault } from "./common.ts";

/** The types a gateway sends on its session (§5): anything else from its key is `wrongPath`. */
const SESSION_TYPES: ReadonlySet<number> = new Set([
  MessageType.ForwardedPacket,
  MessageType.GatewayStatus,
  MessageType.TransmitResult,
  MessageType.Interference,
  MessageType.Started,
  MessageType.LogEntries,
]);

type Reject = (reason: RejectReason) => Outcome;

/** The gateway was heard (§7, D97): its silence timer starts again, and a silent one is back. */
function heard(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  ctx: Context,
): { readonly slice: GatewaysSlice; readonly entry: GatewayEntry; readonly back: boolean } {
  const next: GatewayEntry = {
    ...entry,
    lastHeardAt: ctx.now.mono,
    lastHeardMs: ctx.now.wall,
    lastHeardTrusted: ctx.now.wallTrusted,
    offline: false,
  };
  const timed = setTimer(withGateway(slice, next), {
    at: monoAfterMs(ctx.now.mono, ctx.deps.rules.silence.gatewayOfflineMs),
    key: { module: "gateways", kind: "offline", gateway: entry.device },
  });
  return { slice: timed, entry: next, back: entry.offline };
}

/** One packet from a gateway's address on `link`. */
export function handleGatewayPacket(
  slice: GatewaysSlice,
  link: LinkId,
  bytes: Uint8Array,
  ctx: Context,
): Outcome {
  const header = readPacketHeader(bytes, MaxPacketLength.Link);
  if (!header.ok) return done(slice, [rejection({ link }, header.error.code, bytes, undefined)]);
  const { address } = header.value;
  const known = deviceAtAddress(ctx.view, address);
  const entry = known === undefined ? undefined : slice.gateways.get(known.device);
  const kind = linkKind(ctx.view, link);
  if (entry === undefined || kind === undefined) {
    return done(slice, [rejection({ link }, "unknownAddress", bytes, address)]);
  }
  const reject: Reject = (reason) =>
    done(slice, [rejection({ device: entry.device }, reason, bytes, address)]);

  const sessions = [
    ...(entry.live?.link === link ? [entry.live] : []),
    ...entry.candidates.filter((c) => c.link === link),
  ];
  for (const session of sessions) {
    const opened = ctx.deps.cipher.open(entry.device, bytes, {
      binding: session.binding,
      maxLength: MaxPacketLength.Link,
    });
    if (opened.isOk()) return onSession(slice, entry, session, opened.value, ctx, reject);
    // Only the tag depends on the binding: any other error is the packet's own.
    if (opened.error.error.code !== "badTag") return reject(opened.error.error.code);
  }

  const unbound = ctx.deps.cipher.open(entry.device, bytes, {
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Link,
  });
  if (unbound.isErr()) return reject(unboundReason(unbound.error.error, sessions.length > 0));
  const { message } = unbound.value;
  if (message.type !== MessageType.Hello) return reject("noSession");
  const fresh = heardIfFresh(slice, entry, header.value, ctx);
  return handleHello(fresh.slice, fresh.entry, link, kind, header.value, message, bytes, ctx);
}

/**
 * Why a packet that opened under no session failed with no binding either: a bad tag on a link
 * with no session is most likely a packet of a session the hub no longer has (`noSession`).
 */
function unboundReason(error: ProtocolError, linkHasSession: boolean): RejectReason {
  return error.code === "badTag" && !linkHasSession ? "noSession" : error.code;
}

/** A hello is heard only when it will be accepted: a replayed one changes nothing (§4). */
function heardIfFresh(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  header: PacketHeader,
  ctx: Context,
): { readonly slice: GatewaysSlice; readonly entry: GatewayEntry } {
  return header.counter > entry.highestAccepted ? heard(slice, entry, ctx) : { slice, entry };
}

/** A packet that opened under `session`. */
function onSession(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  session: Session,
  opened: OpenedPacket,
  ctx: Context,
  reject: Reject,
): Outcome {
  const { header, message } = opened;
  const check = safeCheckStrictlyHigher(session.lastReceived, header.counter).mapErr((e) =>
    asFault(ctx, e),
  );
  if (check.isErr()) return err(check.error);
  if (!check.value.accepted) return reject(check.value.reason);
  if (!SESSION_TYPES.has(message.type)) return reject("wrongPath");

  const current: Session = { ...session, lastReceived: header.counter };
  const isLive = entry.live?.link === session.link && entry.live.binding === session.binding;
  const counted: GatewayEntry = {
    ...entry,
    highestAccepted: Math.max(entry.highestAccepted, header.counter),
    live: isLive ? current : entry.live,
    candidates: isLive
      ? entry.candidates
      : entry.candidates.map((c) => (c === session ? current : c)),
  };
  const wasHeard = heard(slice, counted, ctx);
  let next = wasHeard.slice;
  let now = wasHeard.entry;
  const out: (Internal | Effect)[] = [];
  if (!isLive) {
    const proven = prove(next, now, current);
    next = proven.slice;
    now = proven.entry;
    out.push(...proven.out);
  } else if (wasHeard.back) {
    out.push({ kind: "gatewayUp", gateway: now.device, link: current.link });
  }
  return then(done(next, out), (s) => onMessage(s, now, current, header, message, ctx));
}

function onMessage(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  session: Session,
  header: PacketHeader,
  message: Message,
  ctx: Context,
): Outcome {
  switch (message.type) {
    case MessageType.ForwardedPacket:
      return onForwarded(slice, entry, session, header, message, ctx);
    case MessageType.TransmitResult:
      return handleTransmitResult(slice, entry, message);
    case MessageType.GatewayStatus:
      return onStatus(slice, entry, session, header, message, ctx);
    case MessageType.Interference:
      return onInterference(slice, entry, session, header, message, ctx);
    case MessageType.LogEntries:
      return logEntries(ctx, entry.device, header.counter, message.entries).andThen(
        ({ first, records }) =>
          done(slice, [
            ...records,
            ...(first === undefined ? [] : [accepted(entry, session, header, message, first)]),
          ]),
      );
    default:
      return received(
        ctx,
        entry.device,
        message,
        header.counter,
        session.linkKind,
        "event",
      ).andThen((rx) =>
        done(slice, [rx.record, accepted(entry, session, header, message, rx.seq)]),
      );
  }
}

function accepted(
  entry: GatewayEntry,
  session: Session,
  header: PacketHeader,
  message: Message,
  record: Parameters<typeof acceptedMessage>[4],
): Internal {
  return acceptedMessage(message, entry, session.link, session.linkKind, record, header.counter);
}

/**
 * A forwarded packet (§6): the device packet inside, with the gateway's fields and its end on
 * the hub's clock through the session's mapping (section 8), for the intake module. The
 * forwarded packet makes no row of its own (section 6).
 */
function onForwarded(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  session: Session,
  header: PacketHeader,
  message: MessageOf<typeof MessageType.ForwardedPacket>,
  ctx: Context,
): Outcome {
  const now = ctx.now.mono;
  const clock = withSample(
    session.clock,
    message.receivedAtMicros,
    now,
    ctx.deps.rules.slots.clockMappingFrames,
  );
  const mapped: GatewayEntry = { ...entry, live: { ...session, clock } };
  return done(withGateway(slice, mapped), [
    {
      kind: "devicePacket",
      bytes: message.packet,
      arrival: {
        path: "lora",
        gateway: entry.device,
        link: session.link,
        gatewayCounter: header.counter,
        gatewayMicros: message.receivedAtMicros,
        endedAt: toHub(clock, message.receivedAtMicros, now) ?? now,
        rssiDbm: message.rssiDbm,
        snrQuarterDb: message.snrQuarterDb,
        dataRate: message.dataRate,
        siteChannel: message.siteChannel,
      },
    },
  ]);
}

/** A status's figures as the slice keeps them. */
function reading(
  message: MessageOf<typeof MessageType.GatewayStatus>,
  body: Uint8Array,
  ctx: Context,
): StatusReading {
  return {
    at: ctx.now.mono,
    settingsVersion: message.settingsVersion,
    uptimeSeconds: message.uptimeSeconds,
    airtimeHundredthsPercent: message.airtimeHundredthsPercent,
    noiseMedianDbm: message.noiseMedianDbm,
    noiseHighestDbm: message.noiseHighestDbm,
    normalNoiseDbm: message.normalNoiseDbm,
    packetsReceived: message.packetsReceived,
    packetsCrcFailed: message.packetsCrcFailed,
    body,
  };
}

/**
 * A status (section 7, "Gateway connection"): recorded (routine), the reading and baseline kept
 * (routine), the noise judged (section 8), and the settings sent again if it names another
 * version (section 8, "Gateway sessions").
 */
function onStatus(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  session: Session,
  header: PacketHeader,
  message: MessageOf<typeof MessageType.GatewayStatus>,
  ctx: Context,
): Outcome {
  return received(ctx, entry.device, message, header.counter, session.linkKind, "routine").andThen(
    (rx) =>
      bodyOf(ctx, message).andThen((body) => {
        const status = reading(message, body, ctx);
        const judged = judgeStatus(entry.noise, status, ctx.deps.rules);
        const next: GatewayEntry = { ...entry, status, noise: judged.noise };
        const updated = withGateway(slice, next);
        const decisions = Result.combine(
          judged.decisions.map((d) =>
            decision(ctx, {
              kind: d.kind,
              device: entry.device,
              cause: rx.seq,
              value: d.value,
              detail: d.detail,
              durability: "now",
            }),
          ),
        );
        if (decisions.isErr()) return err(decisions.error);
        const recorded = done(updated, [
          rx.record,
          accepted(next, session, header, message, rx.seq),
          ...deviceStateWrite(updated, next, "routine"),
          ...decisions.value,
        ]);
        const surveyed = then(recorded, (s) => surveyStatus(s, entry.device, message, ctx));
        if (message.settingsVersion === next.config.version) return surveyed;
        return then(surveyed, (s) => {
          const current = s.gateways.get(entry.device) ?? next;
          return message.settingsVersion === current.config.version
            ? done(s)
            : sendSettings(s, current, session, ctx);
        });
      }),
  );
}

/** The gateway's own interference report (GW11, D82): a decision, written now (section 7). */
function onInterference(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  session: Session,
  header: PacketHeader,
  message: MessageOf<typeof MessageType.Interference>,
  ctx: Context,
): Outcome {
  return received(ctx, entry.device, message, header.counter, session.linkKind, "event").andThen(
    (rx) => {
      const recorded = [rx.record, accepted(entry, session, header, message, rx.seq)];
      const started = message.event === InterferenceEvent.Started;
      if (!started && message.event !== InterferenceEvent.Ended) return done(slice, recorded);
      const next: GatewayEntry = { ...entry, reportedInterference: started };
      return decision(ctx, {
        kind: started ? "interference_started" : "interference_ended",
        device: entry.device,
        cause: rx.seq,
        value: message.noiseDbm,
        detail: durationDetail(message.durationSeconds),
        durability: "now",
      }).andThen((made) => done(withGateway(slice, next), [...recorded, made]));
    },
  );
}

/** How long the interference has lasted, seconds, u16 LE, as the report gives it. */
function durationDetail(seconds: number): Uint8Array {
  const detail = new Uint8Array(2);
  new DataView(detail.buffer).setUint16(0, seconds, true);
  return detail;
}

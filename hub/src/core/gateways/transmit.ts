/**
 * Sending by radio (hub-design.md sections 4, 7 and 8; protocol.md §6, Transmit request and
 * result; §7, "Reply timing and a busy gateway"). Each `radioOut` from the sensors and sirens
 * modules becomes one transmit request through one gateway, with the moment, rate, power and
 * priority it asks for, and is tracked until exactly one `radioResult` goes back: the gateway's
 * result, "no result" when none came by the latest moment + 5 s ‡ (10 s ‡ with no limit) or its
 * session closed, or the shell's `sendFailed`.
 *
 * Two hub counters travel in each request: the device packet's, sealed by its module, and the
 * request's own on the gateway's key, taken here; the `send` lists both for the send gate.
 */
import { isEnumValue, MessageType, TransmitResultCode, TransmitWhen } from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { LinkErrorCode } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, LinkId } from "../model/ids.ts";
import type { DomainMessage, Internal } from "../model/messages.ts";
import { TxOutcome } from "../model/rows.ts";
import { type Mono, monoAfterMs } from "../model/time.ts";
import type { TimerKeyOf } from "../model/timers.ts";
import { clearTimer, done, type Outcome, setTimer, withGateway } from "./common.ts";
import { NO_LIMIT } from "./constants.ts";
import { toGateway, toHub } from "./clock.ts";
import { decision } from "./records.ts";
import { type Route, routeRadio } from "./routing.ts";
import { sealToGateway } from "./seal.ts";
import type { GatewayEntry, GatewaysSlice, Session, TransmitInFlight } from "./state.ts";

type RadioOut = Extract<DomainMessage, { readonly kind: "radioOut" }>;
interface TransmitResultMessage {
  readonly requestCounter: number;
  readonly result: number;
  readonly sentAtMicros: number;
}

/** A `radioResult` for one `radioOut`, with its transmit request's counter when one was sent. */
export function radioResult(
  out: {
    readonly ref: RadioOut["ref"];
    readonly device: DeviceId;
    readonly requestCounter?: number;
  },
  gateway: DeviceId | undefined,
  outcome: TxOutcome,
  sentGatewayMicros?: number,
  resultCounter?: number,
): Internal {
  return {
    kind: "radioResult",
    ref: out.ref,
    device: out.device,
    gateway,
    requestCounter: out.requestCounter,
    resultCounter,
    outcome,
    sentGatewayMicros,
  };
}

/**
 * Resolves the gateway's requests that `which` picks with `outcome`: each leaves the slice, its
 * timer is cleared, and its `radioResult` goes back.
 */
export function resolveRequests(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  which: (request: TransmitInFlight) => boolean,
  outcome: TxOutcome,
): {
  readonly slice: GatewaysSlice;
  readonly entry: GatewayEntry;
  readonly out: readonly Internal[];
} {
  const resolved = entry.requests.filter(which);
  if (resolved.length === 0) return { slice, entry, out: [] };
  const next: GatewayEntry = { ...entry, requests: entry.requests.filter((r) => !which(r)) };
  let timers = slice;
  for (const r of resolved) {
    timers = clearTimer(timers, {
      module: "gateways",
      kind: "transmitResult",
      gateway: entry.device,
      requestCounter: r.requestCounter,
    });
  }
  return {
    slice: withGateway(timers, next),
    entry: next,
    out: resolved.map((r) => radioResult(r, entry.device, outcome)),
  };
}

/** The request's gateway time fields and when its result is due on the hub's clock. */
interface Moment {
  readonly when: TransmitWhen;
  readonly gatewayTimeMicros: number;
  readonly deadline: Mono;
}

/** The moment of a request through `session` (section 7, "A busy gateway"; section 8). */
function moment(ctx: Context, out: RadioOut, session: Session, rerouted: boolean): Moment {
  const { gateways, replies } = ctx.deps.rules;
  const now = ctx.now.mono;
  const noLimit = monoAfterMs(now, gateways.resultNoLimitMs);
  if (out.timing.kind === "at") {
    const at = toHub(session.clock, out.timing.gatewayMicros, now);
    return {
      when: TransmitWhen.AtTime,
      gatewayTimeMicros: out.timing.gatewayMicros,
      deadline: at === undefined ? noLimit : monoAfterMs(at, gateways.resultGraceMs),
    };
  }
  const latest = out.timing.latest;
  if (latest === undefined) {
    return { when: TransmitWhen.AsSoonAsPossible, gatewayTimeMicros: NO_LIMIT, deadline: noLimit };
  }
  // An event reply through another gateway starts 20 ms ‡ before its latest moment (section 8).
  const limit = rerouted ? monoAfterMs(latest, -replies.otherGatewayMarginMs) : latest;
  const gatewayLimit = toGateway(session.clock, limit);
  // SPEC-QUESTION: a session with no forwarded packet yet has no clock mapping, so the latest
  // moment cannot be converted; the request then goes with no limit.
  return {
    when: TransmitWhen.AsSoonAsPossible,
    gatewayTimeMicros: gatewayLimit ?? NO_LIMIT,
    deadline: monoAfterMs(limit, gateways.resultGraceMs),
  };
}

/** The gateway a `radioOut` goes through, or why none (section 8). */
function route(slice: GatewaysSlice, out: RadioOut): Route {
  const first = out.timing.kind === "at" ? out.timing.gateway : out.gateway;
  return routeRadio(slice, first, out.purpose === "heartbeatReply" || out.timing.kind === "at");
}

/** One `radioOut`: a transmit request, a skipped reply, or `no_path` (section 8). */
export function handleRadioOut(slice: GatewaysSlice, out: RadioOut, ctx: Context): Outcome {
  const chosen = route(slice, out);
  if (chosen.kind === "skipped") {
    return done(slice, [radioResult(out, chosen.gateway, TxOutcome.NoResult)]);
  }
  if (chosen.kind === "noPath") {
    return decision(ctx, {
      kind: "no_path",
      device: out.device,
      cause: null,
      value: out.counter,
      detail: null,
      durability: "routine",
    }).andThen((record) => done(slice, [record, radioResult(out, undefined, TxOutcome.NoResult)]));
  }
  const { entry, rerouted } = chosen;
  const session = entry.live;
  if (session === undefined)
    return done(slice, [radioResult(out, entry.device, TxOutcome.NoResult)]);
  const at = moment(ctx, out, session, rerouted);
  return sealToGateway(
    ctx,
    entry,
    {
      type: MessageType.TransmitRequest,
      when: at.when,
      gatewayTimeMicros: at.gatewayTimeMicros,
      dataRate: out.dataRate,
      powerDbm: out.powerDbm,
      priority: out.priority,
      packet: out.packet,
    },
    session.binding,
    slice.keys,
  ).andThen((sealed) => {
    const request: TransmitInFlight = {
      ref: out.ref,
      device: out.device,
      requestCounter: sealed.counter,
      link: session.link,
      purpose: out.purpose,
      deadline: at.deadline,
    };
    const next: GatewayEntry = { ...sealed.entry, requests: [...sealed.entry.requests, request] };
    const send: Effect = {
      kind: "send",
      link: session.link,
      bytes: sealed.bytes,
      ref: out.ref,
      counters: [
        { device: entry.device, counter: sealed.counter },
        { device: out.device, counter: out.counter },
      ],
    };
    const timed = setTimer(withGateway(slice, next), {
      at: at.deadline,
      key: {
        module: "gateways",
        kind: "transmitResult",
        gateway: entry.device,
        requestCounter: sealed.counter,
      },
    });
    return done(timed, [...sealed.writes, send]);
  });
}

/** A gateway's result code as the `tx` outcome; a code this version does not list is "no result". */
export function outcomeOf(result: number): TxOutcome {
  return isEnumValue(TransmitResultCode, result) ? result : TxOutcome.NoResult;
}

/** A transmit result from the gateway (§6): the request's outcome goes back to its module. */
export function handleTransmitResult(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  result: TransmitResultMessage,
  resultCounter: number,
  late: () => Outcome,
): Outcome {
  const request = entry.requests.find((r) => r.requestCounter === result.requestCounter);
  // A result for a request already given up on (or never made) changes nothing, but is the
  // gateway's packet: `late` records it as a row of its own, so it can be found (D110).
  if (request === undefined) return late();
  const outcome = outcomeOf(result.result);
  const resolved = resolveRequests(slice, entry, (r) => r === request, outcome);
  const sentAt = outcome === TxOutcome.Sent ? result.sentAtMicros : undefined;
  // The outcome is recorded once, on the packet's `tx` row its module writes from this result
  // (section 6), kept as long as the packet it answers: no decision row of its own.
  return done(resolved.slice, [radioResult(request, entry.device, outcome, sentAt, resultCounter)]);
}

/** A request's time ran out with no result (section 7): "no result", handled as not sent. */
export function handleTransmitTimeout(
  slice: GatewaysSlice,
  key: Extract<TimerKeyOf<"gateways">, { readonly kind: "transmitResult" }>,
): Outcome {
  const entry = slice.gateways.get(key.gateway);
  if (entry === undefined) return done(clearTimer(slice, key));
  const resolved = resolveRequests(
    clearTimer(slice, key),
    entry,
    (r) => r.requestCounter === key.requestCounter,
    TxOutcome.NoResult,
  );
  return done(resolved.slice, resolved.out);
}

/** The shell did not send a request: held back by the send gate, or the link failed (section 4). */
export function handleSendFailed(
  slice: GatewaysSlice,
  link: LinkId,
  ref: RadioOut["ref"],
  error: LinkErrorCode,
): Outcome {
  for (const entry of slice.gateways.values()) {
    if (!entry.requests.some((r) => r.ref === ref && r.link === link)) continue;
    const outcome = error === "notDurable" ? TxOutcome.HeldBack : TxOutcome.SendFailed;
    const resolved = resolveRequests(
      slice,
      entry,
      (r) => r.ref === ref && r.link === link,
      outcome,
    );
    return done(resolved.slice, resolved.out);
  }
  return done(slice);
}

/**
 * The gateways module's small shared pieces (hub-design.md section 2, "Modules and the
 * dispatcher"): what a sub-handler returns, faults, timers, and replacing one gateway's entry.
 */
import { ok, type Result } from "neverthrow";
import type { Effect } from "../model/effects.ts";
import { type CoreFault, coreFault, type HubError } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { Internal } from "../model/messages.ts";
import type { TimerKeyOf, TimerOf } from "../model/timers.ts";
import { ORIGIN } from "./constants.ts";
import type { GatewayEntry, GatewaysSlice } from "./state.ts";

/** What every part of the handler returns: the new slice and what it emits, in order. */
export interface Done {
  readonly slice: GatewaysSlice;
  readonly out: readonly (Internal | Effect)[];
}

/** A part's result: what it did, or the fault that stops the step (section 10). */
export type Outcome = Result<Done, CoreFault>;

/** Done, with the slice and what it emits. */
export function done(slice: GatewaysSlice, out: readonly (Internal | Effect)[] = []): Outcome {
  return ok({ slice, out });
}

/** Runs `next` on `first`'s slice and joins their output, stopping at the first fault. */
export function then(first: Outcome, next: (slice: GatewaysSlice) => Outcome): Outcome {
  return first.andThen((a) =>
    next(a.slice).map((b) => ({ slice: b.slice, out: [...a.out, ...b.out] })),
  );
}

/** A fault of this module's own logic, for the input whose kind `ctx` names (section 10). */
export function fault(ctx: Context, message: string, detail?: HubError["detail"]): CoreFault {
  return coreFault(ctx.event, ORIGIN, message, detail);
}

/** A `HubError` from a port or the protocol package, as this step's fault. */
export function asFault(ctx: Context, error: HubError): CoreFault {
  return fault(ctx, error.message, { ...error.detail, kind: error.kind, from: error.origin });
}

/** The slice with one gateway's entry replaced. */
export function withGateway(slice: GatewaysSlice, entry: GatewayEntry): GatewaysSlice {
  const gateways = new Map(slice.gateways);
  gateways.set(entry.device, entry);
  return { ...slice, gateways };
}

type GatewayTimerKey = TimerKeyOf<"gateways">;

function sameKey(a: GatewayTimerKey, b: GatewayTimerKey): boolean {
  switch (a.kind) {
    case "offline":
      return b.kind === "offline" && a.gateway === b.gateway;
    case "unprovenSession":
      return b.kind === "unprovenSession" && a.link === b.link;
    case "transmitResult":
      return (
        b.kind === "transmitResult" &&
        a.gateway === b.gateway &&
        a.requestCounter === b.requestCounter
      );
  }
}

/** The slice with `timer` set, replacing a timer of the same key. */
export function setTimer(slice: GatewaysSlice, timer: TimerOf<"gateways">): GatewaysSlice {
  return { ...slice, timers: [...slice.timers.filter((t) => !sameKey(t.key, timer.key)), timer] };
}

/** The slice without the timer of this key. */
export function clearTimer(slice: GatewaysSlice, key: GatewayTimerKey): GatewaysSlice {
  const timers = slice.timers.filter((t) => !sameKey(t.key, key));
  return timers.length === slice.timers.length ? slice : { ...slice, timers };
}

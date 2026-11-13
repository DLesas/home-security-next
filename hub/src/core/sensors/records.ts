/**
 * Records and faults for intake, sensors, slots and site (hub-design.md sections 2, 5 and 10,
 * D110), through `sensors/view.ts`. Records are built by the core's one builder
 * (core/util/records.ts).
 */
import { err, ok, type Result } from "neverthrow";
import { type CoreFault, coreFault, type HubError } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { Internal } from "../model/messages.ts";
import type { Durability } from "../model/store.ts";
import type { Timer, TimerKey } from "../model/timers.ts";
import { type DecisionFields, decision } from "../util/records.ts";

export { recordMessage } from "../util/records.ts";

/** What a decision row says, besides its sequence number and time (section 6, `decisions`). */
export type { DecisionFields } from "../util/records.ts";

/** A decision record (section 6), by the core's one builder (core/util/records.ts). */
export function decisionMessage(
  ctx: Context,
  fields: DecisionFields,
  durability: Durability,
): Result<Internal, CoreFault> {
  return decision(ctx, durability, fields).map((decided) => decided.message);
}

/** A `HubError` from a pure helper as the `CoreFault` of this step (section 10). */
export function faultOf(ctx: Context, error: HubError): CoreFault {
  const base: CoreFault = {
    kind: "internal",
    origin: error.origin,
    message: error.message,
    event: ctx.event,
  };
  return error.detail === undefined ? base : { ...base, detail: error.detail };
}

/** `result` with its error turned into this step's `CoreFault`. */
export function orFault<T>(ctx: Context, result: Result<T, HubError>): Result<T, CoreFault> {
  return result.mapErr((error) => faultOf(ctx, error));
}

/** A fault of this module's own logic. */
export function fault(ctx: Context, origin: string, message: string): CoreFault {
  return coreFault(ctx.event, origin, message);
}

/** True when two timer keys name the same timer. */
function sameKey(a: TimerKey, b: TimerKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `timers` with the one under `key` set to `at` (added or moved). */
export function setTimer<K extends TimerKey>(
  timers: readonly Timer<K>[],
  key: K,
  at: Timer<K>["at"],
): readonly Timer<K>[] {
  return [...timers.filter((t) => !sameKey(t.key, key)), { at, key }];
}

/** `timers` without the one under `key`. */
export function clearTimer<K extends TimerKey>(
  timers: readonly Timer<K>[],
  key: K,
): readonly Timer<K>[] {
  return timers.filter((t) => !sameKey(t.key, key));
}

/**
 * Runs `step` over `items` in order, threading `state` and gathering what each emits; stops at
 * the first fault. The one fold every handler here uses for "for each sensor".
 */
export function foldOut<S, I, O>(
  items: readonly I[],
  state: S,
  step: (state: S, item: I) => Result<{ readonly state: S; readonly out: readonly O[] }, CoreFault>,
): Result<{ readonly state: S; readonly out: readonly O[] }, CoreFault> {
  let current = state;
  const out: O[] = [];
  for (const item of items) {
    const done = step(current, item);
    if (done.isErr()) return err(done.error);
    current = done.value.state;
    out.push(...done.value.out);
  }
  return ok({ state: current, out });
}

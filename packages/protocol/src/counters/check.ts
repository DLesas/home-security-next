import { isValidCounter } from "../packet/header.ts";

/** Why an authenticated packet's counter was not accepted. */
export type CounterRejection =
  /** This counter was already accepted. */
  | "duplicate"
  /** Older than the receiver can still accept. */
  | "tooOld";

/** The outcome of a receiving rule. On acceptance, `state` is what the caller must now keep. */
export type CounterCheck<State> =
  | { readonly accepted: true; readonly state: State }
  | { readonly accepted: false; readonly reason: CounterRejection };

export function accept<State>(state: State): CounterCheck<State> {
  return { accepted: true, state };
}

export function reject<State>(reason: CounterRejection): CounterCheck<State> {
  return { accepted: false, reason };
}

/** Counters reach these rules from a parsed header, which never yields 0; anything else is a bug. */
export function assertReceivedCounter(counter: number): void {
  if (!isValidCounter(counter)) throw new RangeError("counter must be from 1 to 0xFFFFFFFF");
}

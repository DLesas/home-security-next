/**
 * The gateway's clock onto the hub's (hub-design.md section 8, "Heartbeat slots"): each
 * session's offset is the smallest (hub time of the frame − unwrapped gateway time) of the last
 * 64 forwarded packets, which removes network delay; the 32-bit gateway clock, which wraps every
 * 71.6 minutes, is unwrapped against the hub's own clock through that offset.
 */
import { type Mono, mono } from "../model/time.ts";
import { GATEWAY_CLOCK_WRAP, LAST_GATEWAY_MICROS, NO_LIMIT } from "./constants.ts";
import type { ClockMapping } from "./state.ts";

/** A mapping with no samples yet. */
export const EMPTY_CLOCK: ClockMapping = { samples: [], offset: undefined };

/** The unwrapped time nearest `reference` whose low 32 bits are `wrapped`. */
export function unwrapNear(wrapped: number, reference: number): number {
  const half = GATEWAY_CLOCK_WRAP / 2;
  const low = ((reference % GATEWAY_CLOCK_WRAP) + GATEWAY_CLOCK_WRAP) % GATEWAY_CLOCK_WRAP;
  const difference =
    ((((wrapped - low) % GATEWAY_CLOCK_WRAP) + GATEWAY_CLOCK_WRAP + half) % GATEWAY_CLOCK_WRAP) -
    half;
  return reference + difference;
}

/**
 * The gateway's 32-bit time unwrapped: near the hub's `now` mapped back through the offset, or
 * as read before the first sample (which fixes the session's own epoch).
 */
export function unwrapGateway(clock: ClockMapping, wrapped: number, now: Mono): number {
  return clock.offset === undefined ? wrapped : unwrapNear(wrapped, now - clock.offset);
}

/** The mapping after a forwarded packet stamped `wrapped` arrived at hub time `now`. */
export function withSample(
  clock: ClockMapping,
  wrapped: number,
  now: Mono,
  keep: number,
): ClockMapping {
  const sample = now - unwrapGateway(clock, wrapped, now);
  const samples = [...clock.samples, sample].slice(-keep);
  return { samples, offset: Math.min(...samples) };
}

/** A gateway time on the hub's clock, or undefined before the session has a sample. */
export function toHub(clock: ClockMapping, wrapped: number, now: Mono): Mono | undefined {
  return clock.offset === undefined
    ? undefined
    : mono(unwrapGateway(clock, wrapped, now) + clock.offset);
}

/**
 * A hub time as the gateway's 32-bit time, or undefined before the session has a sample. It is
 * never `NO_LIMIT`, which a transmit request reads as "no limit" (§6): that one value goes one
 * microsecond earlier.
 */
export function toGateway(clock: ClockMapping, at: Mono): number | undefined {
  if (clock.offset === undefined) return undefined;
  const wrapped =
    ((Math.round(at - clock.offset) % GATEWAY_CLOCK_WRAP) + GATEWAY_CLOCK_WRAP) %
    GATEWAY_CLOCK_WRAP;
  return wrapped === NO_LIMIT ? LAST_GATEWAY_MICROS : wrapped;
}

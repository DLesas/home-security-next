/**
 * Seconds on the monotonic clock (hub-design.md section 2: every deadline is a `Mono`), as the
 * alarm's settings and the reply's fields count them (§6).
 */
import {
  MICROS_PER_MILLISECOND,
  MILLISECONDS_PER_SECOND,
  type Mono,
  monoAfterMs,
} from "../model/time.ts";

/** Microseconds in a second. */
export const MICROS_PER_SECOND = MICROS_PER_MILLISECOND * MILLISECONDS_PER_SECOND;

/** The instant `seconds` after `at` (before it, for a negative number). */
export function afterSeconds(at: Mono, seconds: number): Mono {
  return monoAfterMs(at, seconds * MILLISECONDS_PER_SECOND);
}

/** Whole seconds from `now` until `at`, rounded up, and 0 once it has passed. */
export function secondsUntil(now: Mono, at: Mono): number {
  return Math.max(0, Math.ceil((at - now) / MICROS_PER_SECOND));
}

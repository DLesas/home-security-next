/**
 * Time (hub-design.md section 2). Every deadline the core keeps is a `Mono`, so a wall clock
 * that jumps can never stretch or cut a countdown; wall time only stamps records.
 */

/** Microseconds on the monotonic clock since this boot; an integer below 2⁵³, good for 285 years. */
export type Mono = number & { readonly __brand: "Mono" };

/** The time an input was taken, from the `Clock` port (section 3). */
export interface Now {
  readonly mono: Mono;
  /** Milliseconds since 1970 as the system says, for records only. */
  readonly wall: number;
  /** False until the system clock is known to be set (section 5, "The clock"). */
  readonly wallTrusted: boolean;
}

export const MICROS_PER_MILLISECOND = 1000;
export const MILLISECONDS_PER_SECOND = 1000;

export function mono(micros: number): Mono {
  return micros as Mono;
}

/** The instant `ms` milliseconds after `at`, rounded to the microsecond. */
export function monoAfterMs(at: Mono, ms: number): Mono {
  return mono(at + Math.round(ms * MICROS_PER_MILLISECOND));
}

/** Milliseconds from `from` to `to`; negative when `to` is earlier. */
export function msBetween(from: Mono, to: Mono): number {
  return (to - from) / MICROS_PER_MILLISECOND;
}

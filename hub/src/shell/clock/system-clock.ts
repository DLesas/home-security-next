/**
 * The `Clock` port (hub-design.md sections 2, 3 and 5): the monotonic clock in microseconds
 * since this process started, the wall clock in milliseconds, and whether the wall clock can be
 * trusted, from `TimeTrust`. `mono` never goes back, which the core checks as well.
 */
import { type Mono, mono, type Now } from "../../core/model/time.ts";
import type { Clock, TimeTrust } from "../../ports/clock.ts";

const NANOS_PER_MICRO = 1000;

/** Microseconds of a source of nanoseconds that only grows, never going back. */
export class MonotonicMicros {
  readonly #nanos: () => number;
  #last = 0;

  /** `nanos`: Bun's monotonic nanoseconds since the process started, by default. */
  constructor(nanos: () => number = () => Bun.nanoseconds()) {
    this.#nanos = nanos;
  }

  now(): Mono {
    this.#last = Math.max(this.#last, Math.floor(this.#nanos() / NANOS_PER_MICRO));
    return mono(this.#last);
  }
}

export class SystemClock implements Clock {
  readonly #mono: MonotonicMicros;
  readonly #wall: () => number;
  readonly #trust: TimeTrust;

  constructor(
    trust: TimeTrust,
    monotonic = new MonotonicMicros(),
    wall: () => number = () => Date.now(),
  ) {
    this.#trust = trust;
    this.#mono = monotonic;
    this.#wall = wall;
  }

  now(): Now {
    return { mono: this.#mono.now(), wall: this.#wall(), wallTrusted: this.#trust.wallTrusted() };
  }
}

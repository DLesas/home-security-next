/**
 * The relay link's waits between attempts (docs/m4-design.md section 4, "Back-off"), from the
 * protocol's `RELAY_BACKOFF`: after a failure 1, 2, 4, 8, 16, 32 s, then every 60 s ‡, each ±20%
 * ‡; reset once a link has lasted 60 s ‡. After a close the relay meant as "wait" (4001, 4426,
 * 4429, `relayCloseReconnect`) the wait is fixed: `retryAfterMs` of the last `limit`, else 10
 * minutes ‡, with no jitter, and the steps start again afterwards.
 *
 * Pure: the jitter's draw is given (a number in [0, 1)), so a test names each step exactly.
 */
import { RELAY_BACKOFF, RELAY_CLOSE, RELAY_LIMITS } from "@hsn/protocol/relay";

/** The waits of a back-off, as the protocol gives them. */
export interface BackoffSteps {
  readonly stepsMs: readonly number[];
  readonly thenEveryMs: number;
  readonly jitter: number;
  readonly resetAfterMs: number;
}

export class Backoff {
  readonly #steps: BackoffSteps;
  #failures = 0;

  constructor(steps: BackoffSteps = RELAY_BACKOFF) {
    this.#steps = steps;
  }

  /** Failures since the last reset. */
  get failures(): number {
    return this.#failures;
  }

  /** A link lasted long enough, or the network changed: the next wait is the first step again. */
  reset(): void {
    this.#failures = 0;
  }

  /**
   * The wait before the next attempt, counting one more failure: the step for it, times
   * `1 + jitter × (2 × draw − 1)`, so a draw of 0.5 gives the step itself, 0 gives 80% of it and a
   * draw just under 1 just under 120%. A draw outside [0, 1) is taken as 0.5.
   */
  next(draw: number): number {
    const steps = this.#steps;
    const base = steps.stepsMs[this.#failures] ?? steps.thenEveryMs;
    this.#failures += 1;
    const r = Number.isFinite(draw) && draw >= 0 && draw < 1 ? draw : 0.5;
    return Math.round(base * (1 + steps.jitter * (2 * r - 1)));
  }

  /** Whether a link up for `upMs` has lasted long enough to reset the steps. */
  lasted(upMs: number): boolean {
    return upMs >= this.#steps.resetAfterMs;
  }
}

/**
 * The fixed wait after a close the relay meant as "wait": after `replaced` (4001) the 10 minutes
 * ‡ a hub whose identity another computer took waits; after a `limit` frame its `retryAfterMs`;
 * otherwise (4426, 4429 without a `limit`) 10 minutes ‡.
 */
export function waitAfterClose(code: number, limitRetryAfterMs: number | undefined): number {
  if (code === RELAY_CLOSE.replaced) return RELAY_LIMITS.identityInUseWaitMs;
  if (code === RELAY_CLOSE.overLimit && limitRetryAfterMs !== undefined) return limitRetryAfterMs;
  return RELAY_LIMITS.limitWaitMs;
}

/**
 * When the launcher starts the hub again (m2-design.md section 9, "Starts at boot"; "Step 1, wave
 * 2: questions settled"):
 *
 * - **0** is a clean stop: no restart.
 * - **70** is only the hub's request to be restarted (a restore's or an update's switch): restarted
 *   at once, and not a failure; but three 70s in a row ‡, each within a minute of its start, are
 *   a failure, so a request cannot loop either.
 * - **Every other code** (71 for a crash, a kill, 78 for a refused database) and a death by a
 *   signal is a failure. After a failure the next start waits 1 s, then 10 s, 30 s, then every 5
 *   minutes ‡ while the hub keeps failing within a minute of starting; a run of a minute resets
 *   the count. It never stops trying.
 */
import { LAUNCHER } from "../../src/shell/m2-values.ts";

/** Restart requests in a row, each within a minute of its start, that count as a failure ‡. */
export const QUICK_REQUESTS_FAILING = 3;

export interface BackoffRules {
  readonly restartDelaysMs: readonly number[];
  readonly failingWithinMs: number;
  readonly restartMeExitCode: number;
}

/** The hub's end: its exit code, or null when a signal ended it. */
export interface Ended {
  readonly code: number | null;
  /** How long it ran, on the launcher's monotonic clock. */
  readonly ranMs: number;
}

export type Next =
  | { readonly kind: "stop" }
  | {
      readonly kind: "restart";
      readonly afterMs: number;
      readonly failure: boolean;
      /** Failures in a row, this one included (0 for a request). */
      readonly failures: number;
    };

export class Backoff {
  readonly #rules: BackoffRules;
  #failures = 0;
  #quickRequests = 0;

  constructor(rules: BackoffRules = LAUNCHER) {
    this.#rules = rules;
  }

  get failures(): number {
    return this.#failures;
  }

  /** What to do after the hub ended. */
  after(ended: Ended): Next {
    if (ended.code === 0) return { kind: "stop" };
    const quick = ended.ranMs < this.#rules.failingWithinMs;
    if (!quick) {
      this.#failures = 0;
      this.#quickRequests = 0;
    }
    if (ended.code === this.#rules.restartMeExitCode) {
      this.#quickRequests = quick ? this.#quickRequests + 1 : 0;
      if (this.#quickRequests < QUICK_REQUESTS_FAILING)
        return { kind: "restart", afterMs: 0, failure: false, failures: this.#failures };
      this.#quickRequests = 0;
    } else {
      this.#quickRequests = 0;
    }
    this.#failures += 1;
    const delays = this.#rules.restartDelaysMs;
    const afterMs = delays[Math.min(this.#failures, delays.length) - 1] ?? 0;
    return { kind: "restart", afterMs, failure: true, failures: this.#failures };
  }
}

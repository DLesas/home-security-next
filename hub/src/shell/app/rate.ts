/**
 * Handshakes a second (m2-design.md section 5, "Limits on work"): at most 10 ‡ from one address
 * and 100 ‡ in all, counted over the last second and refused before any X25519 is computed. Only
 * handshakes let through are remembered, so what is kept is bounded by the overall limit, however
 * many addresses try: a flood costs this table nothing.
 */

export interface RateLimits {
  readonly perAddress: number;
  readonly overall: number;
  /** The window, 1 s. */
  readonly windowMs: number;
}

export class HandshakeRate {
  readonly #limits: RateLimits;
  /** When each admitted handshake started, oldest first, with its address. */
  #admitted: { readonly at: number; readonly address: string }[] = [];

  constructor(limits: RateLimits) {
    this.#limits = limits;
  }

  /** Whether a handshake from `address` may start at `nowMs`; if so, it is counted. */
  admit(address: string, nowMs: number): boolean {
    const since = nowMs - this.#limits.windowMs;
    this.#admitted = this.#admitted.filter((entry) => entry.at > since);
    if (this.#admitted.length >= this.#limits.overall) return false;
    const fromThere = this.#admitted.filter((entry) => entry.address === address).length;
    if (fromThere >= this.#limits.perAddress) return false;
    this.#admitted.push({ at: nowMs, address });
    return true;
  }

  /** Entries held, for the tests that check the table stays bounded. */
  get held(): number {
    return this.#admitted.length;
  }
}

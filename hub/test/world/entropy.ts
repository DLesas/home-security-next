/**
 * Seeded randomness for tests (hub-design.md section 11): the same seed gives the same bytes,
 * so every run of a scenario is repeatable. Not secure, and never used outside tests.
 */

/** A generator of pseudo-random bytes from a 32-bit seed (mulberry32). */
export class SeededBytes {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** The next 32-bit value. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** `length` bytes. */
  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 4) {
      const value = this.next();
      for (let j = 0; j < 4 && i + j < length; j++) out[i + j] = (value >>> (8 * j)) & 0xff;
    }
    return out;
  }
}

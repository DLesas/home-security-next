/**
 * The lockstep hub's random bytes (hub-design.md section 11): never the host's random source, so
 * one script gives the same bytes on every run. SHA-256 in counter mode over the 32-byte seed
 * `start` gives and the boot's number: block n is SHA-256(seed ‖ boot as 4 bytes ‖ n as 8 bytes,
 * both little-endian), and the bytes are the blocks in order, so each run of one seed has its own
 * stream. Only for the bench: it is as predictable as its seed.
 */
import { createHash } from "node:crypto";
import { ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { Random } from "../../ports/random.ts";

export class SeededRandom implements Random {
  readonly #seed: Uint8Array;
  #block = 0n;
  #pool: Uint8Array = new Uint8Array(0);

  constructor(seed: Uint8Array) {
    this.#seed = seed;
  }

  bytes(length: number): Result<Uint8Array, HubError & { readonly kind: "random" }> {
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (this.#pool.length === 0) this.#pool = this.#next();
      const take = Math.min(this.#pool.length, length - filled);
      out.set(this.#pool.subarray(0, take), filled);
      this.#pool = this.#pool.subarray(take);
      filled += take;
    }
    return ok(out);
  }

  #next(): Uint8Array {
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, this.#block, true);
    this.#block += 1n;
    return new Uint8Array(createHash("sha256").update(this.#seed).update(counter).digest());
  }
}

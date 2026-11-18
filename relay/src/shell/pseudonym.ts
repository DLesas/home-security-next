/**
 * The phone's pseudonym (docs/m4-design.md section 3, "The peer"): `relay-` and the first
 * `PSEUDONYM_RULES.bytes` bytes, in hex, of HMAC-SHA256 of the phone's address under a secret the
 * relay makes at start and replaces every `secretLifetimeMs`, never stored. The hub uses it as the
 * connection's address, so one flooding source is limited without the hub learning phones'
 * addresses.
 *
 * The address hashed is the one layer 1 counts by (an IPv4 address, or an IPv6 /64), so a phone
 * moving within its /64 keeps its pseudonym and a flood from one /64 is one source to the hub too.
 */
import type { Result } from "neverthrow";
import { PSEUDONYM_RULES } from "../core/rules.ts";
import type { RelayClock } from "./clock.ts";
import type { RelayError } from "./errors.ts";
import { hmacSha256, random } from "./safe/crypto.ts";

const SECRET_BYTES = 32;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Pseudonyms {
  private constructor(
    private secret: Uint8Array,
    private madeMs: number,
    private readonly clock: RelayClock,
    private readonly fresh: () => Result<Uint8Array, RelayError>,
  ) {}

  static start(
    clock: RelayClock,
    fresh: () => Result<Uint8Array, RelayError> = () => random(SECRET_BYTES),
  ): Result<Pseudonyms, RelayError> {
    return fresh().map((secret) => new Pseudonyms(secret, clock.now(), clock, fresh));
  }

  /** The pseudonym of `address` (an address key) now, replacing the secret when its day is up. */
  of(address: string): Result<string, RelayError> {
    const nowMs = this.clock.now();
    if (nowMs - this.madeMs >= PSEUDONYM_RULES.secretLifetimeMs) {
      const next = this.fresh();
      if (next.isOk()) {
        this.secret = next.value;
        this.madeMs = nowMs;
      }
    }
    return hmacSha256(this.secret, address).map(
      (mac) => `relay-${hex(mac.subarray(0, PSEUDONYM_RULES.bytes))}`,
    );
  }
}

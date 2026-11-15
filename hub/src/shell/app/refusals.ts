/**
 * Refused handshakes, for the core to record as `client_refused` (m2-design.md section 5;
 * section 11, "Step 1, wave 2: questions settled"): an unknown or removed key, a console client on
 * the home network's listener, no version both speak, a handshake not proven in time, a malformed
 * first message, or a peer past the limits. The shell sends at most one input per address per
 * minute, counting what it held back, and past 64 ‡ addresses in a minute the rest go as one, with
 * the address `"many"`: a flood of refusals costs the core and the disk a bounded amount.
 *
 * The input is `HubEvent`'s `clientRefused` (step 1, wave 2), built by `clientRefused`, the one
 * function the channel calls through; the reporter's `send` is the loop's `enqueue`.
 */
import type { ClientRefusalReason, HubEvent } from "../../core/model/events.ts";

/** Why a handshake was refused. */
export type RefusalReason = ClientRefusalReason;

/** The input. */
export type ClientRefused = Extract<HubEvent, { readonly kind: "clientRefused" }>;

/** The input for `count` refusals from `address` for `reason`. */
export function clientRefused(
  address: string,
  reason: RefusalReason,
  count: number,
): ClientRefused {
  return { kind: "clientRefused", address, reason, count };
}

/** The address of the input that stands for every address past the limit. */
export const MANY_ADDRESSES = "many";

export interface RefusalLimits {
  /** One input per address per window: a minute. */
  readonly windowMs: number;
  /** Addresses with an input of their own per window ‡. */
  readonly maxAddresses: number;
}

export const REFUSAL_LIMITS: RefusalLimits = { windowMs: 60_000, maxAddresses: 64 };

interface Held {
  readonly reason: RefusalReason;
  count: number;
}

/**
 * Counts refusals over a window that starts at the first: at its end, one input per address, the
 * reason being the first of that address's refusals in the window, then one for `"many"`.
 */
export class RefusalReporter {
  readonly #send: (input: ClientRefused) => void;
  readonly #limits: RefusalLimits;
  readonly #after: (ms: number, run: () => void) => () => void;
  readonly #held = new Map<string, Held>();
  #many: Held | undefined;
  #cancel: (() => void) | undefined;

  constructor(
    send: (input: ClientRefused) => void,
    after: (ms: number, run: () => void) => () => void,
    limits: RefusalLimits = REFUSAL_LIMITS,
  ) {
    this.#send = send;
    this.#after = after;
    this.#limits = limits;
  }

  /** One refused handshake. */
  refused(address: string, reason: RefusalReason): void {
    const held = this.#held.get(address);
    if (held !== undefined) held.count++;
    else if (this.#held.size < this.#limits.maxAddresses)
      this.#held.set(address, { reason, count: 1 });
    else if (this.#many !== undefined) this.#many.count++;
    else this.#many = { reason, count: 1 };
    this.#cancel ??= this.#after(this.#limits.windowMs, () => {
      this.flush();
    });
  }

  /** Sends what the window held, now (at its end, and when the hub stops). */
  flush(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    for (const [address, held] of this.#held)
      this.#send(clientRefused(address, held.reason, held.count));
    if (this.#many !== undefined) {
      this.#send(clientRefused(MANY_ADDRESSES, this.#many.reason, this.#many.count));
    }
    this.#held.clear();
    this.#many = undefined;
  }
}

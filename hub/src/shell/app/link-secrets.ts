/**
 * `LinkSecrets` in memory (m2-design.md section 5, "Linking"): the tokens the shell may accept,
 * by their lookup, as the core's `linkSecret` effects give and withdraw them. Step 0's
 * implementation of the port, for owner A2 to keep or replace. A restart starts empty: after one
 * the core gives every live token again (owner A3).
 */
import type { TokenId } from "../../core/model/ids.ts";
import type { AcceptedToken, LinkSecrets, TokenPurpose } from "../../ports/link-secrets.ts";

export class MemoryLinkSecrets implements LinkSecrets {
  readonly #byLookup = new Map<string, AcceptedToken>();
  readonly #lookupOf = new Map<TokenId, string>();

  find(lookup: string): AcceptedToken | undefined {
    return this.#byLookup.get(lookup);
  }

  apply(token: TokenId, purpose: TokenPurpose, lookup: string, psk: Uint8Array | null): void {
    const before = this.#lookupOf.get(token);
    if (before !== undefined) this.#byLookup.delete(before);
    this.#lookupOf.delete(token);
    if (psk === null) return;
    this.#byLookup.set(lookup, { token, purpose, psk: psk.slice() });
    this.#lookupOf.set(token, lookup);
  }
}

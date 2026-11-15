/**
 * `LinkSecrets` in memory (m2-design.md section 5, "Linking"): the tokens the shell may accept,
 * by their lookup, as the core's `linkSecret` effects give and withdraw them. A key is copied in
 * when given and overwritten with zeros when withdrawn or replaced; a handshake that already took
 * one holds its own copy (`setPsk` copies). A restart starts empty: after one the core gives every
 * live token again (owner A3). Nothing here is ever logged or put in an error.
 */
import type { TokenId } from "../../core/model/ids.ts";
import type { AcceptedToken, LinkSecrets, TokenPurpose } from "../../ports/link-secrets.ts";

export class MemoryLinkSecrets implements LinkSecrets {
  readonly #byLookup = new Map<string, AcceptedToken>();
  readonly #lookupOf = new Map<TokenId, string>();

  find(lookup: string): AcceptedToken | undefined {
    return this.#byLookup.get(lookup);
  }

  apply(
    token: TokenId,
    purpose: TokenPurpose,
    askName: boolean,
    lookup: string,
    psk: Uint8Array | null,
  ): void {
    const before = this.#lookupOf.get(token);
    if (before !== undefined) {
      this.#byLookup.get(before)?.psk.fill(0);
      this.#byLookup.delete(before);
    }
    this.#lookupOf.delete(token);
    if (psk === null) return;
    // A lookup another token held: that token is no longer findable, and its key is wiped.
    const other = this.#byLookup.get(lookup);
    if (other !== undefined) {
      other.psk.fill(0);
      this.#lookupOf.delete(other.token);
    }
    this.#byLookup.set(lookup, { token, purpose, askName, psk: psk.slice() });
    this.#lookupOf.set(token, lookup);
  }

  /** Tokens held, for tests. */
  get held(): number {
    return this.#byLookup.size;
  }
}

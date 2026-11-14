/**
 * Clients' static keys, as the handshake needs them (m2-design.md section 5, "Admitting a
 * session"): the shell looks a client's static key up after reading IK's message 1, before the
 * core sees anything. Loaded from `clients` at start, changed only by committed `StoreOp`s, as
 * `KeyStore` is. The keys are public; the port exists so the shell need not ask the core.
 */
import type { ClientId } from "../core/model/ids.ts";
import type { ClientKind } from "../core/model/rows.ts";
import type { StoreOp } from "../core/model/store.ts";

export interface ClientKeys {
  /** The linked, not removed client with this static key, or undefined: no message 2. */
  lookup(
    staticKey: Uint8Array,
  ): { readonly client: ClientId; readonly kind: ClientKind } | undefined;
  /** Applies the `clients` upserts and deletes of a commit, after it succeeded. */
  applyCommitted(ops: readonly StoreOp[]): void;
}

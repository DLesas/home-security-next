/**
 * `ClientKeys` in memory (m2-design.md section 5): every linked, not removed client's static key,
 * loaded from the snapshot's `clients` and kept by the commits that change them, as `KeyStore` is
 * for device keys. Step 0's implementation of the port, for owner A2 to keep or replace.
 */
import { toHex } from "@hsn/protocol";
import type { ClientId } from "../../core/model/ids.ts";
import type { ClientKind, ClientRow } from "../../core/model/rows.ts";
import type { StoreOp } from "../../core/model/store.ts";
import type { ClientKeys } from "../../ports/client-keys.ts";

export class MemoryClientKeys implements ClientKeys {
  readonly #byKey = new Map<string, { readonly client: ClientId; readonly kind: ClientKind }>();
  readonly #keyOf = new Map<ClientId, string>();
  /** Keys of clients removed (or deleted), so a refusal can say `removedKey` (section 5). */
  readonly #removed = new Set<string>();

  constructor(clients: readonly ClientRow[]) {
    for (const row of clients) this.#set(row);
  }

  lookup(
    staticKey: Uint8Array,
  ): { readonly client: ClientId; readonly kind: ClientKind } | undefined {
    return this.#byKey.get(toHex(staticKey));
  }

  /** Whether this static key was a client's that is now removed. */
  wasRemoved(staticKey: Uint8Array): boolean {
    return this.#removed.has(toHex(staticKey));
  }

  applyCommitted(ops: readonly StoreOp[]): void {
    for (const op of ops) {
      if (op.table !== "clients") continue;
      if (op.op === "upsert") this.#set(op.row);
      else this.#forget(op.key.id);
    }
  }

  #set(row: ClientRow): void {
    this.#forget(row.id);
    const key = toHex(row.staticKey);
    if (row.removedMs !== null) {
      this.#removed.add(key);
      return;
    }
    this.#removed.delete(key);
    this.#byKey.set(key, { client: row.id, kind: row.kind });
    this.#keyOf.set(row.id, key);
  }

  #forget(client: ClientId): void {
    const key = this.#keyOf.get(client);
    if (key !== undefined) {
      this.#byKey.delete(key);
      this.#removed.add(key);
    }
    this.#keyOf.delete(client);
  }
}

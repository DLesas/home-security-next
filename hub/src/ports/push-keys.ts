/**
 * The phones' push keys (docs/m4-design.md sections 4 and 5, D126), as `LinkSecrets` holds link
 * keys: loaded from `push_keys` at start, changed by the core's `pushKey` effect after the commit
 * that wrote the row, never in the core's slice. The shell seals each push and each roster's two
 * alerts with the client's key; the core never sees a key after `push.register` gave it.
 */
import type { ClientId } from "../core/model/ids.ts";

/** One phone's key for this hub: its key id (8 bytes, named in every `h`) and the key (32 bytes). */
export interface PushKey {
  readonly keyId: Uint8Array;
  readonly key: Uint8Array;
}

export interface PushKeys {
  /** The client's key, or undefined: nothing can be sealed for it. */
  key(client: ClientId): PushKey | undefined;
  /** A `pushKey` effect: the client's key from now, or none (null). */
  apply(client: ClientId, keyId: Uint8Array, key: Uint8Array | null): void;
}

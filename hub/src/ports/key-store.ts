/** Device keys, kept out of the core (hub-design.md sections 2 and 3). */
import type { DeviceId } from "../core/model/ids.ts";
import type { StoreOp } from "../core/model/store.ts";

/**
 * Each device's 16-byte key, in memory: loaded from `device_keys` at start, changed only by
 * committed `StoreOp`s that were written now. Never blocks. A missing key is an unknown device
 * to the core. The `DeviceCipher` is its only reader while the hub runs.
 */
export interface KeyStore {
  key(device: DeviceId): Uint8Array | undefined;
  /** Applies the `device_keys` upserts and deletes of a commit, after it succeeded. */
  applyCommitted(ops: readonly StoreOp[]): void;
}

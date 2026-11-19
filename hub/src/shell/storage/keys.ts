/**
 * The `KeyStore` (hub-design.md sections 2 and 3): each device's key in memory, and during a key
 * change after a restore its next key (D141, m3-updates-design section 7), loaded from
 * `device_keys` at start and changed only by committed `device_keys` writes, which the writer
 * hands over after each commit. The `DeviceCipher` is its only reader while the hub runs.
 *
 * One rule keeps the cipher's answer stable across a key change's commit: a committed whole-row
 * write whose key is the device's next key held here (the switch: `key = next_key`, `next_key`
 * null) keeps that key as the next key too, for the rest of this run. So a packet under the new key
 * opens as `"next"` before and after the switch's commit alike, and the core, which has switched the
 * device in the step that heard it, takes `"current"` from then on as the old key it no longer
 * accepts (`intake`). After a restart the row is read as it is: the key current, no next key.
 */
import type { Database } from "bun:sqlite";
import type { Result } from "neverthrow";
import { type DeviceId, deviceId } from "../../core/model/ids.ts";
import type { StoreOp } from "../../core/model/store.ts";
import type { KeyStore } from "../../ports/key-store.ts";
import type { StorageError } from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";

const ORIGIN = "shell/storage/keys";

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export class MemoryKeyStore implements KeyStore {
  readonly #keys: Map<DeviceId, Uint8Array>;
  readonly #next = new Map<DeviceId, Uint8Array>();

  /** `keys`: each device's key; `next`: the next key of each device that has one. */
  constructor(
    keys: ReadonlyMap<DeviceId, Uint8Array> = new Map(),
    next: ReadonlyMap<DeviceId, Uint8Array> = new Map(),
  ) {
    this.#keys = new Map(keys);
    for (const [device, key] of next) if (this.#keys.has(device)) this.#next.set(device, key);
  }

  /** Every key in `device_keys`, with each next key, read once at start, on the writer's connection. */
  static load(db: Database): Result<MemoryKeyStore, StorageError> {
    return sqlite(ORIGIN, "read the device keys", () =>
      db
        .query<{ id: number; key: Uint8Array; next: Uint8Array | null }, []>(
          `SELECT "device_id" AS id, "key" AS key, "next_key" AS next FROM "device_keys"`,
        )
        .all(),
    ).map((rows) => {
      const keys = new Map(rows.map((row) => [deviceId(row.id), new Uint8Array(row.key)]));
      const next = new Map<DeviceId, Uint8Array>();
      for (const row of rows) {
        if (row.next !== null) next.set(deviceId(row.id), new Uint8Array(row.next));
      }
      return new MemoryKeyStore(keys, next);
    });
  }

  key(device: DeviceId): Uint8Array | undefined {
    return this.#keys.get(device);
  }

  nextKey(device: DeviceId): Uint8Array | undefined {
    return this.#next.get(device);
  }

  applyCommitted(ops: readonly StoreOp[]): void {
    for (const op of ops) {
      if (op.table !== "device_keys") continue;
      switch (op.op) {
        case "upsert": {
          const { deviceId: device, key, nextKey } = op.row;
          const held = this.#next.get(device);
          this.#keys.set(device, key);
          if (nextKey !== null) this.#next.set(device, nextKey);
          // The switch keeps the new key as next for this run (above); any other row ends it.
          else if (held === undefined || !sameBytes(held, key)) this.#next.delete(device);
          break;
        }
        case "pendingKey":
          // Only a device with a row: the write changes nothing in the database otherwise.
          if (this.#keys.has(op.key.deviceId)) this.#next.set(op.key.deviceId, op.nextKey);
          break;
        case "delete":
          this.#keys.delete(op.key.deviceId);
          this.#next.delete(op.key.deviceId);
          break;
      }
    }
  }
}

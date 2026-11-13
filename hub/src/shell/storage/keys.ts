/**
 * The `KeyStore` (hub-design.md sections 2 and 3): each device's key in memory, loaded from
 * `device_keys` at start and changed only by committed `device_keys` writes, which the writer
 * hands over after each commit. The `DeviceCipher` is its only reader while the hub runs.
 */
import type { Database } from "bun:sqlite";
import type { Result } from "neverthrow";
import { type DeviceId, deviceId } from "../../core/model/ids.ts";
import type { StoreOp } from "../../core/model/store.ts";
import type { KeyStore } from "../../ports/key-store.ts";
import type { StorageError } from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";

const ORIGIN = "shell/storage/keys";

export class MemoryKeyStore implements KeyStore {
  readonly #keys: Map<DeviceId, Uint8Array>;

  constructor(keys: ReadonlyMap<DeviceId, Uint8Array> = new Map()) {
    this.#keys = new Map(keys);
  }

  /** Every key in `device_keys`, read once at start, on the writer's connection. */
  static load(db: Database): Result<MemoryKeyStore, StorageError> {
    return sqlite(ORIGIN, "read the device keys", () =>
      db
        .query<{ id: number; key: Uint8Array }, []>(
          `SELECT "device_id" AS id, "key" AS key FROM "device_keys"`,
        )
        .all(),
    ).map(
      (rows) =>
        new MemoryKeyStore(new Map(rows.map((row) => [deviceId(row.id), new Uint8Array(row.key)]))),
    );
  }

  key(device: DeviceId): Uint8Array | undefined {
    return this.#keys.get(device);
  }

  applyCommitted(ops: readonly StoreOp[]): void {
    for (const op of ops) {
      if (op.table !== "device_keys") continue;
      if (op.op === "upsert") this.#keys.set(op.row.deviceId, op.row.key);
      else this.#keys.delete(op.key.deviceId);
    }
  }
}

/**
 * `PushKeys` in memory (docs/m4-design.md sections 4 and 5, D126; `hub/src/ports/push-keys.ts`):
 * each phone's push key and its key id, loaded at start from `push_keys` with the key id of the
 * phone's row in `push_targets`, then changed only by the core's `pushKey` effect, which the loop
 * performs after the commit that wrote the row. A key is copied in when given and overwritten
 * with zeros when replaced or deleted. Nothing here is logged or put in an error.
 */
import type { Database } from "bun:sqlite";
import type { Result } from "neverthrow";
import { type ClientId, clientId } from "../../core/model/ids.ts";
import type { PushKey, PushKeys } from "../../ports/push-keys.ts";
import type { StorageError } from "../../ports/writer.ts";
import { sqlite } from "../safe/sqlite.ts";

const ORIGIN = "shell/relay/push-keys";
const KEY_BYTES = 32;
const KEY_ID_BYTES = 8;

export class MemoryPushKeys implements PushKeys {
  readonly #keys = new Map<ClientId, PushKey>();

  constructor(keys: Iterable<readonly [ClientId, PushKey]> = []) {
    for (const [client, key] of keys) this.apply(client, key.keyId, key.key);
  }

  /** Every phone's key with its target's key id, read once at start on the writer's connection. */
  static load(db: Database): Result<MemoryPushKeys, StorageError> {
    return sqlite(ORIGIN, "read the push keys", () =>
      db
        .query<{ client: number; key: Uint8Array; keyId: Uint8Array }, []>(
          `SELECT k."client_id" AS client, k."key" AS key, t."key_id" AS keyId
             FROM "push_keys" k JOIN "push_targets" t ON t."client_id" = k."client_id"`,
        )
        .all(),
    ).map(
      (rows) =>
        new MemoryPushKeys(
          rows.map((row) => [
            clientId(row.client),
            { keyId: new Uint8Array(row.keyId), key: new Uint8Array(row.key) },
          ]),
        ),
    );
  }

  key(client: ClientId): PushKey | undefined {
    return this.#keys.get(client);
  }

  apply(client: ClientId, keyId: Uint8Array, key: Uint8Array | null): void {
    this.#keys.get(client)?.key.fill(0);
    this.#keys.delete(client);
    if (key?.length !== KEY_BYTES || keyId.length !== KEY_ID_BYTES) return;
    this.#keys.set(client, { keyId: keyId.slice(), key: key.slice() });
  }

  /** Keys held, for tests. */
  get held(): number {
    return this.#keys.size;
  }
}

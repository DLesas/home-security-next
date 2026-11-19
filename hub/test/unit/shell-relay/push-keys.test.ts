/**
 * `PushKeys` in memory (docs/m4-design.md section 5; `hub/src/ports/push-keys.ts`): loaded at
 * start from `push_keys` with each phone's key id from `push_targets`, on the hub's real schema;
 * changed only by `pushKey`; a key replaced or deleted is overwritten with zeros.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientId } from "../../../src/core/model/ids.ts";
import { MemoryPushKeys } from "../../../src/shell/relay/push-keys.ts";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../../src/shell/safe/migrate.ts";
import { testKey } from "./support.ts";

const folders: string[] = [];
afterEach(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

const KEY = testKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const KEY_ID = Uint8Array.of(9, 8, 7, 6, 5, 4, 3, 2);

describe("loading", () => {
  test("each phone's key with its target's key id; a key with no target is not loaded", () => {
    const folder = mkdtempSync(join(tmpdir(), "hsn-push-keys-"));
    folders.push(folder);
    const db = new Database(join(folder, "hub.db"));
    expect(applyMigrations(db, join(import.meta.dir, "..", "..", "..", "drizzle")).isOk()).toBe(
      true,
    );
    db.run(
      `INSERT INTO push_targets (client_id, key_id, platform, environment, token, registered_ms)
       VALUES (5, ?, 1, 0, 'token', 1)`,
      [KEY_ID],
    );
    db.run("INSERT INTO push_keys (client_id, key) VALUES (5, ?)", [KEY]);
    db.run("INSERT INTO push_keys (client_id, key) VALUES (6, ?)", [KEY]);
    const keys = MemoryPushKeys.load(db)._unsafeUnwrap();
    db.close();
    expect(keys.held).toBe(1);
    expect(keys.key(clientId(5))).toEqual({ keyId: KEY_ID, key: KEY });
    expect(keys.key(clientId(6))).toBeUndefined();
  });
});

describe("pushKey", () => {
  test("a key given is copied; replaced, the old is zeroed; null deletes it, zeroed", () => {
    const keys = new MemoryPushKeys();
    const given = KEY.slice();
    keys.apply(clientId(5), KEY_ID, given);
    given.fill(7);
    const held = keys.key(clientId(5));
    expect(held?.key).toEqual(KEY);
    const second = testKey(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
    keys.apply(clientId(5), KEY_ID, second);
    expect(held?.key).toEqual(new Uint8Array(32));
    expect(keys.key(clientId(5))?.key).toEqual(second);
    const last = keys.key(clientId(5));
    keys.apply(clientId(5), KEY_ID, null);
    expect(keys.key(clientId(5))).toBeUndefined();
    expect(last?.key).toEqual(new Uint8Array(32));
  });

  test("a key or key id of the wrong length is not kept", () => {
    const keys = new MemoryPushKeys();
    keys.apply(clientId(5), KEY_ID, KEY.slice(0, 31));
    keys.apply(clientId(6), KEY_ID.slice(0, 7), KEY);
    expect(keys.held).toBe(0);
  });
});

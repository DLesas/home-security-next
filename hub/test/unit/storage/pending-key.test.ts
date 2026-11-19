/**
 * The writer's `pendingKey` op (D141, m3-updates-design section 7; the frozen change of
 * 2026-11-18): it writes `device_keys.next_key` and `rekey` of one device and nothing else, so the
 * core never names the current key; it is repeatable; for a device with no row it writes nothing;
 * in a batch it folds only into the same device's pending key, keeping its place among the
 * device's whole-row writes; and the `KeyStore` is told it after the commit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deviceId } from "../../../src/core/model/ids.ts";
import { Rekey } from "../../../src/core/model/rows.ts";
import type { StoreOp } from "../../../src/core/model/store.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { type OpenedStore, openStore } from "../../../src/shell/storage/store.ts";
import { deviceRow, MIGRATIONS, tempDir, TestClock, write } from "./fixtures.ts";

const D = deviceId(3);
const K0 = new Uint8Array(16).fill(0xa0);
const K1 = new Uint8Array(16).fill(0xa1);
const K2 = new Uint8Array(16).fill(0xa2);

let dir: ReturnType<typeof tempDir>;
let store: OpenedStore;
let told: StoreOp[];

beforeEach(() => {
  dir = tempDir("pending-key");
  told = [];
  store = openStore({
    dataDir: dir.path,
    migrationsFolder: MIGRATIONS,
    clock: new TestClock(),
    rules: DEFAULT_RULES,
    platform: process.platform,
    onCommitted: (ops) => told.push(...ops),
  })._unsafeUnwrap();
  store.writer.stage([
    write("now", { table: "devices", op: "upsert", row: deviceRow(3) }),
    write("now", {
      table: "device_keys",
      op: "upsert",
      row: { deviceId: D, key: K0, nextKey: null, rekey: Rekey.Required },
    }),
  ]);
  store.writer.flush("now")._unsafeUnwrap();
  told = [];
});
afterEach(() => {
  store.db.close();
  dir.remove();
});

function pending(device = D, nextKey = K1, rekey: Rekey = Rekey.Required): StoreOp {
  return { table: "device_keys", op: "pendingKey", key: { deviceId: device }, nextKey, rekey };
}

function rows() {
  return store.db
    .query<{ id: number; key: string; next: string | null; rekey: number }, []>(
      `SELECT device_id AS id, lower(hex(key)) AS key, CASE WHEN next_key IS NULL THEN NULL ELSE lower(hex(next_key)) END AS next, rekey FROM device_keys ORDER BY device_id`,
    )
    .all();
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("pendingKey", () => {
  test("alone: next_key and rekey written, the key untouched, the KeyStore told", () => {
    store.writer.stage([write("now", pending(D, K1, Rekey.Required))]);
    store.writer.flush("now")._unsafeUnwrap();
    expect(rows()).toEqual([{ id: 3, key: hex(K0), next: hex(K1), rekey: Rekey.Required }]);
    expect(told).toEqual([pending(D, K1, Rekey.Required)]);
  });

  test("applied twice, or committed twice after a failure: the same row", () => {
    store.writer.stage([write("now", pending()), write("now", pending())]);
    store.writer.flush("now")._unsafeUnwrap();
    store.writer.stage([write("now", pending())]);
    store.writer.flush("now")._unsafeUnwrap();
    expect(rows()).toEqual([{ id: 3, key: hex(K0), next: hex(K1), rekey: Rekey.Required }]);
  });

  test("for a device with no row: nothing written, nothing else harmed", () => {
    store.writer.stage([write("now", pending(deviceId(9)))]);
    expect(store.writer.flush("now").isOk()).toBe(true);
    expect(rows()).toEqual([{ id: 3, key: hex(K0), next: null, rekey: Rekey.Required }]);
  });

  test("with other ops: a whole row after it wins; it after a whole row sets only its columns", () => {
    // pending, then the switch's whole row: the switch's values stand.
    store.writer.stage([
      write("now", pending(D, K1)),
      write("now", {
        table: "device_keys",
        op: "upsert",
        row: { deviceId: D, key: K1, nextKey: null, rekey: Rekey.None },
      }),
      write("now", {
        table: "send_counters",
        op: "upsert",
        row: { deviceId: D, resumePoint: 1024 },
      }),
    ]);
    store.writer.flush("now")._unsafeUnwrap();
    expect(rows()).toEqual([{ id: 3, key: hex(K1), next: null, rekey: Rekey.None }]);
    // A whole row, then a pending key in the same batch: the pending key's two columns on top.
    store.writer.stage([
      write("now", {
        table: "device_keys",
        op: "upsert",
        row: { deviceId: D, key: K1, nextKey: null, rekey: Rekey.Required },
      }),
      write("now", pending(D, K2)),
    ]);
    store.writer.flush("now")._unsafeUnwrap();
    expect(rows()).toEqual([{ id: 3, key: hex(K1), next: hex(K2), rekey: Rekey.Required }]);
  });

  test("folding in a batch: pending, whole row, pending again lands as the last two in order", () => {
    store.writer.stage([
      write("routine", pending(D, K1)),
      write("routine", {
        table: "device_keys",
        op: "upsert",
        row: { deviceId: D, key: K0, nextKey: null, rekey: Rekey.BothHeld },
      }),
      write("routine", pending(D, K2)),
    ]);
    store.writer.flush("now")._unsafeUnwrap();
    // As if applied one by one: the whole row, then the last pending key.
    expect(rows()).toEqual([{ id: 3, key: hex(K0), next: hex(K2), rekey: Rekey.Required }]);
  });
});

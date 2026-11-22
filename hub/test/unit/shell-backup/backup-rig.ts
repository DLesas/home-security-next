/**
 * A hub's database for the backup worker's tests (`write-job.test.ts`, `backup-timing-child.ts`):
 * its app key, its backup state, and `people` people whose names are 1 KB each, so the
 * configuration a backup copies is about `people` KB (a home's is about 180 KB ‡).
 */
import { join } from "node:path";
import { BACKUP_STATE_DEFAULTS } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import { openStore, type OpenedStore } from "../../../src/shell/storage/store.ts";

export const WALL = Date.UTC(2026, 10, 21, 3, 0, 0);
export const KEY = new Uint8Array(32).fill(0x31);

/** The hub's database in `dataDir`, opened, with its configuration. */
export function backupHub(
  dataDir: string,
  people: number,
  migrationsFolder = join(import.meta.dir, "..", "..", "..", "drizzle"),
): OpenedStore {
  const store = openStore({
    dataDir,
    migrationsFolder,
    clock: { now: () => ({ mono: mono(1), wall: WALL, wallTrusted: true }) },
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  store.writer.stage([
    {
      kind: "write",
      durability: "now",
      op: {
        table: "hub_keys",
        op: "upsert",
        row: {
          signingPrivate: new Uint8Array(8),
          signingPublic: new Uint8Array(64),
          identity: new Uint8Array(8),
          appStaticPrivate: new Uint8Array(32),
          appStaticPublic: new Uint8Array(32).fill(0x0a),
          tlsPrivate: null,
          tlsCertificate: null,
        },
      },
    },
    {
      kind: "write",
      durability: "now",
      op: {
        table: "backup_state",
        op: "upsert",
        row: { ...BACKUP_STATE_DEFAULTS, lastChangeMs: WALL - 5000 },
      },
    },
  ]);
  store.writer.flush("now")._unsafeUnwrap();
  const name = "x".repeat(1000);
  store.db.transaction(() => {
    for (let i = 1; i <= people; i++)
      store.db.run("INSERT INTO people (id, name, created_ms, revision) VALUES (?, ?, ?, 1)", [
        i,
        `person ${i} ${name}`,
        WALL,
      ]);
  })();
  return store;
}

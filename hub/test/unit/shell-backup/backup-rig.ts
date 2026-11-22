/**
 * A hub's database for the backup and restore workers' tests (`write-job.test.ts`,
 * `restore-job.test.ts` and their timing children): its app key, its backup state, and `people`
 * people whose names are 1 KB each, so the configuration a backup copies is about `people` KB (a
 * home's is about 180 KB ‡); and a backup of it.
 */
import { join } from "node:path";
import { ok } from "neverthrow";
import { BACKUP_STATE_DEFAULTS } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import { BackupPieces } from "../../../src/shell/backup/write.ts";
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

/** A backup of `store` written into `folder` on this thread (`BackupPieces`): the file's path, or "" if none. */
export function backupFileOf(store: OpenedStore, dataDir: string, folder: string): string {
  const pieces = new BackupPieces(
    store.db,
    { folder, keep: 20, key: KEY, epoch: 1 },
    { nowMs: () => WALL, salt: () => ok(new Uint8Array(8).fill(9)) },
    dataDir,
  );
  for (;;) {
    const outcome = pieces.next();
    if (outcome !== undefined)
      return outcome.kind === "backupWritten" ? join(folder, outcome.name) : "";
  }
}

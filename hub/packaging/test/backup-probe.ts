/**
 * Compiled by `compiled-staging.test.ts` exactly as the hub's program is (`build-program.ts`'s
 * flags and `hubWorkers`): writes a backup of a hub's database made in `<dataDir>` into the folder
 * `<folder>` through the one worker entry, as the installed hub does, and prints the outcome as
 * JSON. `<migrations>`: the hub's `drizzle/`, which the executable does not carry.
 */
import { ok } from "neverthrow";
import { BackupJob } from "../../src/shell/backup/write-job.ts";
import { backupHub, KEY, WALL } from "../../test/unit/shell-backup/backup-rig.ts";

const [dataDir = "", folder = "", migrations = ""] = process.argv.slice(2);
const store = backupHub(dataDir, 20, migrations);
const job: BackupJob = new BackupJob(
  store.db,
  { folder, keep: 20, key: KEY, epoch: 1 },
  { nowMs: () => WALL, salt: () => ok(new Uint8Array(8).fill(9)) },
  dataDir,
  {
    wake: () => {
      const outcome = job.next();
      if (outcome === undefined) return;
      process.stdout.write(`${JSON.stringify({ main: Bun.main, outcome })}\n`);
      process.exit(0);
    },
  },
);
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ main: Bun.main, outcome: "no outcome in 20 s" })}\n`);
  process.exit(1);
}, 20_000);

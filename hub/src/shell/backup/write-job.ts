/**
 * A backup as the loop's job, with its file work on a worker thread (D145): a file job on its
 * worker (`shell/worker/job.ts`, which says what the loop and the worker each do, a stop and a
 * worker that fails; the worker's side is `write-serve.ts`). What is the backup's own:
 *
 * - **The split.** On the loop, as the job starts: what the backup needs of `hub.db` and the
 *   clock (`readBackup`: the header's facts, the configuration copied and serialised in memory,
 *   about 200 KB ‡, the salt, the time), read in the same turn as before. On the worker:
 *   everything that touches the folder: its check, the sealing, each piece's write and sync, the
 *   last sync and close, the rename, the folder's sync, and the pruning. So the file and its name
 *   are on the disk before the loop is told, and the commit that records the backup waits for
 *   none of them.
 * - **No gate, no cancel.** The core runs one backup at a time and never withdraws one; each
 *   backup's temporary file is its own (`.<name>.tmp`, its name the time to the millisecond).
 * - **What a failed or given-up worker leaves:** its temporary file, removed off the loop. A stop
 *   that waits out its bound leaves it in the folder, where it is neither this hub's backup (the
 *   pruning reads only `hsn-*.hsnb`) nor readable (sealed).
 * - **An exit before the outcome** (never seen, `safe/job-thread.ts`) after the rename leaves a
 *   whole backup file with no record of it, and the job failed `io`. It is harmless: it is a good
 *   backup, sealed under the key, a restore can use it, and the next backup's pruning counts it as
 *   any of this hub's files (kept among the newest `keep`, or removed). The core sees a failed
 *   backup and tries again as after any failure.
 */
import type { Database } from "bun:sqlite";
import { WorkerJob, type WorkerJobOptions } from "../worker/job.ts";
import type { KindData } from "../worker/kinds.ts";
import { type BackupWork, backupTemporary, readBackup, type WriteDeps } from "./write.ts";

/** One backup being written on the worker thread, as the loop's job in pieces. */
export class BackupJob extends WorkerJob<KindData<"writeBackup">> {
  constructor(
    db: Database,
    work: BackupWork,
    deps: WriteDeps,
    dataDir: string | undefined,
    options: WorkerJobOptions<KindData<"writeBackup">> = {},
  ) {
    // Read here, on the loop: the worker never opens `hub.db`.
    const read = readBackup(db, work.epoch, deps);
    const temporary = backupTemporary(work.folder, read);
    super(
      {
        name: "backup",
        gate: undefined,
        data: { kind: "writeBackup", read, work, dataDir },
        leftovers: () => (temporary === undefined ? undefined : Promise.resolve([temporary])),
        placed: () => [],
      },
      options,
    );
  }
}

/**
 * Applying a restore as the loop's job, with the candidate database built on a worker thread
 * (D145): a file job on its worker (`shell/worker/job.ts`, which says what the loop and the worker
 * each do, a stop and a worker that fails; the worker's side is `restore-serve.ts`). What is the
 * restore's own:
 *
 * - **The split.** Nothing of `hub.db` is read for the build: the worker is given the upload, the
 *   phone's key, the data folder, the migrations and the rules, and does all of it, the scratch
 *   plaintext, the candidate's every commit (each synced), its close, its rename to
 *   `hub.db.restore` and the folder's sync. So the candidate is whole on the disk before the loop
 *   is told `restoreReady`. The swap itself (`swapRestored`) is not here: it stays the switch's,
 *   after the loop has stopped and `hub.db` is closed (`jobs.ts`, `switchRestore`).
 * - **One at a time** (its gate): every restore builds the same scratch files, beside `hub.db`.
 *   The core runs one restore at a time and never withdraws one; the gate holds a second's worker
 *   until the first's thread is gone.
 * - **What a failed or given-up worker leaves** (`restoreFiles`): its scratch files, and
 *   `hub.db.restore` too, removed off the loop. This one matters: the next start puts any
 *   `hub.db.restore` in place (`retryWaitingRestore`), so a worker that exits before its outcome
 *   (never seen, `safe/job-thread.ts`) but after its rename would otherwise leave the hub to
 *   switch, at its next start, to a restore the phone was told had failed. A stop that waits out
 *   its bound leaves the scratch files to the next restore, which removes them before it writes
 *   (`RestorePieces`, its first piece and its build), and a `hub.db.restore.new` is never put in
 *   place.
 * - **A stop after the outcome came, before the loop took it** leaves `hub.db.restore` whole, and
 *   the next start puts it in place: the same as a power cut between the rename and the core's
 *   step, which the design already takes as a restore waiting (m2-design.md section 9, "A swap
 *   that did not happen"). The phone held the key and the restore was ready; only its answer was
 *   not sent.
 */
import { WorkerJob, type WorkerJobOptions } from "../worker/job.ts";
import type { KindData } from "../worker/kinds.ts";
import { type RestoreInputs, restoreFiles } from "./restore.ts";

/** The restore's gate: its jobs one at a time. */
const GATE = "applyRestore";

/** One restore's candidate database being built on the worker thread, as the loop's job in pieces. */
export class RestoreJob extends WorkerJob<KindData<"applyRestore">> {
  constructor(inputs: RestoreInputs, options: WorkerJobOptions<KindData<"applyRestore">> = {}) {
    super(
      {
        name: "restore",
        gate: GATE,
        data: { kind: "applyRestore", inputs },
        leftovers: () => Promise.resolve(restoreFiles(inputs.dataDir)),
        placed: () => [],
      },
      options,
    );
  }
}

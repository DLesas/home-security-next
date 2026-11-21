/**
 * Staging a firmware image as the loop's job, with the staging itself on a worker thread (D145): a
 * file job on its worker (`shell/worker/job.ts`, which says what the loop and the worker each do, a
 * stop and a worker that fails; the worker's side is `stage-serve.ts`). What is firmware
 * staging's own:
 *
 * - **The split.** On the loop: the hub's signing key's columns read from `hub.db` as the job
 *   starts (the one thing staging needs of the database: read only, nothing derived), and the
 *   outcome taken. On the worker: everything else, the signer made of those columns, both passes
 *   over the upload, the temporary file's writes, its sync and close, the rename and the folder's
 *   sync. So the image's file and the folder are on the disk before the loop is told, and the
 *   commit that records the image's row waits for none of them.
 * - **No gate.** Each job has its own temporary file, `.staging-<job>`, so firmware stagings run
 *   beside each other, as they did a piece each a turn on the loop.
 * - **No cancel.** The core never withdraws a firmware staging: a stop is the only end but the
 *   outcome.
 * - **What a failed or given-up worker leaves:** its `.staging-<job>`, removed off the loop. A
 *   stop that waits out its bound leaves it to the store's check at the next start, which deletes
 *   every temporary file (`store.ts`, `checkStore`).
 * - **An exit before the outcome** (never seen, `safe/job-thread.ts`) after the rename leaves the
 *   image's file, `<sha256>.bin`, with no row and the job failed `io`. It holds exactly the
 *   checked bytes, and nothing names it, so no device is ever offered it; staging the same image
 *   again replaces it with the same bytes; the store's check at the next start deletes it. Until
 *   then it counts in the shell's own guard on the store's room (`stage.ts`, after pass 1), so a
 *   staging of another image could be refused `storeFull` when the core's index has room: that is
 *   the cost, until the next start, and the owner sees the refusal.
 */
import { WorkerJob, type WorkerJobOptions } from "../worker/job.ts";
import type { Result } from "neverthrow";
import type { KeysRead, KindData } from "../worker/kinds.ts";
import type { SigningKeys } from "./sign.ts";
import { type FirmwareStageInputs, stagingFile } from "./stage.ts";

/** A firmware staging's inputs as the loop gives them: the key's columns read, not a signer. */
export type FirmwareJobInputs = Omit<FirmwareStageInputs, "signer"> & {
  /** The hub's signing key's columns, read from `hub.db` (`sign.ts`, `hubSigningKeys`). */
  readonly signingKeys: () => Result<SigningKeys, string>;
};

/** One firmware image being staged on the worker thread, as the loop's job in pieces. */
export class FirmwareStagingJob extends WorkerJob<KindData<"stageFirmware">> {
  constructor(
    inputs: FirmwareJobInputs,
    options: WorkerJobOptions<KindData<"stageFirmware">> = {},
  ) {
    // The key's columns read here, on the loop: the worker never opens `hub.db`.
    const { signingKeys, ...rest } = inputs;
    const keys = signingKeys();
    const read: KeysRead = keys.isOk() ? { keys: keys.value } : { error: keys.error };
    super(
      {
        name: "firmware staging",
        gate: undefined,
        data: { kind: "stageFirmware", inputs: rest, signingKeys: read },
        leftovers: () => Promise.resolve([stagingFile(inputs.dataDir, inputs.job)]),
        placed: () => [],
      },
      options,
    );
  }
}

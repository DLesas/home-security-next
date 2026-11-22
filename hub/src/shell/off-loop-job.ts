/**
 * A file job whose work is a few calls off the hub's thread, with no worker (D145, design P): the
 * calls through `node:fs/promises` (`safe/off-loop.ts`), which Bun runs on its own pool. One class
 * for every such job: a firmware image's removal (`firmware/remove-job.ts`) and a restore's header
 * read (`backup/jobs.ts`, `readRestore`).
 *
 * - **Waiting.** Until the work has settled the job says it is waiting, so the loop asks no turn
 *   for it; the work's end asks for one (`wake`). Without a wake the job never says it waits, and
 *   the loop turns for it as for any job.
 * - **The outcome on the loop's own turn**: `next()` gives it on the turn after the wake, so the
 *   core sees one order of events.
 * - **A stop does not wait**: a call cannot be called back. The job ends with the stop's failure
 *   whatever had come, and nothing wakes the loop after it; what the work leaves is its kind's
 *   (a removal's file, unnamed, goes at the next start's check).
 */
import type { FileOutcome } from "../core/model/events.ts";

export class OffLoopJob {
  readonly #wake: (() => void) | undefined;
  #outcome: FileOutcome | undefined;
  #taken: FileOutcome | undefined;

  /** `work` must settle with an outcome, never reject. */
  constructor(work: () => Promise<FileOutcome>, wake?: () => void) {
    this.#wake = wake;
    void work().then((outcome) => {
      this.#outcome = outcome;
      if (this.#taken === undefined && wake !== undefined) queueMicrotask(wake);
    });
  }

  /** Nothing for the loop to do until the work has settled, which asks a turn itself. */
  waiting(): boolean {
    return this.#taken === undefined && this.#wake !== undefined && this.#outcome === undefined;
  }

  next(): FileOutcome | undefined {
    if (this.#taken !== undefined) return this.#taken;
    if (this.#outcome !== undefined) this.#taken = this.#outcome;
    return this.#taken;
  }

  abort(message: string): FileOutcome {
    this.#taken ??= { kind: "failed", reason: "io", message };
    return this.#taken;
  }
}

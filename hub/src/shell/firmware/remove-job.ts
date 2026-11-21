/**
 * `removeFirmware`'s file work off the hub's thread (D145): an image's file removed, then the
 * store's folder synced, by `node:fs/promises` on libuv's pool, so the loop never waits in the
 * unlink (one took 358 ms on a hosted Linux runner, on the loop). No worker: a removal is two
 * calls, nothing in pieces.
 *
 * - **The index's guard is the loop's, at once.** Whether an image in the index names the file is
 *   asked by `firmwareJob` when the job starts, in the same turn and on the same committed index
 *   as when the removal was done at once (`store.ts`, `StillIndexed`); a file the index names is
 *   never given to this job. Only a file no live row names is removed here.
 * - **The outcome on the loop's own turn.** When both calls have settled the job wakes the loop,
 *   and `next()` gives `firmwareRemoved`, or the failure, on that turn, as a worker's job does.
 * - **A stop** does not wait: the unlink cannot be called back. The job ends failed `io` for the
 *   core's sake (it gets no outcome at a stop), and the file is gone or still there; if still
 *   there, no live row names it, and the store's check at the next start deletes it.
 * - **A staging of the same image** running on its worker while this removal is in flight could
 *   rename its file onto the name being removed before the unlink happens. That window is not new:
 *   it was there at once too (the staging's rename and its outcome are not one step), and with
 *   staging's pieces on the loop it was a turn wide. The store's check at the next start then
 *   reports that image damaged (`firmwareStoreDamaged`), and it is added again.
 */
import type { FileOutcome } from "../../core/model/events.ts";
import type { ImageId } from "../../core/model/ids.ts";
import { removeFileOffLoop, syncFolderOffLoop } from "../safe/firmware-io.ts";

/** One image's file being removed off the loop, as the loop's job in pieces. */
export class FileRemoval {
  readonly #wake: (() => void) | undefined;
  #outcome: FileOutcome | undefined;
  #taken: FileOutcome | undefined;

  constructor(path: string, folder: string, image: ImageId, wake?: () => void) {
    this.#wake = wake;
    void removeFileOffLoop(path)
      .then((removed) => (removed.isErr() ? removed : syncFolderOffLoop(folder)))
      .then((done) => {
        this.#outcome = done.isOk()
          ? { kind: "firmwareRemoved", image }
          : { kind: "failed", reason: done.error.reason, message: done.error.message };
        if (this.#taken === undefined && wake !== undefined) queueMicrotask(wake);
      });
  }

  /** Nothing for the loop to do until the calls have settled, which ask a turn themselves. */
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

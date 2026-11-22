/**
 * `removeFirmware`'s file work off the hub's thread (D145): an image's file removed, then the
 * store's folder synced, by `node:fs/promises` on Bun's pool (`safe/off-loop.test.ts`), so the loop never waits in the
 * unlink (one took 358 ms on a hosted Linux runner, on the loop). No worker: a removal is two
 * calls, nothing in pieces.
 *
 * - **The index's guard is the loop's, at once.** Whether an image in the index names the file is
 *   asked by `firmwareJob` when the job starts, in the same turn and on the same committed index
 *   as when the removal was done at once (`store.ts`, `StillIndexed`); a file the index names is
 *   never given to this job. Only a file no live row names is removed here.
 * - **The outcome on the loop's own turn, and a stop that does not wait**: the shared off-loop job's
 *   (`off-loop-job.ts`). At a stop the file is gone or still there; if still there, no live row
 *   names it, and the store's check at the next start deletes it.
 * - **A staging of the same image** running on its worker while this removal is in flight could
 *   rename its file onto the name being removed before the unlink happens. That window is not new:
 *   it was there at once too (the staging's rename and its outcome are not one step), and with
 *   staging's pieces on the loop it was a turn wide. A known limit: while the hub runs, a device
 *   granted that image is answered Gone and the core is told nothing; a new link or a restart
 *   repairs it (`shell-firmware/serve.test.ts`), and the next start's check reports the image
 *   damaged (`firmwareStoreDamaged`).
 */
import type { ImageId } from "../../core/model/ids.ts";
import { OffLoopJob } from "../off-loop-job.ts";
import { removeFileOffLoop, syncFolderOffLoop } from "../safe/firmware-io.ts";

/** One image's file being removed off the loop: the shared off-loop job (`off-loop-job.ts`). */
export class FileRemoval extends OffLoopJob {
  constructor(path: string, folder: string, image: ImageId, wake?: () => void) {
    super(async () => {
      const removed = await removeFileOffLoop(path);
      const done = removed.isErr() ? removed : await syncFolderOffLoop(folder);
      return done.isOk()
        ? { kind: "firmwareRemoved", image }
        : { kind: "failed", reason: done.error.reason, message: done.error.message };
    }, wake);
  }
}

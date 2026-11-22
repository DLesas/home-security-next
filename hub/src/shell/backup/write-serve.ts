/**
 * A backup's worker side (D145; the loop's side is `write-job.ts`): the backup's file work by
 * `BackupFile` (`write.ts`), unchanged, a bounded piece after another on the worker's own thread:
 * the folder checked, the configuration the loop read sealed into a temporary file, written and
 * synced a piece at a time, synced and closed, renamed, the folder synced, then pruned. Before
 * every piece the worker looks at the loop's word: a stop ends it through `BackupFile.abort`,
 * which removes the temporary file. The core never cancels a backup, so no cancel comes. It never
 * touches `hub.db`; the backup key is in its data, copied into this thread, and nowhere else.
 */
import type { KindData, WorkerData } from "../worker/kinds.ts";
import { serveJob, type WorkerReply } from "../worker/serve.ts";
import { BackupFile } from "./write.ts";

/** Writes the backup to its end on this thread, then marks the control word and posts the outcome. */
export function serveBackup(
  port: { postMessage(reply: WorkerReply): void },
  data: WorkerData<KindData<"writeBackup">>,
): void {
  serveJob(port, data.control, new BackupFile(data.read, data.work, data.dataDir));
}

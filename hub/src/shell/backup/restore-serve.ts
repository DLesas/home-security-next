/**
 * A restore's worker side (D145; the loop's side is `restore-job.ts`): the candidate database
 * built by `RestorePieces` (`restore.ts`), unchanged, a bounded piece after another on the worker's
 * own thread: the upload opened with the phone's key into a scratch file, the restored database
 * made beside `hub.db` as `hub.db.restore.new`, its rows copied, marked and migrated, each piece a
 * synced commit of its own, then closed, renamed `hub.db.restore` and the folder synced. Before
 * every piece the worker looks at the loop's word: a stop ends it through `RestorePieces.abort`,
 * which removes what it made. The core never cancels a restore, so no cancel comes. It never
 * opens `hub.db`; the phone's key is in its data, copied into this thread, and nowhere else.
 */
import type { KindData, WorkerData } from "../worker/kinds.ts";
import { serveJob, type WorkerReply } from "../worker/serve.ts";
import { RestorePieces } from "./restore.ts";

/** Builds the restored database to its end on this thread, then marks the control word and posts the outcome. */
export function serveRestore(
  port: { postMessage(reply: WorkerReply): void },
  data: WorkerData<KindData<"applyRestore">>,
): void {
  serveJob(port, data.control, new RestorePieces(data.inputs));
}

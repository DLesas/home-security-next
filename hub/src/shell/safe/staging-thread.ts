/**
 * The staging worker's thread (`shell/update/stage-worker.ts`), started and watched: its outcome,
 * or why it gave none (it did not start, threw, or exited first), each told once, and its exit.
 * Starting a worker can throw (a path Bun refuses), so this lives here (HD 10).
 */
import { Worker } from "node:worker_threads";
import { err, ok, type Result } from "neverthrow";
import type { FileOutcome } from "../../core/model/events.ts";
import type { StagingReply, StagingWorkerData } from "../update/stage-serve.ts";

/**
 * In the installed program, Bun finds an embedded worker by its source path below the compile
 * root (`hub/`; Bun 1.4.2): its executables run from `B:\~BUN\root\` on Windows and
 * `/$bunfs/root/` elsewhere. From source, the file beside.
 */
function stagingEntry(): string | URL {
  return /(?:^|[\\/])(?:~BUN|\$bunfs)[\\/]/u.test(Bun.main)
    ? "./src/shell/update/stage-worker.ts"
    : new URL("../update/stage-worker.ts", import.meta.url);
}

export interface StagingThreadEvents {
  /** The worker ended staging: its outcome. */
  readonly ended: (outcome: FileOutcome) => void;
  /** The worker ended without an outcome: why, in a few words. */
  readonly failed: (why: string) => void;
  /** The thread is gone, after `ended` or `failed`. */
  readonly exited: () => void;
}

function described(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** Starts staging on a worker thread; why not, if it could not even be started. */
export function startStagingThread(
  data: StagingWorkerData,
  events: StagingThreadEvents,
  entry: string | URL = stagingEntry(),
): Result<void, string> {
  let worker: Worker;
  try {
    worker = new Worker(entry, { workerData: data });
  } catch (thrown) {
    return err(described(thrown));
  }
  let told = false;
  const tell = (event: () => void): void => {
    if (told) return;
    told = true;
    event();
  };
  // The worker posts one message, `ended`, and only once staging has ended.
  worker.on("message", (reply: StagingReply) => {
    tell(() => {
      events.ended(reply.outcome);
    });
  });
  worker.on("error", (error) => {
    tell(() => {
      events.failed(described(error));
    });
  });
  worker.on("messageerror", (error) => {
    tell(() => {
      events.failed(described(error));
    });
  });
  worker.once("exit", (code) => {
    tell(() => {
      events.failed(`it stopped first (exit code ${code})`);
    });
    events.exited();
  });
  // Never terminated from here: a thread in a file call could not be ended before the call
  // returns, and once it does, it sees a cancel or a stop and removes its own folder. The hub's
  // exit ends it, wherever it is.
  return ok(undefined);
}

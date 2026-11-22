/**
 * A file job's worker thread (D145; the one entry, `shell/worker/entry.ts`), started and watched:
 * its outcome, or why it gave none (it did not start, threw, or exited first), each told once, and
 * its exit. Starting a worker can throw (a path Bun refuses), so this lives here (HD 10).
 */
import { Worker } from "node:worker_threads";
import { err, ok, type Result } from "neverthrow";
import type { FileOutcome } from "../../core/model/events.ts";
import type { JobKindData, WorkerData } from "../worker/kinds.ts";
import type { WorkerReply } from "../worker/serve.ts";

/**
 * In the installed program, Bun finds an embedded worker by its source path below the compile
 * root (`hub/`; Bun 1.4.2): its executables run from `B:\~BUN\root\` on Windows and
 * `/$bunfs/root/` elsewhere. From source, the file beside.
 */
export function jobEntry(): string | URL {
  return /(?:^|[\\/])(?:~BUN|\$bunfs)[\\/]/u.test(Bun.main)
    ? "./src/shell/worker/entry.ts"
    : new URL("../worker/entry.ts", import.meta.url);
}

export interface JobThreadEvents {
  /** The worker ended its job: the outcome. */
  readonly ended: (outcome: FileOutcome) => void;
  /** The worker ended without an outcome: why, in a few words. */
  readonly failed: (why: string) => void;
  /** The thread is gone, after `ended` or `failed`. */
  readonly exited: () => void;
}

function described(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Every byte array of 16 bytes or more in a worker's data: a key's (a firmware staging's signing
 * key, a backup's or a restore's key) or a public key's. None may reach a message, a record or an
 * error's text, and a worker's thrown error is passed on as the worker wrote it (Bun's `error`
 * event carries its message), so the text is scrubbed of them first.
 */
function bytesIn(value: unknown, found: Uint8Array[] = []): Uint8Array[] {
  if (value instanceof Uint8Array) {
    if (value.length >= 16) found.push(value);
  } else if (Array.isArray(value)) for (const item of value) bytesIn(item, found);
  else if (typeof value === "object" && value !== null && !ArrayBuffer.isView(value))
    for (const item of Object.values(value)) bytesIn(item, found);
  return found;
}

/** `text` with every way it could spell one of `secrets` (hex, base64, base64url, decimal) cut out. */
export function scrubbed(text: string, secrets: readonly Uint8Array[]): string {
  let out = text;
  for (const bytes of secrets) {
    const buffer = Buffer.from(bytes);
    const hex = buffer.toString("hex");
    const forms = [
      hex,
      hex.toUpperCase(),
      buffer.toString("base64"),
      buffer.toString("base64").replace(/=+$/u, ""),
      buffer.toString("base64url"),
      [...bytes].join(","),
      [...bytes].join(", "),
    ];
    for (const form of forms) out = out.replaceAll(form, "[bytes]");
  }
  return out;
}

/** Starts a job's worker thread with `data`; why not, if it could not even be started. */
export function startJobThread<D extends JobKindData>(
  data: WorkerData<D>,
  events: JobThreadEvents,
  entry: string | URL = jobEntry(),
): Result<void, string> {
  const secrets = bytesIn(data);
  const told = (thrown: unknown): string => scrubbed(described(thrown), secrets);
  let worker: Worker;
  try {
    worker = new Worker(entry, { workerData: data });
  } catch (thrown) {
    return err(told(thrown));
  }
  let once = false;
  const tell = (event: () => void): void => {
    if (once) return;
    once = true;
    event();
  };
  // The worker posts one message, `ended`, and only once its job has ended.
  worker.on("message", (reply: WorkerReply) => {
    tell(() => {
      events.ended(reply.outcome);
    });
  });
  worker.on("error", (error) => {
    tell(() => {
      events.failed(told(error));
    });
  });
  worker.on("messageerror", (error) => {
    tell(() => {
      events.failed(told(error));
    });
  });
  // The outcome's message has come before the thread's exit in every staging measured (5,760, on
  // Windows from source and compiled, Linux and macOS), but Bun does not document the order. If
  // an exit ever came first, the job would end failed `io` ("it stopped first") although the
  // worker had ended, and what it had already put in place would stay with no record of it,
  // unless the kind's leftovers name it. Each kind's job says what that is for it and why it is
  // harmless, or how it is made so:
  // - an update's staging (`update/stage-job.ts`): a version in `staged/`, which never runs: the
  //   launcher starts a staged version only by the hub's `switch.json` (`launcher/src/launcher.ts`,
  //   `#switch`), which the core writes only for the version it recorded staged
  //   (`core/upkeep/update.ts`, `switchIfClear`), and the next staging's removal of every version
  //   but the current one takes it (`stage.ts`, `#prepareRemoval`), as does the launcher's
  //   pruning. The cost is one staging to retry;
  // - a firmware image's (`firmware/stage-job.ts`): its `<sha256>.bin`, unindexed until the next
  //   start's check deletes it;
  // - a backup (`backup/write-job.ts`): a whole backup file with no record, a good backup;
  // - a restore (`backup/restore-job.ts`): `hub.db.restore`, which the next start would put in
  //   place, so it is among the restore's leftovers and removed.
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

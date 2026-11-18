/**
 * The shell's file jobs (m2-design.md section 2, `fileJob` and `FileWork`; section 9): each job
 * done, and its outcome handed back to the core as `fileReady`. The loop gives a turn's jobs here
 * only after the turn's commit succeeded and after its sends and answers, so a backup holds every
 * change of its step and an export's reply leaves before its chunks (the wiring the step 0 owner
 * makes, reported).
 *
 * Two jobs end the process instead of answering: `switchRestore` and `switchUpdate`, which ask the
 * caller to stop cleanly and exit 70 once their file work is done (`afterStop`).
 */
import type { Database } from "bun:sqlite";
import { statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ok, Result } from "neverthrow";
import type { FileWork, UploadRef } from "../../core/model/effects.ts";
import type { FileOutcome } from "../../core/model/events.ts";
import type { JobId } from "../../core/model/ids.ts";
import type { HubRules } from "../../core/model/rules.ts";
import { HUB_VERSION } from "../hub-facts.ts";
import { requestSwitch } from "../update/notes.ts";
import { PUBLISHER_KEYS } from "../update/publisher-keys.ts";
import { platformOf } from "../update/release.ts";
import { Staging } from "../update/stage.ts";
import { readRestoreHeader, RestorePieces, swapRestored } from "./restore.ts";
import { ExportPieces } from "./export-pieces.ts";
import { HistoryExport } from "./history-export.ts";
import { BackupPieces, type ExportSink, type WriteDeps } from "./write.ts";

/** Where the uploads are: the shell's upload store (owner A2), by `UploadRef`. */
export interface Uploads {
  pathOf(upload: UploadRef): string | undefined;
}

export interface JobDeps extends WriteDeps {
  /** The writer's connection, after the turn's commit: the one connection (HD 5). */
  readonly db: Database;
  readonly dataDir: string;
  readonly migrationsFolder: string;
  readonly rules: HubRules;
  readonly uploads: Uploads;
  readonly exports: ExportSink;
  /** The install's prefix, from the launcher. */
  readonly prefix: string | undefined;
  /** What holds an update's switch back now (`core/upkeep/view.ts`'s `switchBlockedBy`). */
  readonly switchBlockedBy: () => string | undefined;
  /** The running version (`HUB_VERSION` when not given). */
  readonly version?: string;
  /** The keys a release must be signed by (`PUBLISHER_KEYS` when not given; tests give theirs). */
  readonly publisherKeys?: readonly Uint8Array[];
  /** Whether the core still wants staging job `job` (`upkeep`'s `stagingJob` view). */
  readonly stagingWanted?: (job: JobId) => boolean;
  /** Free bytes on the data folder's disk, and the database's size (the switch's room check). */
  readonly room?: () => { readonly freeBytes: number; readonly databaseBytes: number } | undefined;
  /**
   * What is staged committed, as before `hsn log`: an export with history reads only what is
   * committed (wired as the writer's `flush("log")`; without it, what the last commit holds).
   */
  readonly flush?: () => Result<unknown, string>;
}

/** What a job came to: an outcome for the core, or a clean stop and exit 70 after `afterStop`. */
export type JobDone =
  | { readonly kind: "ready"; readonly outcome: FileOutcome }
  | {
      readonly kind: "stopAndRestart";
      /** Run after the clean stop closed the database: the file work that must wait for it. */
      readonly afterStop: () => Result<void, string>;
    };

/** The room a migration's copy needs beyond the database's own size ‡ (section 9, step 4). */
export const COPY_MARGIN_BYTES = 50 * 1024 * 1024;

/** Free bytes on the data folder's disk and the database's size; undefined when unknown. */
export function roomOf(
  dataDir: string,
): { readonly freeBytes: number; readonly databaseBytes: number } | undefined {
  return Result.fromThrowable(() => {
    const fs = statfsSync(dataDir);
    const db = statSync(join(dataDir, "hub.db"), { throwIfNoEntry: false });
    return { freeBytes: fs.bavail * fs.bsize, databaseBytes: db?.size ?? 0 };
  })().unwrapOr(undefined);
}

/**
 * A job that runs in pieces between the loop's turns (staging an update): `next` does one bounded
 * piece and gives the outcome once the job has ended; `abort` ends it now (a stop), leaving
 * nothing behind.
 */
export interface Pieces {
  next(): FileOutcome | undefined;
  abort(message: string): FileOutcome;
}

/** What starting a job gives: done at once, a switch, or pieces for the loop to continue. */
export type JobStart = JobDone | { readonly kind: "pieces"; readonly pieces: Pieces };

/**
 * Starts a job (the wiring the step 0 owner is asked for, section 3's contract): staging an update,
 * a backup, an export and applying a restore are returned as
 * pieces, the loop running one piece after each turn's inputs and effects and asking for another
 * turn while any remains, so inputs are never starved; every other job is done at once.
 */
export function startJob(job: JobId, work: FileWork, deps: JobDeps): JobStart {
  if (work.kind === "export")
    return {
      kind: "pieces",
      pieces: work.history
        ? new HistoryExport(deps.db, job, work, deps.exports, deps)
        : new ExportPieces(deps.db, job, work, deps.exports, deps),
    };
  if (work.kind === "backup")
    return { kind: "pieces", pieces: new BackupPieces(deps.db, work, deps, deps.dataDir) };
  if (work.kind === "applyRestore") {
    const upload = deps.uploads.pathOf(work.upload);
    if (upload === undefined) return noUpload(work.upload);
    return {
      kind: "pieces",
      pieces: new RestorePieces({
        dataDir: deps.dataDir,
        uploadPath: upload,
        key: work.key,
        migrationsFolder: deps.migrationsFolder,
        rules: deps.rules,
      }),
    };
  }
  // The joint step 0's file work (docs/m3-m4-plan.md) is built in step 1 (B6, U9): until then, failed.
  if (
    work.kind === "fetchRelease" ||
    work.kind === "stageFirmware" ||
    work.kind === "removeFirmware" ||
    work.kind === "sendFirmware"
  )
    return ready({ kind: "failed", reason: "io", message: `${work.kind} is not built yet` });
  if (work.kind !== "stageUpdate") return atOnce(work, deps);
  const path = deps.uploads.pathOf(work.upload);
  if (path === undefined) return noUpload(work.upload);
  return {
    kind: "pieces",
    pieces: new Staging({
      path,
      prefix: deps.prefix,
      runningVersion: deps.version ?? HUB_VERSION,
      platform: platformOf(process.platform, process.arch),
      keys: deps.publisherKeys ?? PUBLISHER_KEYS,
      wanted: () => deps.stagingWanted?.(job) ?? true,
    }),
  };
}

function ready(outcome: FileOutcome): JobDone {
  return { kind: "ready", outcome };
}

function noUpload(upload: UploadRef): JobDone {
  return ready({
    kind: "failed",
    reason: "noUpload",
    message: `no upload ${upload.job} on connection ${upload.conn}`,
  });
}

/** The jobs done at once: the rest are pieces (`startJob`). */
type AtOnce = Extract<
  FileWork,
  { readonly kind: "readRestore" | "switchRestore" | "switchUpdate" }
>;

function atOnce(work: AtOnce, deps: JobDeps): JobDone {
  switch (work.kind) {
    case "readRestore": {
      const path = deps.uploads.pathOf(work.upload);
      return path === undefined ? noUpload(work.upload) : ready(readRestoreHeader(path));
    }
    case "switchRestore":
      return { kind: "stopAndRestart", afterStop: () => swapRestored(deps.dataDir) };
    case "switchUpdate": {
      // The migration's copy needs room: the database and 50 MB ‡ more (section 9, step 4).
      const room = (deps.room ?? (() => roomOf(deps.dataDir)))();
      if (room !== undefined && room.freeBytes < room.databaseBytes + COPY_MARGIN_BYTES)
        return ready({
          kind: "failed",
          reason: "full",
          message: `${Math.floor(room.freeBytes / 1_000_000)} MB free, the database's copy needs ${Math.ceil((room.databaseBytes + COPY_MARGIN_BYTES) / 1_000_000)} MB`,
        });
      const asked = requestSwitch(deps.prefix, work.version, deps.switchBlockedBy());
      return asked.isErr()
        ? ready(asked.error)
        : { kind: "stopAndRestart", afterStop: () => ok(undefined) };
    }
  }
}

/**
 * A job started and, if in pieces, run to its end, a piece after another: what the tests use
 * to see a job's outcome. The hub never does this: its loop takes `startJob`'s pieces one a turn.
 */
export function runToEnd(job: JobId, work: FileWork, deps: JobDeps): JobDone {
  const started = startJob(job, work, deps);
  if (started.kind !== "pieces") return started;
  for (;;) {
    const outcome = started.pieces.next();
    if (outcome !== undefined) return ready(outcome);
  }
}

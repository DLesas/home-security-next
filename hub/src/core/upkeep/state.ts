/**
 * The upkeep module's slice (m2-design.md section 2, module 19; section 9): backup settings and
 * whether a backup is due and since when (`backup_state`), the backup key and its epoch
 * (`backup_key`), the file jobs it waits for, a restore in progress, and the update state
 * (`update_state`).
 *
 * The rows are kept exactly as committed, so every write is the full row (hub-design.md section 2).
 * What is not a row is memory: the jobs in flight, the coalescing window, a restore (its token is
 * never stored, section 9), and the running version (from `hubFacts`).
 */
import type { AnswerTo } from "../model/messages.ts";
import type { FileFailure } from "../model/events.ts";
import { type ConnId, type JobId, TOKEN_RANGES, type TokenId } from "../model/ids.ts";
import {
  UpdateResult,
  BACKUP_STATE_DEFAULTS,
  type BackupKeyRow,
  type BackupStateRow,
  type UpdateStateRow,
} from "../model/rows.ts";
import type { TimerOf } from "../model/timers.ts";
import type { UploadRef } from "../model/effects.ts";
import type { Mono } from "../model/time.ts";

/** A backup job the shell is writing (section 9, "When"). */
export interface BackupRunning {
  readonly job: JobId;
  /** The step that started it: a change in that step is in the file (the shell writes after the commit). */
  readonly startedAt: Mono;
  /**
   * The first change made after the step that started the job, which the file therefore does not
   * hold; null while there is none. It becomes `due_since_ms` when the job is done.
   */
  readonly changedSinceMs: number | null;
}

/** What a restore file's header says (section 9, restore step 1). */
export interface RestoreHeader {
  /** The app identity's 16 bytes of the hub the file came from. */
  readonly identity: Uint8Array;
  readonly epoch: number;
  readonly madeMs: number;
  readonly lastChangeMs: number;
}

/** A restore under way (section 9, "Restore"). Memory only: a restart loses the upload too. */
export type RestoreState =
  /** `restore.start` asked; the shell reads the header (`readRestore`). */
  | {
      readonly stage: "reading";
      readonly job: JobId;
      readonly upload: UploadRef;
      readonly answerTo: AnswerTo;
    }
  /**
   * The header is read and the restore token given to the shell; `conn` is the phone's restore
   * connection once its handshake reached message 3 (`restoreOpened`).
   */
  | {
      readonly stage: "offered";
      readonly token: TokenId;
      readonly upload: UploadRef;
      readonly header: RestoreHeader;
      readonly conn: ConnId | undefined;
    }
  /** The phone's key came: the shell decrypts and prepares the restored database. */
  | {
      readonly stage: "applying";
      readonly job: JobId;
      readonly token: TokenId;
      readonly upload: UploadRef;
      readonly header: RestoreHeader;
      readonly conn: ConnId;
    }
  /** The restored database is ready; the shell puts it in place and exits 70. */
  | { readonly stage: "switching"; readonly job: JobId };

export interface UpkeepSlice {
  readonly timers: readonly TimerOf<"upkeep">[];
  /** False until the boot event. */
  readonly booted: boolean;
  /** `backup_state` as committed. */
  readonly backup: BackupStateRow;
  /** `backup_key`; undefined only before the boot event made it. */
  readonly key: BackupKeyRow | undefined;
  /** `update_state` as committed; all null when no row is stored yet. */
  readonly update: UpdateStateRow;
  /** The running version, from the shell's `hubFacts`; undefined until the first. */
  readonly version: string | undefined;
  /** The next `JobId` to give. */
  readonly nextJob: number;
  /** The next restore token number, counting up from 2³¹ at each boot (section 5). */
  readonly nextRestoreToken: number;
  /** The backup the shell is writing, if any. */
  readonly running: BackupRunning | undefined;
  /** A backup started less than 60 s ‡ ago: changes since go into one more when it ends (D122). */
  readonly windowOpen: boolean;
  /** A failed backup waits for its 5-minute ‡ retry. */
  readonly retrying: boolean;
  /** The daily backup fell due and has not been written yet. */
  readonly dailyDue: boolean;
  /** Why the last backup failed, for `backup_overdue`'s detail; undefined after a success. */
  readonly lastFailure: FileFailure | undefined;
  /** Export jobs streaming, so their outcome is recognised. */
  readonly exports: ReadonlySet<JobId>;
  /** An update being staged (`stageUpdate`), with where its answer goes. */
  readonly staging:
    { readonly job: JobId; readonly upload: UploadRef; readonly answerTo: AnswerTo } | undefined;
  /** The switch to the staged version was handed to the shell (`switchUpdate`). */
  readonly switchJob: JobId | undefined;
  readonly restore: RestoreState | undefined;
  /**
   * The folder `backup_folder_on_data_disk` was raised for (once per folder chosen; memory, so a
   * restart may tell it once more).
   */
  readonly warnedFolder: string | null;
}

/** `update_state` with nothing in it. */
export const NO_UPDATE: UpdateStateRow = {
  stagedVersion: null,
  stagedMs: null,
  approvedBy: null,
  approvedMs: null,
  switchingMs: null,
  previousVersion: null,
  lastResult: UpdateResult.None,
  lastResultMs: null,
};

/** The slice before the boot event. */
export const EMPTY_UPKEEP_SLICE: UpkeepSlice = {
  timers: [],
  booted: false,
  backup: BACKUP_STATE_DEFAULTS,
  key: undefined,
  update: NO_UPDATE,
  version: undefined,
  nextJob: 1,
  nextRestoreToken: TOKEN_RANGES.restore.first,
  running: undefined,
  windowOpen: false,
  retrying: false,
  dailyDue: false,
  lastFailure: undefined,
  exports: new Set(),
  staging: undefined,
  switchJob: undefined,
  restore: undefined,
  warnedFolder: null,
};

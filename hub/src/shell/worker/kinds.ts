/**
 * The data each kind of file job's worker is started with (D145): one union on `kind`, which the
 * loop's side (`job.ts`), the thread (`safe/job-thread.ts`) and the worker's entry (`entry.ts`)
 * share, so a kind added here and not served by the entry, or served with other data, does not
 * compile. Data only: a worker's `workerData` is copied across, never shared but `control`.
 */
import type { RestoreInputs } from "../backup/restore.ts";
import type { BackupRead, BackupWork } from "../backup/write.ts";
import type { SigningKeys } from "../firmware/sign.ts";
import type { FirmwareStageInputs } from "../firmware/stage.ts";
import type { StageInputs } from "../update/stage.ts";
import type { JobControl } from "./control.ts";

/** An update's staging (`update/stage.ts`): its inputs but `wanted`, which is the control word. */
export interface StageUpdateData {
  readonly kind: "stageUpdate";
  readonly inputs: Omit<StageInputs, "wanted">;
}

/** The hub's signing key's columns as the loop read them from `hub.db`, or why it could not. */
export type KeysRead = { readonly keys: SigningKeys } | { readonly error: string };

/**
 * A firmware image's staging (`firmware/stage.ts`): its inputs but `signer`, which reads `hub.db`:
 * the loop reads the key's columns instead as the job starts (`signingKeys`), and the worker makes
 * the signer of them.
 */
export interface StageFirmwareData {
  readonly kind: "stageFirmware";
  readonly inputs: Omit<FirmwareStageInputs, "signer">;
  readonly signingKeys: KeysRead;
}

/**
 * A backup's file work (`backup/write.ts`, `BackupFile`): what the loop read of `hub.db` for it
 * (`readBackup`), the work (its folder, how many to keep, the key, the epoch) and the data folder,
 * whose disk the folder's is told against.
 */
export interface WriteBackupData {
  readonly kind: "writeBackup";
  readonly read: BackupRead;
  readonly work: BackupWork;
  readonly dataDir: string | undefined;
}

/**
 * A restore's candidate database built from the uploaded backup (`backup/restore.ts`,
 * `RestorePieces`): the upload, the phone's key, the data folder it is built in, the migrations
 * and the rules. Nothing of `hub.db`: the build needs none of it.
 */
export interface ApplyRestoreData {
  readonly kind: "applyRestore";
  readonly inputs: RestoreInputs;
}

/** Every kind's data. */
export type JobKindData = StageUpdateData | StageFirmwareData | WriteBackupData | ApplyRestoreData;

export type JobKind = JobKindData["kind"];

/** One kind's data. */
export type KindData<K extends JobKind> = Extract<JobKindData, { readonly kind: K }>;

/** What a kind's worker is started with: its data and the word the loop and the worker share. */
export type WorkerData<D extends JobKindData> = D & { readonly control: JobControl };

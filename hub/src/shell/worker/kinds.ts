/**
 * The data each kind of file job's worker is started with (D145): one union on `kind`, which the
 * loop's side (`job.ts`), the thread (`safe/job-thread.ts`) and the worker's entry (`entry.ts`)
 * share, so a kind added here and not served by the entry, or served with other data, does not
 * compile. Data only: a worker's `workerData` is copied across, never shared but `control`.
 */
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

/** Every kind's data. */
export type JobKindData = StageUpdateData | StageFirmwareData;

export type JobKind = JobKindData["kind"];

/** One kind's data. */
export type KindData<K extends JobKind> = Extract<JobKindData, { readonly kind: K }>;

/** What a kind's worker is started with: its data and the word the loop and the worker share. */
export type WorkerData<D extends JobKindData> = D & { readonly control: JobControl };

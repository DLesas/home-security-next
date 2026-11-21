/**
 * Staging an update's worker thread: a file job's (`job-thread.ts`, D145), its data marked
 * `stageUpdate` so the one worker entry (`shell/worker/entry.ts`) serves it as a staging.
 */
import type { Result } from "neverthrow";
import type { StagingWorkerData } from "../update/stage-serve.ts";
import { type JobThreadEvents, startJobThread } from "./job-thread.ts";

export type StagingThreadEvents = JobThreadEvents;

/** Starts staging on a worker thread; why not, if it could not even be started. */
export function startStagingThread(
  data: StagingWorkerData,
  events: StagingThreadEvents,
  entry?: string | URL,
): Result<void, string> {
  return startJobThread({ ...data, kind: "stageUpdate" }, events, entry);
}

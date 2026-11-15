/**
 * Read-only selectors over the upkeep module's slice that other modules and the shell may use
 * (hub-design.md section 2).
 *
 * - `backupKeyOf`: the key and its epoch, which `people` gives a phone in its `LinkResult` (from
 *   M3, D78, D99). It never enters a record or an event.
 * - `switchBlockedBy`: what holds an update's switch back now, which the shell checks again after
 *   the commit of the step that asked for it (`update.ts`).
 * - `backupSummary`, `updateSummary`: for `hsn status` and the app's `hub` event.
 */
import type { BackupKeyRow, UpdateResult } from "../model/rows.ts";
import type { JobId } from "../model/ids.ts";
import type { HubState } from "../model/state.ts";
import type { UpkeepSlice } from "./state.ts";
import { type SwitchBlock, switchBlock } from "./update.ts";

export type { SwitchBlock } from "./update.ts";

/** The slice itself, for tests. */
export function upkeepSlice(view: HubState): UpkeepSlice {
  return view.upkeep;
}

/** The backup key and its epoch; undefined before the boot event made it. */
export function backupKeyOf(view: HubState): BackupKeyRow | undefined {
  return view.upkeep.key;
}

/** What would hold an update's switch back now, or undefined when it may go (D54, HB23). */
export function switchBlockedBy(view: HubState): SwitchBlock | undefined {
  return switchBlock(view, view.upkeep);
}

/** Whether a backup is due, since when, and whether one is being written. */
export function backupSummary(view: HubState): {
  readonly folder: string | null;
  readonly dueSinceMs: number | null;
  readonly overdue: boolean;
  readonly writing: boolean;
  readonly newestMs: number | null;
} {
  const slice = view.upkeep;
  return {
    folder: slice.backup.folder,
    dueSinceMs: slice.backup.dueSinceMs,
    overdue: slice.backup.overdueRaised,
    writing: slice.running !== undefined,
    newestMs: slice.backup.newestMs,
  };
}

/** The staged version, its approval, whether it is switching, and how the last one came out. */
export function updateSummary(view: HubState): {
  readonly staged: string | null;
  readonly approved: boolean;
  readonly switching: boolean;
  readonly lastResult: UpdateResult;
} {
  const slice = view.upkeep;
  return {
    staged: slice.update.stagedVersion,
    approved: slice.update.approvedBy !== null,
    switching: slice.update.switchingMs !== null,
    lastResult: slice.update.lastResult,
  };
}

/** The update being staged, by its job; the shell's pieces stop when it is no longer this one. */
export function stagingJob(view: HubState): JobId | undefined {
  return view.upkeep.staging?.job;
}

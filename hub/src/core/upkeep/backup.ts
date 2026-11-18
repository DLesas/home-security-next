/**
 * Backups (m2-design.md section 9, "Backup, export and restore"; D53, D122): when one is due,
 * when one is written, and what happens when the folder cannot be reached.
 *
 * - **A change** to people, clients, permissions, user management, paired devices or the backup
 *   key sets `last_change_ms`, and `due_since_ms` if no backup is due yet, in the change's own
 *   commit (upkeep runs in the same step, after every module that makes such a change).
 * - **At once**, a backup job: the shell performs it after the step's commit, so the file holds
 *   every change of that step. A backup started opens a 60 s ‡ window; changes inside it go into
 *   one more backup when the window has closed and that one is done, so a setup session of thirty
 *   additions writes about one a minute (D122).
 * - **Daily** at the local hour of `backup_state.hour` (03:00 ‡), whatever changed.
 * - **Never on an untrusted clock**: the file's name and header carry its time; a backup due
 *   then is written when the clock is trusted.
 * - **An unreachable folder** (or a full disk): the change stays committed and nothing waits for
 *   the backup. A `backup_failed` hub event each try, a retry every 5 minutes ‡, and after an
 *   hour ‡ with a backup due one `backup_overdue` warning that cannot be turned off.
 * - **No folder chosen**: one `backup_no_folder` warning instead, at the first change a backup
 *   would hold (not at boot), and never again until a folder is chosen (`noFolderWarning`).
 * - **The key replaced** whenever a phone that holds it is removed: a new key and epoch in the
 *   removal's own commit, `backup_key_replaced`, and a backup under the new key, whose job also
 *   deletes this hub's files of older epochs.
 */
import { BACKUP_FORMAT } from "@hsn/protocol/app";
import type { Context } from "../model/handler.ts";
import type { DecisionKind } from "../model/decisions.ts";
import { EVERY_DAY } from "../model/calendar.ts";
import type { FileOutcome } from "../model/events.ts";
import type { ClientId, JobId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { BackupResult, type BackupStateRow, ClientKind } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import { peopleSlice } from "../people/view.ts";
import { timeZone } from "../schedules/view.ts";
import { upkeepDecision, upkeepHubEvent, writeBackupKey, writeBackupState } from "./records.ts";
import type { Steps } from "./out.ts";

/** The decisions that change what a backup must hold (D122): people's, written now. */
const PEOPLE_CHANGES: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  "person_added",
  "person_renamed",
  "person_removed",
  "client_linked",
  "client_renamed",
  "client_removed",
  "permissions_changed",
  "user_management_changed",
]);

/** The registry's hub events for a paired device added, renamed, removed or left behind (HD 6). */
const DEVICE_CHANGES: ReadonlySet<string> = new Set([
  "device_added",
  "device_renamed",
  "device_state",
  "device_removed",
  "device_reset_by_owner",
  "device_not_added",
]);

/** A minute: the daily backup's next time is looked for this far after one has run. */
const DAILY_AFTER_MS = 60_000;

/** Whether a message records a change a backup must hold (section 9, "When"). */
export function isBackupChange(message: Internal): boolean {
  if (message.kind !== "auditRecord") return false;
  const record = message.record;
  if (record.kind === "decision") return PEOPLE_CHANGES.has(record.row.kind);
  if (record.kind === "hubEvent") return DEVICE_CHANGES.has(record.row.code);
  return false;
}

/** The folder's `keep`, or the rule's 20 ‡. */
export function keepOf(row: BackupStateRow, ctx: Context): number {
  return row.keep ?? ctx.deps.rules.backups.keep;
}

/** The daily hour, or the rule's 03:00 ‡. */
export function hourOf(row: BackupStateRow, ctx: Context): number {
  return row.hour ?? ctx.deps.rules.backups.defaultHour;
}

function setRow(steps: Steps, row: BackupStateRow, durability: Durability = "now"): void {
  steps.set({ ...steps.slice, backup: row });
  steps.push(writeBackupState(row, durability));
}

/**
 * The overdue warning's timer for a backup due since `dueSinceMs`, an hour ‡ after it on the
 * trusted wall clock. When that hour has already passed (a start, or a backup that took that long,
 * with a backup still due) there is no timer, since one at or before now would run at once, one turn
 * after another (hub-design.md section 2, "Timers"): it returns true, and the caller raises the
 * warning in this step (`onOverdue`), where the timer would have raised it in the next.
 */
export function armOverdue(steps: Steps, ctx: Context, dueSinceMs: number): boolean {
  const warnAfter = ctx.deps.rules.backups.warnAfterMs;
  const waited = ctx.now.wallTrusted ? Math.max(0, ctx.now.wall - dueSinceMs) : 0;
  const left = warnAfter - waited;
  if (left <= 0) {
    steps.clear("backupOverdue");
    return true;
  }
  steps.timerAfter(ctx, "backupOverdue", left);
  return false;
}

/** A change a backup must hold, in this step (section 9, "When"). */
export function noteChange(steps: Steps, ctx: Context): void {
  const row = steps.slice.backup;
  const firstDue = row.dueSinceMs === null;
  setRow(steps, {
    ...row,
    lastChangeMs: ctx.now.wall,
    dueSinceMs: row.dueSinceMs ?? ctx.now.wall,
    overdueRaised: firstDue ? false : row.overdueRaised,
  });
  if (firstDue && armOverdue(steps, ctx, ctx.now.wall)) onOverdue(steps, ctx);
  const running = steps.slice.running;
  // A change in the step that started the job is committed before the shell writes it.
  if (running?.changedSinceMs === null && ctx.now.mono > running.startedAt)
    steps.set({ ...steps.slice, running: { ...running, changedSinceMs: ctx.now.wall } });
}

/**
 * The key replaced (section 9, "The key is replaced"): when `client` was a phone that held it. In
 * the removal's step, so both are in one commit.
 */
export function onClientRemoved(steps: Steps, ctx: Context, client: ClientId): void {
  const row = peopleSlice(ctx.view).clients.get(client);
  const key = steps.slice.key;
  if (key === undefined || row?.kind !== ClientKind.Phone || row.backupKeyEpoch === null) return;
  replaceKey(steps, ctx, key.epoch + 1);
}

/** A new backup key and epoch from the input's entropy, written now (section 9). */
export function replaceKey(steps: Steps, ctx: Context, epoch: number): void {
  const taken = ctx.entropy.take(BACKUP_FORMAT.keyBytes);
  if (taken.isErr()) {
    steps.fail(taken.error);
    return;
  }
  const key = { key: taken.value, epoch };
  steps.set({ ...steps.slice, key });
  steps.push(writeBackupKey(key));
  if (epoch > 1) steps.pushResult(upkeepDecision(ctx, "backup_key_replaced", { value: epoch }));
  noteChange(steps, ctx);
}

/** Starts a backup job when one is wanted and may be written; otherwise nothing. */
export function consider(steps: Steps, ctx: Context): void {
  const slice = steps.slice;
  if (!slice.booted || slice.running !== undefined || slice.windowOpen || slice.retrying) return;
  if (slice.restore?.stage === "applying" || slice.restore?.stage === "switching") return;
  if (slice.backup.dueSinceMs === null && !slice.dailyDue) return;
  startBackup(steps, ctx);
}

/** Whether a backup can be written now: a folder, a key, a trusted clock. */
export function canWrite(steps: Steps, ctx: Context): boolean {
  return steps.slice.backup.folder !== null && steps.slice.key !== undefined && ctx.now.wallTrusted;
}

/** A backup job, its window opened; the job number, or undefined when none can be written. */
export function startBackup(steps: Steps, ctx: Context): JobId | undefined {
  const folder = steps.slice.backup.folder;
  const key = steps.slice.key;
  if (folder === null || key === undefined || !ctx.now.wallTrusted) return undefined;
  const job = steps.job();
  steps.push({
    kind: "fileJob",
    job,
    work: {
      kind: "backup",
      folder,
      keep: keepOf(steps.slice.backup, ctx),
      key: key.key,
      epoch: key.epoch,
    },
  });
  steps.set({
    ...steps.slice,
    running: { job, startedAt: ctx.now.mono, changedSinceMs: null },
    windowOpen: true,
    retrying: false,
    dailyDue: false,
  });
  steps.clear("backupRetry");
  steps.timerAfter(ctx, "backupCoalesce", ctx.deps.rules.backups.coalesceMs);
  return job;
}

/** A backup job's outcome (`fileReady`). */
export function onBackupDone(steps: Steps, ctx: Context, outcome: FileOutcome): void {
  const running = steps.slice.running;
  if (running === undefined) return;
  const row = steps.slice.backup;
  steps.set({ ...steps.slice, running: undefined });
  if (outcome.kind === "backupWritten") {
    const dueSinceMs = running.changedSinceMs;
    setRow(
      steps,
      {
        ...row,
        dueSinceMs,
        overdueRaised: false,
        newestName: outcome.name,
        newestMs: ctx.now.wall,
        lastResult: BackupResult.Written,
        lastAttemptMs: ctx.now.wall,
      },
      "routine",
    );
    steps.set({ ...steps.slice, lastFailure: undefined });
    // A folder on the data folder's own disk dies with it: told once per folder chosen.
    const folder = row.folder;
    if (outcome.sameDiskAsData && folder !== null && steps.slice.warnedFolder !== folder) {
      steps.set({ ...steps.slice, warnedFolder: folder });
      steps.pushResult(upkeepDecision(ctx, "backup_folder_on_data_disk", { detail: folder }));
    }
    if (dueSinceMs === null) steps.clear("backupOverdue");
    const overdueNow = dueSinceMs !== null && armOverdue(steps, ctx, dueSinceMs);
    steps.pushResult(
      upkeepHubEvent(ctx, "backup_written", `backup written: ${outcome.name}`, {
        name: outcome.name,
        bytes: outcome.bytes,
        epoch: steps.slice.key?.epoch ?? 0,
      }),
    );
    consider(steps, ctx);
    // A change made while the job ran more than an hour ‡ ago: the warning now, after the record
    // of the backup that does not hold it, as its timer would have raised it one turn later.
    if (overdueNow) onOverdue(steps, ctx);
    return;
  }
  const reason = outcome.kind === "failed" ? outcome.reason : "io";
  const message = outcome.kind === "failed" ? outcome.message : `unexpected ${outcome.kind}`;
  // Changes after the job's start are still due, as everything before it was.
  const dueSinceMs = row.dueSinceMs ?? running.changedSinceMs;
  setRow(
    steps,
    {
      ...row,
      dueSinceMs,
      lastResult: BackupResult.Failed,
      lastAttemptMs: ctx.now.wall,
    },
    "routine",
  );
  // A daily backup that failed is still owed.
  steps.set({ ...steps.slice, retrying: true, dailyDue: true, lastFailure: reason });
  steps.timerAfter(ctx, "backupRetry", ctx.deps.rules.backups.retryMs);
  steps.pushResult(
    upkeepHubEvent(ctx, "backup_failed", `backup failed: ${message}`, { reason, message }),
  );
}

/** The window after a backup's start closed: changes since go into one more (D122). */
export function onWindowClosed(steps: Steps, ctx: Context): void {
  steps.set({ ...steps.slice, windowOpen: false });
  consider(steps, ctx);
}

export function onRetry(steps: Steps, ctx: Context): void {
  steps.set({ ...steps.slice, retrying: false });
  consider(steps, ctx);
}

/**
 * With no folder chosen, a change a backup would hold says so once (section 9): `backup_no_folder`,
 * now, with `overdue_raised` holding that it was said, so neither it nor `backup_overdue` comes
 * again until a folder is chosen (`folderChosen`). Called for a change, never at boot.
 */
export function noFolderWarning(steps: Steps, ctx: Context): void {
  const row = steps.slice.backup;
  if (row.folder !== null || row.overdueRaised) return;
  setRow(steps, { ...row, overdueRaised: true });
  steps.pushResult(upkeepDecision(ctx, "backup_no_folder", {}));
}

/**
 * A folder chosen where none was: the no-folder warning's mark cleared, and a backup still due
 * gets its own hour ‡ before `backup_overdue`. In the settings' own commit.
 */
export function folderChosen(steps: Steps, ctx: Context): void {
  const row = steps.slice.backup;
  setRow(steps, { ...row, overdueRaised: false });
  if (row.dueSinceMs !== null && armOverdue(steps, ctx, ctx.now.wall)) onOverdue(steps, ctx);
}

/** An hour ‡ with a backup due to a chosen folder: one warning that cannot be turned off. */
export function onOverdue(steps: Steps, ctx: Context): void {
  const row = steps.slice.backup;
  // No folder: `backup_no_folder` said it (`noFolderWarning`); `backup_overdue` is for a folder.
  if (row.dueSinceMs === null || row.overdueRaised || row.folder === null) return;
  const reason =
    steps.slice.lastFailure ?? (row.lastResult === BackupResult.Failed ? "io" : "notTried");
  setRow(steps, { ...row, overdueRaised: true });
  steps.pushResult(
    upkeepDecision(ctx, "backup_overdue", { value: row.dueSinceMs, detail: reason }),
  );
}

/** The daily backup fell due; the next one is set. */
export function onDaily(steps: Steps, ctx: Context): void {
  steps.set({ ...steps.slice, dailyDue: true });
  armDaily(steps, ctx, ctx.now.wall + DAILY_AFTER_MS);
  consider(steps, ctx);
}

/**
 * The daily backup's timer, at the next local `hour`:00 in the hub's zone on the trusted wall
 * clock, as a monotonic deadline (HD 2). None while the zone is unknown or the clock untrusted;
 * set again when either changes. The calendar gives the first instant at or after `fromMs`, so
 * one armed at now can fall exactly on now: the daily backup is then due in this step (the caller's
 * `consider`, which every message of upkeep ends with, starts it), and the timer goes to the next
 * day's, never at now (hub-design.md section 2, "Timers").
 */
export function armDaily(steps: Steps, ctx: Context, fromMs: number = ctx.now.wall): void {
  steps.clear("backupDaily");
  const zone = timeZone(ctx.view);
  if (zone === null || !ctx.now.wallTrusted) return;
  const at = ctx.deps.calendar.next(
    { at: { hour: hourOf(steps.slice.backup, ctx), minute: 0 }, days: EVERY_DAY },
    zone,
    fromMs,
  );
  if (at === undefined) return;
  if (at <= ctx.now.wall) {
    steps.set({ ...steps.slice, dailyDue: true });
    armDaily(steps, ctx, ctx.now.wall + DAILY_AFTER_MS);
    return;
  }
  steps.timerAfter(ctx, "backupDaily", at - ctx.now.wall);
}

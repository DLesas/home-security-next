/**
 * The upkeep module's handler (m2-design.md section 2, module 19; section 9): backups, restore
 * and updates. It runs after `notify` and before `audit`, so it sees every change of the step that
 * a backup must hold before it decides that one is due; its own decisions reach `notify` in a
 * later turn of the same step's queue.
 *
 * It acts on: the boot event (its rows; the backup key made at the first start of M2; the restore
 * mark); `hubFacts` (the running version: an update's outcome); `timeZone` and `wallTrustChanged`
 * (the daily backup's time; a backup that waited for a trusted clock); every `auditRecord` of a
 * change a backup must hold; `clientRemoved` (a phone's removal replaces the key); its operations
 * (version 2's too); `releaseOffered` (a hub release the relay offers, M4); `fileReady`,
 * `restoreOpened` and `restoreKey`; and its five timers (`updateWait` is never set: an approved
 * update switches in the step that finds its way clear, `update.ts`).
 */
import { ok } from "neverthrow";
import type { Handler } from "../model/handler.ts";
import type { Context } from "../model/handler.ts";
import type { Internal } from "../model/messages.ts";
import { BACKUP_STATE_DEFAULTS } from "../model/rows.ts";
import {
  armDaily,
  armOverdue,
  consider,
  isBackupChange,
  noFolderWarning,
  noteChange,
  onBackupDone,
  onClientRemoved,
  onDaily,
  onOverdue,
  onRetry,
  onWindowClosed,
  replaceKey,
} from "./backup.ts";
import { Steps } from "./out.ts";
import { upkeepOp } from "./ops.ts";
import { upkeepDecision, writeBackupState } from "./records.ts";
import { restoreExpired, restoreJobDone, restoreKey, restoreOpened } from "./restore.ts";
import { NO_UPDATE, type UpkeepSlice } from "./state.ts";
import { afterSwitch, onReleaseOffered, staged, switchFailed, switchIfClear } from "./update.ts";

type Boot = Extract<Internal, { readonly kind: "boot" }>;

/** The boot event: the rows, the key at the first start, the restore mark (section 9). */
function onBoot(steps: Steps, ctx: Context, message: Boot): void {
  const m2 = message.snapshot.m2;
  const backup = m2.backupState ?? BACKUP_STATE_DEFAULTS;
  steps.set({
    ...steps.slice,
    booted: true,
    backup,
    key: m2.backupKey,
    update: m2.updateState ?? NO_UPDATE,
  });
  // The first start of M2: the backup key, a change a backup must hold.
  if (m2.backupKey === undefined) replaceKey(steps, ctx, 1);
  // A restored hub's first start: `restored`, and the mark cleared, in one commit. A backup of
  // the restored hub is due (every client's `seq` moved); its people are still the file's, so
  // `last_change_ms` stays the file's (D122).
  if (backup.restoredFromMs !== null) {
    steps.pushResult(upkeepDecision(ctx, "restored", { value: backup.restoredFromMs }));
    const row = steps.slice.backup;
    const cleared = { ...row, restoredFromMs: null, dueSinceMs: row.dueSinceMs ?? ctx.now.wall };
    steps.set({ ...steps.slice, backup: cleared });
    steps.push(writeBackupState(cleared));
  }
  const due = steps.slice.backup;
  // A backup due for an hour ‡ or more at the start: `backup_overdue` in this step, after the
  // start's own records, where a timer at the start's time would have raised it one turn later.
  const overdueNow =
    due.dueSinceMs !== null &&
    !due.overdueRaised &&
    !steps.has("backupOverdue") &&
    armOverdue(steps, ctx, due.dueSinceMs);
  armDaily(steps, ctx);
  consider(steps, ctx);
  if (overdueNow) onOverdue(steps, ctx);
}

function onFileReady(
  steps: Steps,
  ctx: Context,
  message: Extract<Internal, { readonly kind: "fileReady" }>,
): void {
  const { job, outcome } = message;
  const slice = steps.slice;
  if (slice.running?.job === job) {
    onBackupDone(steps, ctx, outcome);
    return;
  }
  if (slice.exports.has(job)) {
    const exports = new Set(slice.exports);
    exports.delete(job);
    steps.set({ ...slice, exports });
    return;
  }
  if (slice.staging?.job === job) {
    staged(steps, ctx, outcome);
    return;
  }
  if (slice.switchJob === job) {
    switchFailed(steps, ctx, outcome);
    return;
  }
  restoreJobDone(steps, ctx, job, outcome);
}

function onTimer(
  steps: Steps,
  ctx: Context,
  message: Extract<Internal, { readonly kind: "timer" }>,
): void {
  const key = message.key;
  if (key.module !== "upkeep") return;
  steps.clear(key.kind);
  switch (key.kind) {
    case "backupDaily": {
      onDaily(steps, ctx);
      return;
    }
    case "backupCoalesce": {
      onWindowClosed(steps, ctx);
      return;
    }
    case "backupRetry": {
      onRetry(steps, ctx);
      return;
    }
    case "backupOverdue": {
      onOverdue(steps, ctx);
      return;
    }
    case "restoreExpiry": {
      restoreExpired(steps);
      return;
    }
  }
}

function handle(steps: Steps, ctx: Context, message: Internal): void {
  switch (message.kind) {
    case "boot": {
      onBoot(steps, ctx, message);
      return;
    }
    case "hubFacts":
      steps.set({ ...steps.slice, version: message.version });
      {
        afterSwitch(steps, ctx, message.version);
        return;
      }
    case "timeZone": {
      armDaily(steps, ctx);
      return;
    }
    case "wallTrustChanged":
      armDaily(steps, ctx);
      {
        consider(steps, ctx);
        return;
      }
    case "clientRemoved": {
      onClientRemoved(steps, ctx, message.client);
      return;
    }
    case "opRequest":
      if (message.owner !== "upkeep") return;
      {
        upkeepOp(steps, ctx, message.op, message.actor, message.answerTo);
        return;
      }
    // Version 2's own rows (`backup.keyHeld`, `update.offers`, `update.fetch`), as `app` routes
    // them (docs/m3-m4-plan.md, step 2).
    case "v2OpRequest":
      if (message.owner !== "upkeep") return;
      {
        upkeepOp(steps, ctx, message.op, message.actor, message.answerTo);
        return;
      }
    case "releaseOffered": {
      onReleaseOffered(steps, ctx, message.releases);
      return;
    }
    case "fileReady": {
      onFileReady(steps, ctx, message);
      return;
    }
    case "restoreOpened": {
      restoreOpened(steps, message.conn, message.token);
      return;
    }
    case "restoreKey": {
      restoreKey(steps, message.conn, message.token, message.key, message.epoch);
      return;
    }
    case "timer": {
      onTimer(steps, ctx, message);
      return;
    }
    default:
      if (isBackupChange(message)) {
        noteChange(steps, ctx);
        noFolderWarning(steps, ctx);
      }
      return;
  }
}

/**
 * The handler: every message, then a backup started if one is wanted and may be written (it is
 * idempotent: a job running, the window open or a retry waiting holds it), and an approved update
 * switched if nothing holds it back now (update.ts).
 */
export const handleUpkeep: Handler<"upkeep"> = (slice: UpkeepSlice, message, ctx) => {
  if (!slice.booted && message.kind !== "boot") return ok({ slice, out: [] });
  const steps = new Steps(slice);
  handle(steps, ctx, message);
  consider(steps, ctx);
  switchIfClear(steps, ctx);
  return steps.done();
};

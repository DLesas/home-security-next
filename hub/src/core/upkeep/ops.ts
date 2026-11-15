/**
 * upkeep's operations (m2-design.md section 6; `OP_OWNERS`): `backup.*`, `restore.start` and
 * `update.*`. `app` has already checked the console listener (C) and *manage system* (MS) for an
 * app's request; the hub computer has every permission (HD 9). upkeep checks what only it can:
 * whose `backup.key` it is, and the state each operation needs.
 */
import type { AppOp } from "@hsn/protocol/app";
import type { Context } from "../model/handler.ts";
import type { Actor, AnswerTo } from "../model/messages.ts";
import { BackupResult, ClientKind } from "../model/rows.ts";
import { liveClient } from "../people/view.ts";
import {
  armDaily,
  canWrite,
  consider,
  folderChosen,
  hourOf,
  keepOf,
  startBackup,
} from "./backup.ts";
import { invalid, type Steps, UNAVAILABLE } from "./out.ts";
import { writeBackupState } from "./records.ts";
import { restoreStart } from "./restore.ts";
import { updateApprove, updateCancel, updateStatus, updateUpload } from "./update.ts";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Bytes as base64url without padding (RFC 4648 section 5), as JSON carries them (section 6). */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let k = 0; k < chars; k++) out += BASE64URL[(n >>> (18 - 6 * k)) & 63] ?? "";
  }
  return out;
}

const RESULT_NAMES = {
  [BackupResult.Never]: "never",
  [BackupResult.Written]: "ok",
  [BackupResult.Failed]: "failed",
} as const;

/**
 * `backup.key` (section 9): only a phone whose epoch is older than the key's; it is the one read
 * that hands out a secret, which `app` records as a routine `commands` row. Browsers are never
 * given the key (section 5).
 */
function backupKey(steps: Steps, ctx: Context, answerTo: AnswerTo, actor: Actor): void {
  const key = steps.slice.key;
  const client = actor.kind === "person" ? liveClient(ctx.view, actor.client) : undefined;
  if (
    key === undefined ||
    client?.kind !== ClientKind.Phone ||
    client.backupKeyEpoch === key.epoch
  ) {
    steps.refuse(answerTo, { code: "unauthorized", detail: {} });
    return;
  }
  steps.answer(answerTo, { key: base64url(key.key), epoch: key.epoch });
}

function backupSettings(
  steps: Steps,
  ctx: Context,
  answerTo: AnswerTo,
  body: Extract<AppOp, { readonly op: "backup.settings" }>["body"],
): void {
  const row = steps.slice.backup;
  const next = {
    ...row,
    folder: body.folder ?? row.folder,
    hour: body.hour ?? row.hour,
    keep: body.keep ?? row.keep,
  };
  steps.set({ ...steps.slice, backup: next });
  steps.push(writeBackupState(next));
  if (row.folder === null && next.folder !== null) folderChosen(steps, ctx);
  if (body.hour !== undefined) armDaily(steps, ctx);
  steps.answer(answerTo, {});
  consider(steps, ctx);
}

/** One operation upkeep owns, answered now or when its file job ends. */
export function upkeepOp(
  steps: Steps,
  ctx: Context,
  op: AppOp,
  actor: Actor,
  answerTo: AnswerTo,
): void {
  const slice = steps.slice;
  switch (op.op) {
    case "backup.key": {
      backupKey(steps, ctx, answerTo, actor);
      return;
    }
    case "backup.status": {
      steps.answer(answerTo, {
        folder: slice.backup.folder,
        hour: hourOf(slice.backup, ctx),
        keep: keepOf(slice.backup, ctx),
        newestMs: slice.backup.newestMs,
        due: slice.backup.dueSinceMs !== null,
        lastResult: RESULT_NAMES[slice.backup.lastResult],
      });
      return;
    }
    case "backup.settings": {
      backupSettings(steps, ctx, answerTo, op.body);
      return;
    }
    case "backup.now": {
      if (slice.running !== undefined) {
        steps.answer(answerTo, { job: slice.running.job });
        return;
      }
      if (slice.backup.folder === null) {
        steps.refuse(answerTo, invalid("folder", "unknownReference"));
        return;
      }
      if (!canWrite(steps, ctx)) {
        steps.refuse(answerTo, UNAVAILABLE);
        return;
      }
      const job = startBackup(steps, ctx);
      if (job === undefined) steps.refuse(answerTo, UNAVAILABLE);
      else steps.answer(answerTo, { job });
      return;
    }
    case "backup.export": {
      const key = slice.key;
      const to = answerTo.kind === "schedule" ? undefined : answerTo.conn;
      if (to === undefined || key === undefined || !ctx.now.wallTrusted) {
        steps.refuse(answerTo, UNAVAILABLE);
        return;
      }
      const job = steps.job();
      steps.set({ ...steps.slice, exports: new Set([...steps.slice.exports, job]) });
      steps.answer(answerTo, { job });
      steps.push({
        kind: "fileJob",
        job,
        work: {
          kind: "export",
          conn: to,
          history: op.body.history,
          key: key.key,
          epoch: key.epoch,
        },
      });
      return;
    }
    case "restore.start": {
      restoreStart(steps, ctx, answerTo, op.body);
      return;
    }
    case "update.status": {
      updateStatus(steps, answerTo);
      return;
    }
    case "update.upload": {
      updateUpload(steps, answerTo, op.body);
      return;
    }
    case "update.approve": {
      updateApprove(steps, ctx, answerTo, actor);
      return;
    }
    case "update.cancel": {
      updateCancel(steps, answerTo);
      return;
    }
    default: {
      steps.fail({
        kind: "internal",
        origin: "core/upkeep",
        message: "an operation upkeep does not own",
        event: ctx.event,
        detail: { op: op.op },
      });
      return;
    }
  }
}

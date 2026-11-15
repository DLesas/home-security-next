/**
 * upkeep's rows, decisions and hub events (m2-design.md sections 3, 4 and 9). Every row is written
 * now as a full value: backup settings, the backup key, the update state and whether a backup is
 * due are "few and decisive" (section 3). The decisions are written now too: each is a warning or
 * a change of the hub people are told of (section 7). The two hub events are routine, as
 * `M2_HUB_EVENTS` has them.
 *
 * Each decision's `value` and `detail` (section 4 leaves them to their owner):
 *
 * | Kind | `value` | `detail`, UTF-8 |
 * | --- | --- | --- |
 * | `restored` | the file's `madeMs` | the file's hub identity, 26 characters |
 * | `update_staged` | — | the version |
 * | `update_switching` | — | the version switched to |
 * | `update_healthy` | — | the version now running |
 * | `update_rolled_back` | — | the version that failed |
 * | `backup_overdue` | `due_since_ms`: the first change the newest backup does not hold | the last failure's reason (`unreachable`, `full`, `io`), or `notTried` |
 * | `backup_no_folder` | — | — |
 * | `backup_key_replaced` | the new epoch | — |
 * | `backup_folder_on_data_disk` | — | the folder |
 *
 * And the hub events' `detail` (JSON): `backup_written` `{name, bytes, epoch}`; `backup_failed`
 * `{reason, message}`; `update_refused` `{reason, message}` (a release refused, or a switch without
 * the room for the database's copy). None ever holds the key.
 */
import type { Result } from "neverthrow";
import type { DecisionKind } from "../model/decisions.ts";
import { M2_HUB_EVENTS, type M2HubEventCode } from "../model/decisions.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { Seq } from "../model/ids.ts";
import type { Actor, Internal } from "../model/messages.ts";
import type { BackupKeyRow, BackupStateRow, UpdateStateRow } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import { decision } from "../util/records.ts";

const ORIGIN = "core/upkeep";
const encoder = new TextEncoder();

/**
 * `backup_state`, now by default (settings, the due mark set, the overdue warning, the restore
 * mark: section 3); a backup's result is routine (its newest file, its last result and attempt,
 * the due mark cleared), since losing it costs at most one more backup after a restart.
 */
export function writeBackupState(row: BackupStateRow, durability: Durability = "now"): Effect {
  return { kind: "write", durability, op: { table: "backup_state", op: "upsert", row } };
}

export function writeBackupKey(row: BackupKeyRow): Effect {
  return { kind: "write", durability: "now", op: { table: "backup_key", op: "upsert", row } };
}

export function writeUpdateState(row: UpdateStateRow): Effect {
  return { kind: "write", durability: "now", op: { table: "update_state", op: "upsert", row } };
}

/** One of upkeep's decisions, written now. */
export function upkeepDecision(
  ctx: Context,
  kind: DecisionKind,
  fields: { readonly value?: number; readonly detail?: string; readonly cause?: Seq },
): Result<Internal, CoreFault> {
  return decision(ctx, "now", {
    kind,
    device: null,
    cause: fields.cause ?? null,
    value: fields.value ?? null,
    detail: fields.detail === undefined ? null : encoder.encode(fields.detail),
  }).map((decided) => decided.message);
}

/** One of upkeep's hub events, at the level and class `M2_HUB_EVENTS` gives it. */
export function upkeepHubEvent(
  ctx: Context,
  code: Extract<M2HubEventCode, "backup_written" | "backup_failed" | "update_refused">,
  message: string,
  detail: Readonly<Record<string, string | number>>,
): Result<Internal, CoreFault> {
  const spec = M2_HUB_EVENTS[code];
  return ctx.records.take().map((seq): Internal => ({
    kind: "auditRecord",
    durability: spec.durability,
    record: {
      kind: "hubEvent",
      row: {
        seq,
        atMs: ctx.now.wall,
        clockOk: ctx.now.wallTrusted,
        level: spec.level,
        origin: ORIGIN,
        code,
        message,
        detail: JSON.stringify(detail),
      },
    },
  }));
}

/** The actor's text, as records name it (AL8). */
export function actorText(actor: Actor): string {
  switch (actor.kind) {
    case "computer":
      return actor.name;
    case "console":
      return `hub computer (client ${actor.client})`;
    case "person":
    case "schedule":
      return actor.name;
  }
}

/**
 * The relay module at a start (docs/m4-design.md section 4; HD 2, "Hub restart"): its state
 * rebuilt from migration 3's tables in the boot snapshot, nothing else.
 *
 * - The setting (`relay_settings`), the deployment's default relay (the boot input's
 *   `defaultRelayUrl`), the targets (`push_targets`; their keys are the `PushKeys` port's, loaded
 *   by the shell), and the outbox (`push_outbox`), each row joined with its notification from the
 *   snapshot's notifications of the last 7 days (M2's unread window); with the row's own `armed`
 *   and `facts`, that is everything its push says, so it says what it would have before the stop.
 * - Rows 7 days ‡ old or older are dropped now (`push_dropped`, `age`), not left for a deadline
 *   already due.
 * - A row whose notification is not in the snapshot is deleted and recorded (`push_dropped`,
 *   `age` when it is 7 days ‡ old or older, else `missing`); a row whose phone can no longer be
 *   pushed to (removed, or its target invalid or gone) is deleted. Rows that were in flight when
 *   the hub stopped wait for the link like the rest: their results died with the old link.
 * - Ids continue above the highest row's, so no two rows of the outbox share one.
 * - The link starts down, with an outage counted from now, when a relay is in use, and the shell
 *   is told which (`relayConnect`); with none nothing is emitted: the shell's client starts off.
 *
 * `people` and `registry` have handled the boot before relay (module order); `alarm`, `layout` and
 * `notify` have not, so nothing here reads them.
 */
import { type NotificationCategory, NOTIFICATION_CATEGORIES } from "@hsn/protocol/app";
import { EMPTY_M3M4_SNAPSHOT, type DurableSnapshot } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { ClientId, OutboxId } from "../model/ids.ts";
import type { NotificationRow, PushTargetRow } from "../model/rows.ts";
import { recipientOf } from "./content.ts";
import { startOutage } from "./link.ts";
import { expire, factsOf } from "./outbox.ts";
import type { Steps } from "./out.ts";
import { deleteOutbox, recordDropped } from "./records.ts";
import { DEFAULT_SETTINGS, EMPTY_RELAY_SLICE, type Notice, type Pending } from "./state.ts";
import { linkAtStart, urlOf } from "./settings.ts";

function isCategory(category: string): category is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
}

/** A stored notification as a push carries it; undefined for a category this version lacks. */
function noticeOfRow(row: NotificationRow): Notice | undefined {
  if (!isCategory(row.category)) return undefined;
  return {
    seq: row.seq,
    atMs: row.atMs,
    clockOk: row.clockOk,
    kind: row.kind,
    category: row.category,
    critical: row.critical,
    device: row.deviceId,
    cause: row.causeSeq,
  };
}

export function onBoot(
  steps: Steps,
  ctx: Context,
  snapshot: DurableSnapshot,
  defaultUrl: string | null,
): void {
  const m3m4 = snapshot.m3m4 ?? EMPTY_M3M4_SNAPSHOT;
  const settings = m3m4.relaySettings ?? DEFAULT_SETTINGS;
  const url = urlOf(settings, defaultUrl);
  const targets = new Map<ClientId, PushTargetRow>(
    m3m4.pushTargets.map((row) => [row.clientId, row]),
  );
  steps.set({
    ...EMPTY_RELAY_SLICE,
    settings,
    defaultUrl,
    targets,
    link: linkAtStart(url),
    nextId: Math.max(0, ...m3m4.pushOutbox.map((row) => row.id)) + 1,
  });

  const notices = new Map<number, Notice>();
  for (const row of snapshot.m2.notifications) {
    const notice = noticeOfRow(row);
    if (notice !== undefined) notices.set(row.seq, notice);
  }
  const outbox = new Map<OutboxId, Pending>();
  let old = 0;
  let missing = 0;
  for (const row of [...m3m4.pushOutbox].toSorted((a, b) => a.id - b.id)) {
    const notice = notices.get(row.notificationSeq);
    const deliverable = recipientOf(ctx.view, steps.slice, row.clientId) !== undefined;
    if (notice !== undefined && deliverable) {
      outbox.set(row.id, { row, notice, cause: factsOf(row.facts), inFlight: false });
      continue;
    }
    steps.push(deleteOutbox(row.id));
    if (notice !== undefined) continue;
    if (ctx.now.wall - row.createdMs >= ctx.deps.rules.relay.outboxMaxAgeMs) old += 1;
    else missing += 1;
  }
  steps.update((slice) => ({ ...slice, outbox }));
  recordDropped(steps, ctx, "age", old);
  recordDropped(steps, ctx, "missing", missing);
  expire(steps, ctx);

  if (url !== null) {
    steps.push({ kind: "relayConnect", url });
    startOutage(steps, ctx, undefined);
  }
}

/**
 * The relay module's handler (docs/m4-design.md sections 4, 5 and 9; hub-design.md section 2,
 * module 7, right after `people`). It acts on:
 *
 * - `boot`: its tables rebuilt (`boot.ts`);
 * - `relayLink`: the link's state and records (`link.ts`), the roster and the burst on return;
 * - `notificationRaised` (from `notify`, in a later turn of the same step): the outbox
 *   (`outbox.ts`);
 * - `pushResults`: the outbox's results;
 * - `clientRemoved` (from `people`): the phone's target, key and waiting pushes go;
 * - `armedChanged`: when whether any sensor is armed changes, the roster's alerts are made again
 *   (they carry `armed`, D96);
 * - `auditRecord`: the facts of the decisions a push names (`content.ts`), noted as they pass;
 * - `v2OpRequest` for `push.*` and `relay.*` (`ops.ts`);
 * - its five timers.
 *
 * With no relay in use and no phone registered it changes nothing and emits nothing, whatever the
 * message, but for noting those decisions.
 */
import { ok } from "neverthrow";
import { anySensorArmed } from "../alarm/view.ts";
import type { Context, Handler } from "../model/handler.ts";
import type { Internal } from "../model/messages.ts";
import { onBoot } from "./boot.ts";
import { onLinkRecordDue, onRelayLink, onUnreachableDue } from "./link.ts";
import { relayOp } from "./ops.ts";
import { expire, onRaised, onResults, onRetryDue } from "./outbox.ts";
import { Steps } from "./out.ts";
import { urlInUse } from "./settings.ts";
import type { CauseKind, RelaySlice } from "./state.ts";
import { sendRoster, unregister } from "./targets.ts";

/** The decisions whose facts a push's text names (`content.ts`). */
const CAUSE_KINDS: ReadonlySet<string> = new Set<CauseKind>([
  "countdown_started",
  "late_report_notification",
  "mode_switched",
]);

function isCauseKind(kind: string): kind is CauseKind {
  return CAUSE_KINDS.has(kind);
}

function onTimer(steps: Steps, ctx: Context, message: Extract<Internal, { kind: "timer" }>): void {
  const key = message.key;
  if (key.module !== "relay") return;
  steps.clear(key);
  switch (key.kind) {
    case "unreachable":
      onUnreachableDue(steps, ctx);
      return;
    case "linkRecord":
      onLinkRecordDue(steps, ctx);
      return;
    case "pushRetry":
      onRetryDue(steps, ctx, key.id);
      return;
    case "outboxExpiry":
      expire(steps, ctx);
      return;
    case "rosterRefresh":
      sendRoster(steps, ctx);
      return;
  }
}

/** Notes a decision's facts while it passes on its way to audit; the slice is kept when it is not one. */
function noteCause(
  slice: RelaySlice,
  message: Extract<Internal, { kind: "auditRecord" }>,
): RelaySlice {
  const { record } = message;
  if (urlInUse(slice) === null) return slice;
  if (record.kind !== "decision" || !isCauseKind(record.row.kind)) return slice;
  const facts = { seq: record.row.seq, kind: record.row.kind, value: record.row.value };
  return { ...slice, causes: new Map(slice.causes).set(facts.kind, facts) };
}

export const handleRelay: Handler<"relay"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "auditRecord":
      return ok({ slice: noteCause(slice, message), out: [] });
    case "armedChanged": {
      if (slice.link.kind !== "up" || slice.roster.armed === anySensorArmed(ctx.view)) {
        return ok({ slice, out: [] });
      }
      const steps = new Steps(slice);
      sendRoster(steps, ctx);
      return steps.done();
    }
    case "boot":
    case "relayLink":
    case "notificationRaised":
    case "pushResults":
    case "clientRemoved":
    case "v2OpRequest":
    case "timer":
      break;
    default:
      return ok({ slice, out: [] });
  }
  const steps = new Steps(slice);
  switch (message.kind) {
    case "boot":
      onBoot(steps, ctx, message.snapshot, message.boot.defaultRelayUrl ?? null);
      break;
    case "relayLink":
      onRelayLink(steps, ctx, message);
      break;
    case "notificationRaised":
      onRaised(steps, ctx, message.notification, message.clients);
      break;
    case "pushResults":
      onResults(steps, ctx, message.results);
      break;
    case "clientRemoved":
      unregister(steps, ctx, message.client, null, "removed");
      break;
    case "v2OpRequest":
      if (message.owner !== "relay") return ok({ slice, out: [] });
      relayOp(steps, ctx, message);
      break;
    case "timer":
      onTimer(steps, ctx, message);
      break;
  }
  return steps.done();
};

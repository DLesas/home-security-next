/**
 * The relay module's rows, decisions and hub events (docs/m4-design.md section 4, "Records" and
 * "New tables"; HD 5's durability classes).
 *
 * | Row | Class |
 * | --- | --- |
 * | `relay_settings`, `push_targets`, `push_keys` | now |
 * | `push_outbox`, inserted | its notification's: now when critical, else routine, so it rides on the commit its notification already makes and adds none of its own |
 * | `push_outbox`, its `attempts` moved, or deleted | routine |
 *
 * | Decision | `device_id` | `value` | `detail` | Class |
 * | --- | --- | --- | --- | --- |
 * | `push_registered`, `push_unregistered`, `push_target_invalid` | — | the client | — | now |
 *
 * A decision never carries the token, the key id or the key; the `commands` row of
 * `push.register` drops its `key` (`app`'s, M2 section 4).
 *
 * Hub events (detail JSON), at the level and class `M3M4_HUB_EVENTS` gives each:
 *
 * | Code | `detail` |
 * | --- | --- |
 * | `relay_link` | `{ups, downs, longestDownMs}` |
 * | `relay_unreachable` | `{reason}`: the link's last failure, or null |
 * | `relay_reachable` | `{downMs}`: how long it was down, or null when it began at the start |
 * | `relay_identity_in_use` | null |
 * | `push_dropped` | `{reason, rows}`: pushes deleted unsent, by why: `age` (7 days ‡ old), `burst` (past the newest 10 ‡ others of a phone when the link returned), `missing` (its notification not in the start's snapshot), `tooLong` (no content of 1,279 bytes could be made), `unregistered` (`push.unregister`), `removed` (its client or person removed), `invalid` (`badToken`) |
 */
import type { Result } from "neverthrow";
import { M3M4_HUB_EVENTS } from "../model/decisions.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { ClientId, OutboxId, Seq } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { PushOutboxRow, PushTargetRow, RelaySettingsRow } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import { decision } from "../util/records.ts";
import { ORIGIN, type Steps } from "./out.ts";

export function writeSettings(row: RelaySettingsRow): Effect {
  return { kind: "write", durability: "now", op: { table: "relay_settings", op: "upsert", row } };
}

export function writeTarget(row: PushTargetRow): Effect {
  return { kind: "write", durability: "now", op: { table: "push_targets", op: "upsert", row } };
}

export function deleteTarget(client: ClientId): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "push_targets", op: "delete", key: { clientId: client } },
  };
}

/** The key's row: written now, as `link_secrets`; its only other way out is `pushKey`. */
export function writeKey(client: ClientId, key: Uint8Array): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "push_keys", op: "upsert", row: { clientId: client, key } },
  };
}

export function deleteKey(client: ClientId): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "push_keys", op: "delete", key: { clientId: client } },
  };
}

export function writeOutbox(row: PushOutboxRow, durability: Durability): Effect {
  return { kind: "write", durability, op: { table: "push_outbox", op: "upsert", row } };
}

export function deleteOutbox(id: OutboxId): Effect {
  return {
    kind: "write",
    durability: "routine",
    op: { table: "push_outbox", op: "delete", key: { id } },
  };
}

export type PushDecision = "push_registered" | "push_unregistered" | "push_target_invalid";

/** One of relay's decisions about a phone's target: written now, naming only the client. */
export function pushDecision(
  ctx: Context,
  kind: PushDecision,
  client: ClientId,
  cause: Seq | null,
): Result<Internal, CoreFault> {
  return decision(ctx, "now", { kind, device: null, cause, value: client, detail: null }).map(
    (decided) => decided.message,
  );
}

export type RelayHubEvent = Extract<
  keyof typeof M3M4_HUB_EVENTS,
  "relay_link" | "relay_unreachable" | "relay_reachable" | "relay_identity_in_use" | "push_dropped"
>;

const MESSAGES: Readonly<Record<RelayHubEvent, string>> = {
  relay_link: "The relay link went up or down this hour.",
  relay_unreachable:
    "This hub cannot reach the relay: phones away from home get no alerts until it is back.",
  relay_reachable: "This hub reaches the relay again.",
  relay_identity_in_use:
    "Another computer is using this hub's identity on the relay: two hubs would both command the sirens.",
  push_dropped: "Pushes waiting for the relay were dropped unsent; they stay unread in the app.",
};

export type DroppedReason =
  "age" | "burst" | "missing" | "tooLong" | "unregistered" | "removed" | "invalid";

/** One of relay's hub events, at the level and class `M3M4_HUB_EVENTS` gives it. */
export function relayEvent(
  ctx: Context,
  code: RelayHubEvent,
  detail: Readonly<Record<string, string | number | null>> | null,
): Result<Internal, CoreFault> {
  const spec = M3M4_HUB_EVENTS[code];
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
        message: MESSAGES[code],
        detail: detail === null ? null : JSON.stringify(detail),
      },
    },
  }));
}

/** Records one `push_dropped` for `rows` rows dropped for one reason. */
export function recordDropped(
  steps: Steps,
  ctx: Context,
  reason: DroppedReason,
  rows: number,
): void {
  if (rows > 0) steps.pushResult(relayEvent(ctx, "push_dropped", { reason, rows }));
}

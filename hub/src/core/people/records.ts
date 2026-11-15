/**
 * The people module's rows and decisions (m2-design.md sections 3 and 4). Every row is written
 * now as a full value, but a client's `last_seen_ms`, which is routine; the decisions
 * (`person_added`, `person_removed`, `client_linked`, `client_removed`, `permissions_changed`,
 * `user_management_changed`) are written now with the change.
 *
 * Each decision's `value` and `detail` (section 4 leaves them to their owner):
 *
 * | Kind | `device` | `value` | `detail`, UTF-8 JSON |
 * | --- | --- | --- | --- |
 * | `person_added` | null | the person | `{name, by}` |
 * | `person_removed` | null | the person | `{name, by}` |
 * | `client_linked` | null | the client | `{person, kind, name, linkedBy, token}` |
 * | `client_removed` | null | the client | `{person, name, by}` |
 * | `person_renamed` | null | the person | `{from, to, by}`: the old and the new name |
 * | `client_renamed` | null | the client | `{from, to, by}` |
 * | `permissions_changed` | null | the person | `{by}` |
 * | `user_management_changed` | null | 1 on, 0 off | `{by}` |
 *
 * `by` is the actor's text (AL8: who caused it); `cause` is the request's `commands` record.
 */
import type { Result } from "neverthrow";
import type { DecisionKind } from "../model/decisions.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { Seq } from "../model/ids.ts";
import type { Actor, Internal } from "../model/messages.ts";
import type { StoreOp } from "../model/store.ts";
import { decision } from "../util/records.ts";

/** A write committed before anything that depends on it is sent or answered (section 3). */
export function writeNow(op: StoreOp): Effect {
  return { kind: "write", durability: "now", op };
}

export function writeRoutine(op: StoreOp): Effect {
  return { kind: "write", durability: "routine", op };
}

/** The actor's text, as records name it (AL8; section 4, `commands.actor`). */
export function actorText(actor: Actor): string {
  switch (actor.kind) {
    case "computer":
      return actor.name;
    case "console":
      return `hub computer (client ${actor.client})`;
    case "person":
      return actor.name;
    case "schedule":
      return actor.name;
  }
}

const encoder = new TextEncoder();

/** One of people's decisions, written now (section 4). */
export function peopleDecision(
  ctx: Context,
  kind: DecisionKind,
  value: number,
  detail: Readonly<Record<string, string | number | null>>,
  cause: Seq | null,
): Result<Internal, CoreFault> {
  return decision(ctx, "now", {
    kind,
    device: null,
    cause,
    value,
    detail: encoder.encode(JSON.stringify(detail)),
  }).map((decided) => decided.message);
}

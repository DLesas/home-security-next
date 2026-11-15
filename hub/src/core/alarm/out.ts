/**
 * What the alarm module emits besides its slice (hub-design.md sections 5 and 6): decision
 * records, which go to the audit module as `auditRecord` messages, and writes of its own tables.
 * The decision builder itself is the core's one (core/util/records.ts).
 */
import { ok, type Result } from "neverthrow";
import type { Context } from "../model/handler.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Actor, Internal } from "../model/messages.ts";
import type { Durability, StoreOp } from "../model/store.ts";
import { type Decided, type DecisionFields, decision } from "../util/records.ts";
import type { AlarmSlice } from "./state.ts";

/** What a handler of this module emits, in order. */
export type Out = readonly (Internal | Effect)[];

/** The slice after one change, and what the change emitted. */
export interface Changed {
  readonly slice: AlarmSlice;
  readonly out: Out;
}

/** A change, or the step's `CoreFault`. */
export type Changing = Result<Changed, CoreFault>;

/** No change: the slice as it is, nothing emitted. */
export function unchanged(slice: AlarmSlice): Changing {
  return ok({ slice, out: [] });
}

/** `first`, then `next` on its slice, with both outputs in order. */
export function then(first: Changing, next: (slice: AlarmSlice) => Changing): Changing {
  return first.andThen((a) =>
    next(a.slice).map((b) => ({ slice: b.slice, out: [...a.out, ...b.out] })),
  );
}

/** `change` applied to each item in turn, starting from `slice`. */
export function each<T>(
  slice: AlarmSlice,
  items: Iterable<T>,
  change: (slice: AlarmSlice, item: T) => Changing,
): Changing {
  let result = unchanged(slice);
  for (const item of items) result = then(result, (current) => change(current, item));
  return result;
}

export { actorDetail, type Decided, type DecisionFields } from "../util/records.ts";

/** The console's text in records: it acts as the hub computer (m2-design.md section 7). */
export const CONSOLE_ACTOR = "hub computer";

/**
 * Who or what asked, as the decisions it causes name it (AL8): the hub computer's user name, the
 * console as the hub computer, a person as `commands.actor` holds them (`"Anna (client 7)"`,
 * m2-design.md section 4), a schedule entry as "schedule <name>" (section 7, "Running").
 */
export function actorText(actor: Actor): string {
  switch (actor.kind) {
    case "computer":
    case "person":
      return actor.name;
    case "console":
      return CONSOLE_ACTOR;
    case "schedule":
      return `schedule ${actor.name}`;
  }
}

/** A decision record (D110), through the core's one builder (core/util/records.ts). */
export function decide(
  ctx: Context,
  durability: Durability,
  fields: DecisionFields,
): Result<Decided, CoreFault> {
  return decision(ctx, durability, fields);
}

/** A write committed at once (section 5: countdowns, the alarm, armed state). */
export function writeNow(op: StoreOp): Effect {
  return { kind: "write", durability: "now", op };
}

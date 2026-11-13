/**
 * What the sirens module emits besides its slice (hub-design.md sections 5 and 6): decision
 * records for the audit module, `tx` records, and writes of its own rows.
 * Decisions go through the core's one builder (core/util/records.ts).
 */
import { err, ok, type Result } from "neverthrow";
import type { DecisionKind } from "../model/decisions.ts";
import type { Effect } from "../model/effects.ts";
import { type CoreFault, coreFault, type HubError } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId, Seq } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { TxRow } from "../model/rows.ts";
import type { Durability, StoreOp } from "../model/store.ts";
import {
  MICROS_PER_MILLISECOND,
  MILLISECONDS_PER_SECOND,
  type Mono,
  monoAfterMs,
} from "../model/time.ts";
import { decision } from "../util/records.ts";
import type { SirensSlice } from "./state.ts";

const ORIGIN = "core/sirens";

/** What a handler of this module emits, in order. */
export type Out = readonly (Internal | Effect)[];

/** The slice after one change, and what the change emitted. */
export interface Changed {
  readonly slice: SirensSlice;
  readonly out: Out;
}

/** A change, or the step's `CoreFault`. */
export type Changing = Result<Changed, CoreFault>;

/** No change: the slice as it is, nothing emitted. */
export function unchanged(slice: SirensSlice): Changing {
  return ok({ slice, out: [] });
}

/** `first`, then `next` on its slice, with both outputs in order. */
export function then(first: Changing, next: (slice: SirensSlice) => Changing): Changing {
  return first.andThen((a) =>
    next(a.slice).map((b) => ({ slice: b.slice, out: [...a.out, ...b.out] })),
  );
}

/** `change` applied to each item in turn. */
export function each<T>(
  slice: SirensSlice,
  items: Iterable<T>,
  change: (slice: SirensSlice, item: T) => Changing,
): Changing {
  let result = unchanged(slice);
  for (const item of items) result = then(result, (current) => change(current, item));
  return result;
}

/** A `HubError` from the cipher or the protocol as this step's `CoreFault` (section 10). */
export function fault(ctx: Context, error: HubError | string): CoreFault {
  const message = typeof error === "string" ? error : error.message;
  return coreFault(ctx.event, ORIGIN, message);
}

/** The protocol package's result as this step's result. */
export function fromProtocolResult<T>(
  ctx: Context,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string } },
): Result<T, CoreFault> {
  return result.ok ? ok(result.value) : err(fault(ctx, `protocol error: ${result.error.code}`));
}

/** A decision record (D110), "now" for warnings and worse (section 5), by the core's one builder. */
export function decide(
  ctx: Context,
  durability: Durability,
  kind: DecisionKind,
  device: DeviceId,
  cause: Seq | undefined,
  value?: number,
): Result<Internal, CoreFault> {
  return decision(ctx, durability, { kind, device, cause, value: value ?? null }).map(
    (decided) => decided.message,
  );
}

/** A packet sent to a siren, one row per transmission, in `tx_event` (section 6), routine. */
export function txRecord(
  ctx: Context,
  row: Omit<TxRow, "seq" | "atMs" | "clockOk">,
): Result<Internal, CoreFault> {
  return ctx.records.take().map((seq) => ({
    kind: "auditRecord",
    durability: "routine",
    record: {
      kind: "tx",
      table: "event",
      row: { ...row, seq, atMs: ctx.now.wall, clockOk: ctx.now.wallTrusted },
    },
  }));
}

/** A write committed at once (section 5: settings, resume points). */
export function writeNow(op: StoreOp): Effect {
  return { kind: "write", durability: "now", op };
}

/** Microseconds in a second. */
export const MICROS_PER_SECOND = MICROS_PER_MILLISECOND * MILLISECONDS_PER_SECOND;

/** The instant `ms` milliseconds after `at`. */
export function after(at: Mono, ms: number): Mono {
  return monoAfterMs(at, ms);
}

/** Whole seconds from `now` until `at`, rounded up, and 0 once it has passed. */
export function secondsUntil(now: Mono, at: Mono): number {
  return Math.max(0, Math.ceil((at - now) / MICROS_PER_SECOND));
}

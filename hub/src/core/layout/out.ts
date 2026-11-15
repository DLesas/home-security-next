/**
 * What the layout module's handlers emit besides its slice (hub-design.md sections 2 and 5): its
 * rows, written now (m2-design.md section 3: configuration and the current mode are "now"), and
 * the answers to the operations it owns.
 */
import { ok, type Result } from "neverthrow";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { AnswerTo, DomainMessage, Internal, OpOutcome } from "../model/messages.ts";
import type { StoreOp } from "../model/store.ts";
import type { LayoutSlice } from "./state.ts";

export type Out = readonly (Internal | Effect)[];

export interface Changed {
  readonly slice: LayoutSlice;
  readonly out: Out;
}

export type Changing = Result<Changed, CoreFault>;

export type Message<K extends DomainMessage["kind"]> = Extract<DomainMessage, { readonly kind: K }>;

export function unchanged(slice: LayoutSlice): Changing {
  return ok({ slice, out: [] });
}

export function writeNow(op: StoreOp): Effect {
  return { kind: "write", durability: "now", op };
}

/** An operation's answer, to whoever asked: app, control or a schedule. */
export function answered(answerTo: AnswerTo, outcome: OpOutcome): Out {
  return [{ kind: "opAnswer", answerTo, outcome }];
}

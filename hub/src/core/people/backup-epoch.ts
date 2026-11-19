/**
 * Which phone holds which backup key epoch (m2-design.md section 3: "now, when made, replaced or
 * given"; section 9; m3-design section 4, the fix of M2's fault): `people` writes
 * `clients.backup_key_epoch` when a phone is given the key in its `LinkResult` (D78, D99), and when
 * the phone confirms it has written a key with `backup.keyHeld {epoch}` (`upkeep`'s operation,
 * which accepts only the current epoch and answers `{}`). Answering `backup.key` records nothing,
 * so a phone that lost that reply is never taken to hold a key it does not have. The key never
 * enters this slice, a row of people's or a record.
 */
import type { Effect } from "../model/effects.ts";
import type { ClientId } from "../model/ids.ts";
import type { AnswerTo, Internal, OpOutcome } from "../model/messages.ts";
import type { ClientRow } from "../model/rows.ts";
import { withClient } from "./ops.ts";
import { writeNow } from "./records.ts";
import type { PeopleSlice } from "./state.ts";

/** An operation for its owner, as `app` sends it (version 2's rows may come as `v2OpRequest`). */
type OpRequest = Extract<Internal, { readonly kind: "opRequest" | "v2OpRequest" }>;

function keyOf(answerTo: AnswerTo): string | undefined {
  return answerTo.kind === "app" ? `${answerTo.conn}:${answerTo.id}` : undefined;
}

/** A phone's `backup.keyHeld` on its way to `upkeep`: noted with its epoch, for the answer. */
export function keyAsked(slice: PeopleSlice, request: OpRequest): PeopleSlice {
  const key = keyOf(request.answerTo);
  if (request.op.op !== "backup.keyHeld" || key === undefined || request.answerTo.kind !== "app")
    return slice;
  const keyAsks = new Map(slice.keyAsks);
  keyAsks.set(key, { client: request.answerTo.client, epoch: request.op.body.epoch });
  return { ...slice, keyAsks };
}

/** A client now holds `epoch`: its row, written now. */
export function holdsEpoch(
  slice: PeopleSlice,
  client: ClientId,
  epoch: number,
): { readonly slice: PeopleSlice; readonly out: readonly Effect[] } {
  const row = slice.clients.get(client);
  if (row === undefined || row.backupKeyEpoch === epoch) return { slice, out: [] };
  const held: ClientRow = { ...row, backupKeyEpoch: epoch };
  return {
    slice: withClient(slice, held),
    out: [writeNow({ table: "clients", op: "upsert", row: held })],
  };
}

/** `backup.keyHeld`'s answer: accepted, the phone holds the epoch it named; refused, nothing. */
export function keyAnswered(
  slice: PeopleSlice,
  answerTo: AnswerTo,
  outcome: OpOutcome,
): { readonly slice: PeopleSlice; readonly out: readonly Effect[] } {
  const key = keyOf(answerTo);
  const asked = key === undefined ? undefined : slice.keyAsks.get(key);
  if (key === undefined || asked === undefined) return { slice, out: [] };
  const keyAsks = new Map(slice.keyAsks);
  keyAsks.delete(key);
  const next = { ...slice, keyAsks };
  return outcome.ok ? holdsEpoch(next, asked.client, asked.epoch) : { slice: next, out: [] };
}

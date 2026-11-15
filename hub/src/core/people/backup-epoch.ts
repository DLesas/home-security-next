/**
 * Which phone holds which backup key epoch (m2-design.md section 3: "now, when made, replaced or
 * given"; section 9; section 11, "Step 1, wave 2"): `people` writes `clients.backup_key_epoch` when
 * a phone is given the key, in its `LinkResult` (D78, D99) or when it fetches it with `backup.key`
 * (`upkeep`'s operation, answered `{key, epoch}`). Only the epoch is read from the answer; the key
 * never enters this slice, a row of people's or a record.
 */
import type { Effect } from "../model/effects.ts";
import type { ClientId } from "../model/ids.ts";
import type { AnswerTo, Internal, OpOutcome } from "../model/messages.ts";
import type { ClientRow } from "../model/rows.ts";
import { withClient } from "./ops.ts";
import { writeNow } from "./records.ts";
import type { PeopleSlice } from "./state.ts";

type OpRequest = Extract<Internal, { readonly kind: "opRequest" }>;

function keyOf(answerTo: AnswerTo): string | undefined {
  return answerTo.kind === "app" ? `${answerTo.conn}:${answerTo.id}` : undefined;
}

/** A phone's `backup.key` on its way to `upkeep`: noted, so its answer's epoch can be kept. */
export function keyAsked(slice: PeopleSlice, request: OpRequest): PeopleSlice {
  const key = keyOf(request.answerTo);
  if (request.op.op !== "backup.key" || key === undefined || request.answerTo.kind !== "app")
    return slice;
  const keyAsks = new Map(slice.keyAsks);
  keyAsks.set(key, request.answerTo.client);
  return { ...slice, keyAsks };
}

function epochOf(outcome: OpOutcome): number | undefined {
  if (!outcome.ok || typeof outcome.body !== "object" || outcome.body === null) return undefined;
  const epoch: unknown = (outcome.body as { readonly epoch?: unknown }).epoch;
  return typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 ? epoch : undefined;
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

/** `backup.key`'s answer: on success, the phone holds its epoch. */
export function keyAnswered(
  slice: PeopleSlice,
  answerTo: AnswerTo,
  outcome: OpOutcome,
): { readonly slice: PeopleSlice; readonly out: readonly Effect[] } {
  const key = keyOf(answerTo);
  const client = key === undefined ? undefined : slice.keyAsks.get(key);
  if (key === undefined || client === undefined) return { slice, out: [] };
  const keyAsks = new Map(slice.keyAsks);
  keyAsks.delete(key);
  const next = { ...slice, keyAsks };
  const epoch = epochOf(outcome);
  return epoch === undefined ? { slice: next, out: [] } : holdsEpoch(next, client, epoch);
}

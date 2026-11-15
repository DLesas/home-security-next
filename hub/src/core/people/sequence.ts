/**
 * Each client's last `seq` and the replies of its last changes (m2-design.md section 5, "`seq`
 * gives every change exactly one effect"; section 3). `app` decides whether a `seq` is new; people,
 * who owns the `clients` row, writes it:
 *
 * - when a change with a new `seq` goes to its owner (an `opRequest`, or an M1a module's own
 *   request numbered by `app`), the client's new last `seq` is written now, in the request's own
 *   step, with its reply held as pending;
 * - when the change is answered (`opAnswer`, in that step or a later one), the reply is written now
 *   in that step's commit, the one `app`'s reply waits for, and the oldest beyond the last 16 ‡
 *   are deleted in the same commit.
 *
 * A pending reply is not written: after a restart its `seq` is one with no reply kept.
 */
import type { Effect } from "../model/effects.ts";
import type { ClientId } from "../model/ids.ts";
import type { AnswerTo, OpOutcome } from "../model/messages.ts";
import type { ClientRow } from "../model/rows.ts";
import { encodeReply, replyOf } from "./replies.ts";
import { writeNow } from "./records.ts";
import type { PeopleSlice, StoredReply } from "./state.ts";

interface Recorded {
  readonly slice: PeopleSlice;
  readonly out: readonly Effect[];
}

function withReplies(
  slice: PeopleSlice,
  client: ClientId,
  replies: ReadonlyMap<number, StoredReply>,
): PeopleSlice {
  const all = new Map(slice.replies);
  all.set(client, replies);
  return { ...slice, replies: all };
}

function withLastSeq(slice: PeopleSlice, row: ClientRow, seq: number): PeopleSlice {
  const clients = new Map(slice.clients);
  clients.set(row.id, { ...row, lastSeq: seq });
  return { ...slice, clients };
}

/** The client and `seq` a request's answer goes to, when it is a change from an app. */
function changeOf(
  answerTo: AnswerTo,
): { readonly client: ClientId; readonly seq: number } | undefined {
  return answerTo.kind === "app" && answerTo.seq !== undefined
    ? { client: answerTo.client, seq: answerTo.seq }
    : undefined;
}

/**
 * A change with a new `seq` has gone to its owner: its `seq` is written, its reply pending. `app`
 * refuses a `seq` at or below the last first (`app/handle.ts`, `onRequest`); this is a second
 * guard, so a request that reached an owner another way could never move `last_seq` back or mark
 * a kept reply pending again.
 */
export function changeSent(slice: PeopleSlice, client: ClientId, seq: number): Recorded {
  const row = slice.clients.get(client);
  if (row === undefined || seq <= row.lastSeq) return { slice, out: [] };
  const replies = new Map(slice.replies.get(client));
  replies.set(seq, { kind: "pending" });
  const next = withReplies(withLastSeq(slice, row, seq), client, replies);
  const written = next.clients.get(client);
  return {
    slice: next,
    out: written === undefined ? [] : [writeNow({ table: "clients", op: "upsert", row: written })],
  };
}

export function changeSentTo(slice: PeopleSlice, answerTo: AnswerTo): Recorded {
  const change = changeOf(answerTo);
  return change === undefined ? { slice, out: [] } : changeSent(slice, change.client, change.seq);
}

/** A change was answered: its reply is kept, and only the last `keep` of the client's. */
export function changeAnswered(
  slice: PeopleSlice,
  answerTo: AnswerTo,
  outcome: OpOutcome,
  keep: number,
): Recorded {
  const change = changeOf(answerTo);
  if (change === undefined || answerTo.kind !== "app") return { slice, out: [] };
  const row = slice.clients.get(change.client);
  if (row === undefined) return { slice, out: [] };
  const out: Effect[] = [];
  let next = slice;
  if (change.seq > row.lastSeq) {
    next = withLastSeq(next, row, change.seq);
    const written = next.clients.get(change.client);
    if (written !== undefined) out.push(writeNow({ table: "clients", op: "upsert", row: written }));
  } else if (next.replies.get(change.client)?.get(change.seq) === undefined) {
    // An old `seq` with no reply kept is answered `seqTooLow` by `app`, and never comes here.
    return { slice, out: [] };
  }
  const reply = replyOf(answerTo.id, outcome);
  const replies = new Map(next.replies.get(change.client));
  replies.set(change.seq, { kind: "sent", reply });
  out.push(
    writeNow({
      table: "client_replies",
      op: "upsert",
      row: { clientId: change.client, seq: change.seq, reply: encodeReply(reply) },
    }),
  );
  const seqs = [...replies.keys()].toSorted((a, b) => b - a);
  for (const old of seqs.slice(keep)) {
    const dropped = replies.get(old);
    replies.delete(old);
    if (dropped?.kind === "sent")
      out.push(
        writeNow({
          table: "client_replies",
          op: "delete",
          key: { clientId: change.client, seq: old },
        }),
      );
  }
  return { slice: withReplies(next, change.client, replies), out };
}

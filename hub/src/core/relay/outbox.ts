/**
 * The push outbox (docs/m4-design.md section 4, "The outbox (D102)"; QR8).
 *
 * - **Raising.** On `notificationRaised`, each of its clients that is a live phone with a valid
 *   target gets a row (the clients are the ones `notify` let through by category and each person's
 *   choices: this module does not decide them again). A notification told only to open sessions
 *   (`relay_unreachable`) gets none, and nothing is kept while no relay is in use. The row is
 *   written in its notification's class: now when critical, routine otherwise, so it rides on the
 *   commit the notification already makes. With the link up it is sent at once (`pushSend`),
 *   counted as its first attempt in the same write.
 * - **Results.** `accepted` deletes the row (routine). `badToken` marks the phone's target invalid
 *   and deletes all its rows (`targets.ts`). `limited` and `failed` try the row again after
 *   `retryAfterMs` (1, 5, 15 minutes ‡) by its attempts, then every `retryEveryMs` (15 minutes ‡),
 *   for as long as it is not too old. A result for a row no longer waiting is ignored, but an
 *   `accepted` or `badToken` for any row still kept is taken (a push known delivered is not sent
 *   again when the link returns).
 * - **The link lost.** Nothing is in flight any more; retries wait for the link.
 * - **The link back** (the burst): every row waiting is sent in order, but per phone only every
 *   critical one and the newest `burstOthersPerPhone` (10 ‡) others; the rest are deleted unsent
 *   and recorded as dropped (`push_dropped`, `burst`): they stay unread in the app (M2's unread
 *   notifications of the last 7 days).
 * - **Too old.** A row `outboxMaxAgeMs` (7 days ‡) old or older is deleted unsent and recorded
 *   (`push_dropped`, `age`); the `outboxExpiry` timer is set for the oldest row.
 * - **Delivery is at least once.** A row's delete is routine, so a power cut after `accepted` and
 *   before the next commit sends it again after the restart, with the same `n.seq`; the phone
 *   drops a repeat by its hub and `seq` (section 4).
 */
import type { NotificationObject, PushOutcome } from "@hsn/protocol/app";
import { anySensorArmed } from "../alarm/view.ts";
import type { Context } from "../model/handler.ts";
import { type ClientId, type OutboxId, outboxId, seq } from "../model/ids.ts";
import type { Durability } from "../model/store.ts";
import { monoAfterMs } from "../model/time.ts";
import { NEVER_PUSHED, noticeOf, pushFor, recipientOf } from "./content.ts";
import type { Steps } from "./out.ts";
import { deleteOutbox, recordDropped, writeOutbox } from "./records.ts";
import type { CauseFacts, Pending } from "./state.ts";
import { urlInUse } from "./settings.ts";
import { invalidate } from "./targets.ts";

function putPending(steps: Steps, pending: Pending): void {
  steps.update((slice) => ({
    ...slice,
    outbox: new Map(slice.outbox).set(pending.row.id, pending),
  }));
}

function removePending(steps: Steps, id: OutboxId): void {
  const outbox = new Map(steps.slice.outbox);
  outbox.delete(id);
  steps.update((slice) => ({ ...slice, outbox }));
  steps.clear({ module: "relay", kind: "pushRetry", id });
}

/**
 * Sends one row now, counting the attempt in its row: written with `insert`'s class when the row
 * is new, routine otherwise. A row whose phone can no longer be pushed to, or whose recipient may
 * no longer see it, goes unsent; one with no content that fits is dropped and recorded.
 */
function dispatch(
  steps: Steps,
  ctx: Context,
  pending: Pending,
  insert: Durability | undefined,
): void {
  const built = pushFor(ctx.view, ctx.deps, ctx.now, steps.slice, pending);
  if (!built.ok) {
    if (built.why === "noIdentity") {
      if (insert !== undefined) steps.push(writeOutbox(pending.row, insert));
      putPending(steps, pending);
      return;
    }
    removePending(steps, pending.row.id);
    if (insert === undefined) steps.push(deleteOutbox(pending.row.id));
    if (built.why === "tooLong") recordDropped(steps, ctx, "tooLong", 1);
    return;
  }
  const row = { ...pending.row, attempts: pending.row.attempts + 1 };
  putPending(steps, { ...pending, row, inFlight: true });
  steps.push(writeOutbox(row, insert ?? "routine"), {
    kind: "pushSend",
    id: row.id,
    client: row.clientId,
    content: built.content,
  });
}

/** The outbox's next id. */
export function takeId(steps: Steps): OutboxId {
  const id = outboxId(steps.slice.nextId);
  steps.update((slice) => ({ ...slice, nextId: slice.nextId + 1 }));
  return id;
}

/** `notificationRaised`: a row for each phone it goes to, sent at once when the link is up. */
export function onRaised(
  steps: Steps,
  ctx: Context,
  notification: NotificationObject,
  clients: readonly ClientId[],
): void {
  if (urlInUse(steps.slice) === null || NEVER_PUSHED.has(notification.kind)) return;
  const notice = noticeOf(notification);
  const cause =
    notice.cause === null
      ? undefined
      : [...steps.slice.causes.values()].find((facts) => facts.seq === notice.cause);
  const durability: Durability = notice.critical ? "now" : "routine";
  const armed = anySensorArmed(ctx.view) ? 1 : 0;
  const facts = cause === undefined ? null : JSON.stringify(cause);
  for (const client of new Set(clients)) {
    if (recipientOf(ctx.view, steps.slice, client) === undefined) continue;
    const pending: Pending = {
      row: {
        id: takeId(steps),
        notificationSeq: seq(notice.seq),
        clientId: client,
        createdMs: ctx.now.wall,
        attempts: 0,
        armed,
        facts,
      },
      notice,
      cause,
      inFlight: false,
    };
    if (steps.slice.link.kind === "up") {
      dispatch(steps, ctx, pending, durability);
    } else {
      putPending(steps, pending);
      steps.push(writeOutbox(pending.row, durability));
    }
  }
  expire(steps, ctx);
}

/** The link is lost: nothing is in flight, retries and test pushes wait for nothing. */
export function onLinkLost(steps: Steps): void {
  const outbox = new Map(
    [...steps.slice.outbox].map(([id, pending]) => [id, { ...pending, inFlight: false }]),
  );
  steps.update((slice) => ({ ...slice, outbox, tests: new Map() }));
  steps.clearKind("pushRetry");
}

/** The rows of one phone a burst sends: every critical one and the newest `others` others. */
export function burstChoice(rows: readonly Pending[], others: number): ReadonlySet<OutboxId> {
  const ordinary = rows.filter((pending) => !pending.notice.critical);
  const kept = ordinary.toSorted((a, b) => b.row.id - a.row.id).slice(0, others);
  return new Set([
    ...rows.filter((pending) => pending.notice.critical).map((pending) => pending.row.id),
    ...kept.map((pending) => pending.row.id),
  ]);
}

/** The link is back: what waits goes, as `burstChoice` picks it per phone, in order. */
export function onLinkBack(steps: Steps, ctx: Context): void {
  expire(steps, ctx);
  const byClient = new Map<ClientId, Pending[]>();
  for (const pending of steps.slice.outbox.values()) {
    const rows = byClient.get(pending.row.clientId) ?? [];
    rows.push(pending);
    byClient.set(pending.row.clientId, rows);
  }
  const chosen = new Set<OutboxId>();
  for (const rows of byClient.values()) {
    for (const id of burstChoice(rows, ctx.deps.rules.relay.burstOthersPerPhone)) chosen.add(id);
  }
  let dropped = 0;
  for (const pending of [...steps.slice.outbox.values()].toSorted((a, b) => a.row.id - b.row.id)) {
    if (chosen.has(pending.row.id)) {
      dispatch(steps, ctx, pending, undefined);
    } else {
      removePending(steps, pending.row.id);
      steps.push(deleteOutbox(pending.row.id));
      dropped += 1;
    }
  }
  recordDropped(steps, ctx, "burst", dropped);
  expire(steps, ctx);
}

/** The wait before a row is tried again, after `attempts` sends. */
export function retryDelayMs(ctx: Context, attempts: number): number {
  const rules = ctx.deps.rules.relay;
  return rules.retryAfterMs[attempts - 1] ?? rules.retryEveryMs;
}

/** `pushResults`: by row, as the module's comment says. */
export function onResults(
  steps: Steps,
  ctx: Context,
  results: readonly { readonly id: OutboxId; readonly outcome: PushOutcome }[],
): void {
  for (const { id, outcome } of results) {
    const tester = steps.slice.tests.get(id);
    if (tester !== undefined) {
      const tests = new Map(steps.slice.tests);
      tests.delete(id);
      steps.update((slice) => ({ ...slice, tests }));
      if (outcome === "badToken") invalidate(steps, ctx, tester);
      continue;
    }
    const pending = steps.slice.outbox.get(id);
    if (pending === undefined) continue;
    switch (outcome) {
      case "accepted":
        removePending(steps, id);
        steps.push(deleteOutbox(id));
        break;
      case "badToken":
        invalidate(steps, ctx, pending.row.clientId);
        break;
      case "limited":
      case "failed":
        if (!pending.inFlight) break;
        putPending(steps, { ...pending, inFlight: false });
        steps.timer(
          { module: "relay", kind: "pushRetry", id },
          monoAfterMs(ctx.now.mono, retryDelayMs(ctx, pending.row.attempts)),
        );
        break;
    }
  }
  expire(steps, ctx);
}

/** A row's retry is due: sent again if the link is up (else it goes when the link returns). */
export function onRetryDue(steps: Steps, ctx: Context, id: OutboxId): void {
  const pending = steps.slice.outbox.get(id);
  if (pending === undefined || pending.inFlight || steps.slice.link.kind !== "up") return;
  dispatch(steps, ctx, pending, undefined);
}

/**
 * Deletes and records every row `outboxMaxAgeMs` (7 days ‡) old or older, and sets the expiry
 * timer for the moment the oldest row left reaches that age, by the same comparison, so the
 * timer is always after now: a row it finds old enough is dropped, never waited for.
 */
export function expire(steps: Steps, ctx: Context): void {
  const key = { module: "relay", kind: "outboxExpiry" } as const;
  const maxAge = ctx.deps.rules.relay.outboxMaxAgeMs;
  let dropped = 0;
  let soonestMs: number | undefined;
  for (const pending of [...steps.slice.outbox.values()]) {
    const age = ctx.now.wall - pending.row.createdMs;
    if (age < maxAge) {
      soonestMs = Math.min(soonestMs ?? Infinity, maxAge - age);
      continue;
    }
    removePending(steps, pending.row.id);
    steps.push(deleteOutbox(pending.row.id));
    dropped += 1;
  }
  recordDropped(steps, ctx, "age", dropped);
  if (soonestMs === undefined) {
    steps.clear(key);
    return;
  }
  const at = monoAfterMs(ctx.now.mono, soonestMs);
  if (steps.timerAt(key) !== at) steps.timer(key, at);
}

/**
 * A row's `facts` as this module writes them: `JSON.stringify` of `CauseFacts`, keys in that
 * order, whole numbers. Read back by that form alone (no `JSON.parse`, which throws), so a value
 * not written here is undefined: the push then says no decision facts.
 */
const FACTS =
  /^\{"seq":(\d{1,16}),"kind":"(countdown_started|late_report_notification|mode_switched)","value":(-?\d{1,16}|null)\}$/u;

/** A row's `facts` read back: the decision's facts, or undefined for none or a form not ours. */
export function factsOf(text: string | null): CauseFacts | undefined {
  const match = text === null ? null : FACTS.exec(text);
  if (match === null) return undefined;
  const [, number = "", kind = "", value = "null"] = match;
  if (
    kind !== "countdown_started" &&
    kind !== "late_report_notification" &&
    kind !== "mode_switched"
  )
    return undefined;
  return { seq: seq(Number(number)), kind, value: value === "null" ? null : Number(value) };
}

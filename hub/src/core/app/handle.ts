/**
 * The app module's handler (m2-design.md section 2, module 8): sessions, request routing with the
 * permission checks and the `seq` rule, the answers turned into replies, and the live events.
 *
 * **A request** (`clientRequest`, authenticated and schema-checked by the shell, section 2):
 *
 * 1. Its session and client: a client that is not linked, removed, or whose person is removed is
 *    refused `unauthorized` and its sessions closed (section 7, "Awkward cases").
 * 2. A change's `seq` (section 5): above the client's last, it goes on; at or below, the reply kept
 *    for it is sent again marked `repeat` and nothing is done, or, while that reply is pending, it
 *    is answered when it comes; any other is `seqTooLow {last}`.
 * 3. Who may (`checks.ts`), on the hub, from the client's own record.
 * 4. Its owner (`OP_OWNERS`): `app` answers its own; an M2 module gets an `opRequest` with the
 *    person as actor; an M1a module its own request message, numbered from 2⁴⁰ (`m1a.ts`).
 * 5. The answer (`opAnswer`, or an M1a module's `answer`) becomes the reply. A change's reply,
 *    its `commands` record and the client's new last `seq` (written by `people`) are all "now"
 *    items of the step that makes the reply, so the loop commits them before it sends it
 *    (section 3). A refusal of a new `seq` is kept as its reply, so a retry gets it again.
 *
 * `commands` rows are written for changes only, and for `backup.key` (section 11, "Step 1's
 * questions"), which hands out the backup key.
 */
import { err, ok, type Result } from "neverthrow";
import {
  APP_PROTO_LATEST,
  APP_PROTO_VERSIONS,
  type AppOp,
  type AppOpV2,
  type AppProtoVersion,
  type AppReply,
  type AppReplyV2,
  isVersion1Op,
  type NotificationObject,
  SESSION_LIMITS,
  UNRECORDED_BODY_FIELDS,
} from "@hsn/protocol/app";
import { msBetween } from "../model/time.ts";
import { recordStamp } from "../clock/view.ts";
import type { ControlReply } from "../model/control.ts";
import type { CoreFault } from "../model/errors.ts";
import type { HubEvent } from "../model/events.ts";
import type { Context, CoreDeps, Handler } from "../model/handler.ts";
import {
  APP_REQUEST_BASE,
  type ClientId,
  deviceId,
  isAppRequest,
  type RequestId,
  requestId,
  type Seq,
} from "../model/ids.ts";
import type { Actor, AnswerTo, Internal, OpOutcome } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";
import { m2OwnerOf, m3m4OwnerOf, OP_OWNERS } from "../model/ops.ts";
import { ClientKind } from "../model/rows.ts";
import {
  actorOfClient,
  lastSeq,
  liveClient,
  repeatOf,
  replyForVersion,
  replyOf,
  storedReply,
} from "../people/view.ts";
import { asVersion2 } from "../notify/view.ts";
import { deviceById, hubEventRecord } from "../registry/view.ts";
import { sessionGrantedIn, sessionRetried } from "../firmware/view.ts";
import { countdownChanges, siteChanges } from "./changes.ts";
import { refusal, refusalV2 } from "./checks.ts";
import { closeDayIfOver, sessionClosed, sessionOpened } from "./sessions-day.ts";
import { historyFilter } from "./history.ts";
import { configAnswered, noteConfigAsked, notificationEvents } from "./live.ts";
import {
  deviceChanges,
  eventsOf,
  forgetLost,
  peopleChanges,
  Sending,
  visibleSet,
} from "./events.ts";
import { m1aOutcome, m1aRequest } from "./m1a.ts";
import { deviceList, deviceObject, deviceSettings } from "./objects.ts";
import { presenceSet, presenceWithout } from "./presence.ts";
import { deviceUpdateEvents, offeredEvents, relayChanges } from "./v2-live.ts";
import { deviceToV2, factsForApps, hubInfoFor, protoOf, snapshotFor } from "./versions.ts";
import type {
  AppAnswerTo,
  AppSlice,
  CommandStamp,
  HubFacts,
  PendingRequest,
  Session,
} from "./state.ts";
import { EMPTY_APP_SLICE } from "./state.ts";

const ORIGIN = "core/app";

type Request = Extract<HubEvent, { readonly kind: "clientRequest" }>;
type OpRequest = Extract<Internal, { readonly kind: "opRequest" }>;

function keyOf(answerTo: { readonly conn: number; readonly id: number }): string {
  return `${answerTo.conn}:${answerTo.id}`;
}

function retryKey(client: ClientId, seq: number): string {
  return `${client}:${seq}`;
}

/** A reply of either version, as `people` keeps it. */
type AnyReply = AppReply | AppReplyV2;

function send(sending: Sending, conn: AppAnswerTo["conn"], reply: AnyReply): void {
  if (sending.slice.sessions.has(conn)) sending.out.push({ kind: "appSend", conn, message: reply });
}

const REDACTED = "***";

/**
 * A request's body as its `commands` row keeps it, every secret field removed (section 4):
 * `UNRECORDED_BODY_FIELDS` names them, of either version (`site.wifi`'s password, `push.register`'s
 * push key).
 */
function recordedArgs(op: AppOpV2): string {
  const table: Readonly<Record<string, readonly string[] | undefined>> = UNRECORDED_BODY_FIELDS;
  const hidden = table[op.op];
  if (hidden === undefined) return JSON.stringify(op.body);
  const body: Record<string, unknown> = { ...(op.body as Readonly<Record<string, unknown>>) };
  for (const field of hidden) body[field] = REDACTED;
  return JSON.stringify(body);
}

/** A version 1 operation as version 1's type has it; undefined for one only version 2 names. */
function asVersion1(op: AppOpV2): AppOp | undefined {
  return isVersion1Op(op.op) ? (op as AppOp) : undefined;
}

function commandRecord(stamp: CommandStamp, op: AppOpV2, outcome: OpOutcome): Internal {
  return {
    kind: "auditRecord",
    durability: "now",
    record: {
      kind: "command",
      row: {
        seq: stamp.seq,
        atMs: stamp.atMs,
        clockOk: stamp.clockOk,
        actor: stamp.actor,
        kind: op.op,
        args: stamp.args,
        outcome: outcome.ok ? "ok" : outcome.error.code,
        detail: null,
      },
    },
  };
}

function actorName(actor: Actor): string {
  switch (actor.kind) {
    case "person":
      return actor.name;
    case "console":
      return `hub computer (client ${actor.client})`;
    case "computer":
    case "schedule":
      return actor.name;
  }
}

/** The model's answer address of an app's request, with its version (absent is version 1). */
function appAnswerTo(answerTo: Extract<AnswerTo, { readonly kind: "app" }>): AppAnswerTo {
  return { ...answerTo, proto: answerTo.proto ?? 1 };
}

/** Before the shell has given its facts (`hubFacts`, after `boot`) or made the app key. */
const NOT_YET: OpOutcome = { ok: false, error: { code: "unavailable", detail: {} } };

/** An operation that needs an app's session, asked by the hub computer. */
const NO_SESSION: OpOutcome = {
  ok: false,
  error: { code: "invalid", detail: { field: "op", reason: "format" } },
};

/**
 * An operation `app` owns, answered from the core's state (section 5: "the snapshot is built from
 * the core's state, as `hsn status` is"). `undefined` for `history.query`, which the shell answers.
 */
function ownOutcome(
  sending: Sending,
  ctx: Context,
  deps: CoreDeps,
  actor: Actor,
  op: AppOp,
  session: Session | undefined,
): OpOutcome {
  const view = ctx.view;
  // The hub computer's own `hsn op` is answered in version 1's objects, as it always was.
  const proto = session === undefined ? 1 : protoOf(session.proto);
  switch (op.op) {
    case "snapshot": {
      const snapshot = snapshotFor(view, deps, actor, ctx.now, sending.slice.rev, proto);
      if (snapshot === undefined) return NOT_YET;
      if (session !== undefined) {
        const sessions = new Map(sending.slice.sessions);
        sessions.set(session.conn, { ...session, visible: visibleSet(view, actor) });
        sending.slice = { ...sending.slice, sessions };
      }
      return { ok: true, body: snapshot };
    }
    case "subscribe": {
      if (session === undefined) return NO_SESSION;
      const topics = new Set(op.body.topics);
      const sessions = new Map(sending.slice.sessions);
      sessions.set(session.conn, { ...session, topics, visible: visibleSet(view, actor) });
      sending.slice = { ...sending.slice, sessions };
      return { ok: true, body: { topics: [...topics] } };
    }
    case "hub.info": {
      const info = hubInfoFor(view, deps, ctx.now, proto);
      return info === undefined ? NOT_YET : { ok: true, body: info };
    }
    case "device.list": {
      const list = deviceList(view, deps, actor);
      return proto === 1
        ? { ok: true, body: list }
        : { ok: true, body: { devices: list.devices.map((d) => deviceToV2(view, d)) } };
    }
    case "device.show": {
      const row = deviceById(view, deviceId(op.body.device));
      const object =
        row === undefined || row.role === 0 ? undefined : deviceObject(view, deps, row);
      const settings = row === undefined ? undefined : deviceSettings(view, row.id);
      if (object === undefined || settings === undefined)
        return {
          ok: false,
          error: { code: "notFound", detail: { what: "device", id: op.body.device } },
        };
      const device = proto === 1 ? object : deviceToV2(view, object);
      return { ok: true, body: { device, settings } };
    }
    // `hub.status` and `history.query` are the shell's to answer (`hubStatusRead`, `historyRead`),
    // which it can do only on an app's connection; the hub computer has `hsn status` and `hsn log`.
    default:
      return NO_SESSION;
  }
}

/** Takes a record number and, for a change, stamps its `commands` record (section 4). */
function stamp(
  ctx: Context,
  actor: Actor,
  op: AppOpV2,
  change: boolean,
): Result<{ readonly record: Seq; readonly command: CommandStamp | undefined }, CoreFault> {
  return ctx.records.take().map((record) => {
    const { atMs, clockOk } = recordStamp(ctx.view, ctx.now);
    return {
      record,
      command:
        change || op.op === "backup.key"
          ? { seq: record, atMs, clockOk, actor: actorName(actor), args: recordedArgs(op) }
          : undefined,
    };
  });
}

function withPending(slice: AppSlice, key: string, pending: PendingRequest | undefined): AppSlice {
  const all = new Map(slice.pending);
  if (pending === undefined) all.delete(key);
  else all.set(key, pending);
  return { ...slice, pending: all };
}

/** A refusal of a request whose session or client is gone: sent at once, nothing kept. */
function refuseNow(
  sending: Sending,
  request: Request,
  outcome: OpOutcome,
  proto: AppProtoVersion,
): void {
  send(sending, request.conn, replyOf(request.request.id, outcome, proto));
}

function onRequest(
  sending: Sending,
  ctx: Context,
  deps: CoreDeps,
  request: Request,
): Result<void, CoreFault> {
  const view = ctx.view;
  const session = sending.slice.sessions.get(request.conn);
  if (session?.client !== request.client) return ok(undefined);
  const { id, seq, op } = request.request;
  const proto = protoOf(session.proto);
  const actor = actorOfClient(view, request.client);
  if (actor === undefined) {
    refuseNow(sending, request, { ok: false, error: { code: "unauthorized", detail: {} } }, proto);
    sending.out.push({ kind: "closeClient", client: request.client, reason: "removed" });
    return ok(undefined);
  }
  let answerTo: AppAnswerTo = {
    kind: "app",
    conn: request.conn,
    client: request.client,
    id,
    seq,
    proto,
  };
  const key = keyOf(answerTo);
  if (sending.slice.pending.has(key)) {
    // An `id` must be unique among the connection's unanswered requests (section 5).
    refuseNow(
      sending,
      request,
      { ok: false, error: { code: "invalid", detail: { field: "id", reason: "format" } } },
      proto,
    );
    return ok(undefined);
  }

  if (seq !== undefined) {
    const last = lastSeq(view, request.client);
    if (seq <= last) {
      const kept = storedReply(view, request.client, seq);
      // A retry of a granted Bluetooth session (m3-updates section 5, step 1): its kept reply is
      // firmware's marker, without the key. While that session lives, firmware answers the retry
      // with it again, as it would a new ask, nothing kept or recorded (no `seq` goes with it);
      // once it has ended, `unavailable`, so a retry never hangs and never starts a session.
      const session =
        kept?.kind === "sent" && op.op === "firmware.bluetooth"
          ? sessionRetried(view, ctx.now, kept.reply, op.body.device)
          : undefined;
      if (session === "live") answerTo = { ...answerTo, seq: undefined };
      else {
        if (session === "ended")
          refuseNow(
            sending,
            request,
            { ok: false, error: { code: "unavailable", detail: {} } },
            proto,
          );
        else if (kept?.kind === "sent")
          send(sending, request.conn, repeatOf(replyForVersion(kept.reply, proto), id));
        else if (kept?.kind === "pending") {
          const waiting = new Map(sending.slice.waiting);
          const k = retryKey(request.client, seq);
          waiting.set(k, [...(waiting.get(k) ?? []), answerTo]);
          sending.slice = { ...sending.slice, waiting };
        } else
          refuseNow(
            sending,
            request,
            { ok: false, error: { code: "seqTooLow", detail: { last } } },
            proto,
          );
        return ok(undefined);
      }
    }
  }

  const stamped = stamp(ctx, actor, op, answerTo.seq !== undefined);
  if (stamped.isErr()) return err(stamped.error);
  const { record, command } = stamped.value;
  sending.slice = withPending(sending.slice, key, {
    answerTo,
    op,
    command,
    record,
    decision: undefined,
  });
  const answer = (outcome: OpOutcome): void => {
    sending.out.push({ kind: "opAnswer", answerTo, outcome });
  };

  const v1 = asVersion1(op);
  if (v1 === undefined) return onVersion2(sending, ctx, op, { actor, answerTo, answer, record });
  return onVersion1(sending, ctx, deps, request, v1, {
    actor,
    answerTo,
    key,
    answer,
    session,
    record,
  });
}

/**
 * An operation only version 2 names (docs/m3-m4-plan.md, step 2): `presence.set` is `app`'s own;
 * every other goes to its owner as a `v2OpRequest` (`OP_OWNERS`): `firmware` and `relay`, which
 * check who may ask themselves; `upkeep` (`backup.keyHeld`, `update.offers`, `update.fetch`) and
 * `setup` (`pair.prepare`, `pair.finish`), after `app`'s check of manage system (`refusalV2`). A
 * version 1 session is never given one (the shell refuses it `protoUnsupported` first); should one
 * come, it is refused so here too.
 */
function onVersion2(
  sending: Sending,
  ctx: Context,
  op: AppOpV2,
  asked: {
    readonly actor: Actor;
    readonly answerTo: AppAnswerTo;
    readonly answer: (outcome: OpOutcome) => void;
    readonly record: Seq;
  },
): Result<void, CoreFault> {
  const { actor, answerTo, answer, record } = asked;
  if (answerTo.proto < APP_PROTO_LATEST) {
    answer({
      ok: false,
      error: {
        code: "protoUnsupported",
        detail: { speaks: [APP_PROTO_VERSIONS[0], APP_PROTO_LATEST] },
      },
    });
    return ok(undefined);
  }
  const refused = refusalV2(ctx.view, actor, op);
  if (refused !== undefined) {
    answer(refused);
    return ok(undefined);
  }
  if (op.op === "presence.set") {
    return presenceSet(ctx.view, ctx, sending.slice.presence, actor, op.body.away, record).map(
      (done) => {
        sending.slice = { ...sending.slice, presence: done.presence };
        sending.out.push(...done.out);
        answer(done.outcome);
      },
    );
  }
  const owner = OP_OWNERS[op.op];
  if (owner === "upkeep" || owner === "setup" || m3m4OwnerOf(op.op) !== undefined) {
    const to = m3m4OwnerOf(op.op) ?? (owner === "setup" ? "setup" : "upkeep");
    sending.out.push({ kind: "v2OpRequest", owner: to, op, actor, answerTo, record });
    return ok(undefined);
  }
  answer({ ok: false, error: { code: "notBuilt", detail: { op: op.op } } });
  return ok(undefined);
}

/** A version 1 operation's check and routing, as M2 built them. */
function onVersion1(
  sending: Sending,
  ctx: Context,
  deps: CoreDeps,
  request: Request,
  op: AppOp,
  asked: {
    readonly actor: Actor;
    readonly answerTo: AppAnswerTo;
    readonly key: string;
    readonly answer: (outcome: OpOutcome) => void;
    readonly session: Session | undefined;
    readonly record: Seq;
  },
): Result<void, CoreFault> {
  const view = ctx.view;
  const { actor, answerTo, key, answer, session, record } = asked;
  const { id } = request.request;
  const refused = refusal(view, session, actor, op);
  if (refused !== undefined) {
    answer(refused);
    return ok(undefined);
  }

  const owner = OP_OWNERS[op.op];
  if (owner === "app") {
    if (op.op === "hub.status") {
      sending.slice = withPending(sending.slice, key, undefined);
      sending.out.push({ kind: "hubStatusRead", conn: request.conn, id });
      return ok(undefined);
    }
    if (op.op === "history.query") {
      sending.slice = withPending(sending.slice, key, undefined);
      sending.out.push({
        kind: "historyRead",
        conn: request.conn,
        id,
        query: op.body,
        allowed: historyFilter(view, actor),
      });
      return ok(undefined);
    }
    answer(ownOutcome(sending, ctx, deps, actor, op, session));
    return ok(undefined);
  }
  const m2 = m2OwnerOf(op.op);
  if (m2 !== undefined) {
    sending.out.push({ kind: "opRequest", owner: m2, op, actor, answerTo, record });
    return ok(undefined);
  }
  const number = requestId(APP_REQUEST_BASE + sending.slice.nextRequest);
  const routed = m1aRequest(view, op, { request: number, actor: actorName(actor), record });
  if (routed === undefined) {
    // `fileChunk` is the shell's (section 6) and never reaches the core.
    answer({ ok: false, error: { code: "invalid", detail: { field: "op", reason: "format" } } });
    return ok(undefined);
  }
  if (routed.kind !== "request") {
    answer(routed.outcome);
    return ok(undefined);
  }
  const m1a = new Map(sending.slice.m1a);
  m1a.set(number, key);
  sending.slice = { ...sending.slice, m1a, nextRequest: sending.slice.nextRequest + 1 };
  sending.out.push(routed.message);
  return ok(undefined);
}

/** The reply to a request of an app, its `commands` record, and any retries waiting for it. */
function onAnswer(
  sending: Sending,
  view: HubState,
  answerTo: AppAnswerTo,
  outcome: OpOutcome,
): void {
  const key = keyOf(answerTo);
  const pending = sending.slice.pending.get(key);
  const proto = answerTo.proto;
  const reply = replyOf(answerTo.id, readForVersion(view, pending?.op, outcome, proto), proto);
  // A granted Bluetooth session's reply, with its key, is the shell's to send (`bluetoothSession`);
  // this answer is firmware's marker of it, recorded and kept only.
  if (sessionGrantedIn(outcome) === undefined) send(sending, answerTo.conn, reply);
  if (pending !== undefined) {
    sending.slice = withPending(sending.slice, key, undefined);
    if (pending.command !== undefined)
      sending.out.push(commandRecord(pending.command, pending.op, outcome));
  }
  if (answerTo.seq !== undefined) {
    const k = retryKey(answerTo.client, answerTo.seq);
    const waiting = sending.slice.waiting.get(k);
    if (waiting !== undefined) {
      for (const retry of waiting)
        send(sending, retry.conn, repeatOf(replyForVersion(reply, retry.proto), retry.id));
      const all = new Map(sending.slice.waiting);
      all.delete(k);
      sending.slice = { ...sending.slice, waiting: all };
    }
  }
}

/**
 * A read's answer from its owner, in the session's version: `notifications.list`'s objects with
 * `happenedAtMs` on a version 2 session (D102, `notify`'s `asVersion2`). A read is not kept, so
 * only the reply sent changes; every other answer is the same in both versions.
 */
function readForVersion(
  view: HubState,
  op: AppOpV2 | undefined,
  outcome: OpOutcome,
  proto: AppProtoVersion,
): OpOutcome {
  if (proto === 1 || !outcome.ok || op?.op !== "notifications.list") return outcome;
  const body = outcome.body as { readonly notifications: readonly NotificationObject[] };
  return { ok: true, body: { notifications: asVersion2(view, body.notifications) } };
}

/**
 * An M1a module's outcome in the session's version: on a version 2 session the device a
 * `device.rename`, `device.remove` or `usb.add` answers with is version 2's object, with its
 * update. Made before the `opAnswer`, so the reply `people` keeps for a retry is this one.
 */
function m1aForVersion(view: HubState, op: AppOp, outcome: OpOutcome, proto: AppProtoVersion) {
  if (proto === 1 || !outcome.ok) return outcome;
  if (op.op !== "device.rename" && op.op !== "device.remove" && op.op !== "usb.add") return outcome;
  const body = outcome.body as Parameters<typeof deviceToV2>[1];
  return { ok: true, body: deviceToV2(view, body) } as const;
}

/** An M1a module's answer to one of app's numbers: the operation's outcome, as an `opAnswer`. */
function onM1aAnswer(
  sending: Sending,
  ctx: Context,
  request: RequestId,
  reply: ControlReply,
): Result<void, CoreFault> {
  const key = sending.slice.m1a.get(request);
  if (key === undefined) return ok(undefined);
  const m1a = new Map(sending.slice.m1a);
  m1a.delete(request);
  sending.slice = { ...sending.slice, m1a };
  const pending = sending.slice.pending.get(key);
  // Only a version 1 operation is ever given to an M1a module.
  const op = pending === undefined ? undefined : asVersion1(pending.op);
  if (pending === undefined || op === undefined) return ok(undefined);
  return m1aOutcome(ctx, op, reply, pending.record).map((outcome) => {
    const versioned = m1aForVersion(ctx.view, op, outcome, pending.answerTo.proto);
    sending.out.push({ kind: "opAnswer", answerTo: pending.answerTo, outcome: versioned });
  });
}

/** An operation of app's from the hub computer (`hsn op snapshot`, `hub.info`, `hub.status`). */
function onOpRequest(sending: Sending, ctx: Context, deps: CoreDeps, request: OpRequest): void {
  const outcome = ownOutcome(sending, ctx, deps, request.actor, request.op, undefined);
  sending.out.push({ kind: "opAnswer", answerTo: request.answerTo, outcome });
}

function onConnected(
  sending: Sending,
  ctx: Context,
  event: Extract<HubEvent, { readonly kind: "clientConnected" }>,
): Result<void, CoreFault> {
  const view = ctx.view;
  const row = liveClient(view, event.client);
  const actor = actorOfClient(view, event.client);
  // A console client only on the console listener (section 5); a removed client not at all.
  if (
    row === undefined ||
    actor === undefined ||
    (row.kind === ClientKind.Console && event.listener !== "console")
  ) {
    sending.out.push({ kind: "closeClient", client: event.client, reason: "not linked here" });
    return ok(undefined);
  }
  const sessions = new Map(sending.slice.sessions);
  sessions.set(event.conn, {
    conn: event.conn,
    client: event.client,
    listener: event.listener,
    proto: event.proto,
    app: event.app,
    topics: new Set(),
    visible: visibleSet(view, actor),
  });
  sending.slice = { ...sending.slice, sessions };
  sessionOpened(sending, ctx, event.client);
  return ok(undefined);
}

function onClosed(
  sending: Sending,
  ctx: Context,
  event: Extract<HubEvent, { readonly kind: "clientClosed" }>,
): Result<void, CoreFault> {
  const session = sending.slice.sessions.get(event.conn);
  if (session === undefined) return ok(undefined);
  const sessions = new Map(sending.slice.sessions);
  sessions.delete(event.conn);
  // Retries waiting on this connection have no one to answer; a request still with its owner
  // keeps its pending entry, whose answer writes its `commands` record (and `people` its seq).
  const waiting = new Map(
    [...sending.slice.waiting]
      .map(([key, retries]) => [key, retries.filter((r) => r.conn !== event.conn)] as const)
      .filter(([, retries]) => retries.length > 0),
  );
  sending.slice = { ...sending.slice, sessions, waiting };
  sessionClosed(sending, ctx, session.client);
  return ok(undefined);
}

/** A removed client: its sessions are told (`session`), then closed (section 6). */
function onRemoved(sending: Sending, client: ClientId): void {
  const mine = [...sending.slice.sessions.values()].filter((s) => s.client === client);
  if (mine.length > 0) {
    const rev = sending.rev();
    for (const session of mine)
      sending.out.push({
        kind: "appSend",
        conn: session.conn,
        message: { t: "evt", rev, ev: "session", body: {} },
      });
  }
  const sessions = new Map(sending.slice.sessions);
  for (const session of mine) sessions.delete(session.conn);
  sending.slice = { ...sending.slice, sessions };
  sending.out.push({ kind: "closeClient", client, reason: "removed" });
}

const HOUR_MS = 3_600_000;

/**
 * A refused handshake (section 5; section 11, "Step 1, wave 2"): `client_refused`, routine, info;
 * once an hour per address past 10 ‡ (`SESSION_LIMITS.refusedWarningPerHour`) a warning, written
 * now (D112). A flood costs at most one "now" record an hour per address, and `audit`'s cap of 60 ‡
 * warnings an hour for `core/app` bounds every address together (HD 5). The shell sends at most one input per
 * address a minute, with its count, and `"many"` past 64 ‡ addresses, so the records stay few; the
 * hour's counts are memory only and forgotten an hour after their first refusal.
 */
function onRefused(
  sending: Sending,
  ctx: Context,
  event: Extract<HubEvent, { readonly kind: "clientRefused" }>,
): Result<void, CoreFault> {
  const now = ctx.now.mono;
  const refused = new Map(
    [...sending.slice.refused].filter(([, hour]) => msBetween(hour.since, now) < HOUR_MS),
  );
  const hour = refused.get(event.address) ?? { since: now, count: 0, warned: false };
  const count = hour.count + event.count;
  const warn = !hour.warned && count > SESSION_LIMITS.refusedWarningPerHour;
  refused.set(event.address, { since: hour.since, count, warned: hour.warned || warn });
  sending.slice = { ...sending.slice, refused };
  return hubEventRecord(ctx, {
    level: warn ? "warning" : "info",
    origin: ORIGIN,
    code: "client_refused",
    message: warn
      ? `${count} handshakes refused in an hour from ${event.address}`
      : `${event.count} handshakes refused from ${event.address}: ${event.reason}`,
    detail: JSON.stringify({ address: event.address, reason: event.reason, count: event.count }),
    // D112: a warning is written now; `audit`'s cap (60 ‡ an hour per source) bounds a flood.
    durability: warn ? "now" : "routine",
  }).map((record) => {
    sending.out.push(record);
  });
}

/** Whether the shell's facts are those already held: then the slice stays as it is. */
function sameFacts(held: HubFacts | undefined, given: HubFacts): boolean {
  return (
    held?.version === given.version &&
    held.appsPort === given.appsPort &&
    // Step 0 owner, wave 2: `hubFacts.consolePort` (frozen), kept as the other facts are.
    held.consolePort === given.consolePort &&
    held.addresses.length === given.addresses.length &&
    held.addresses.every((a, i) => a === given.addresses[i]) &&
    held.certificateSha256.length === given.certificateSha256.length &&
    held.certificateSha256.every((b, i) => b === given.certificateSha256[i])
  );
}

function handleMessage(
  sending: Sending,
  message: Internal,
  ctx: Context,
  deps: CoreDeps,
): Result<void, CoreFault> {
  switch (message.kind) {
    case "boot":
      sending.slice = EMPTY_APP_SLICE;
      return ok(undefined);
    case "hubFacts": {
      const facts: HubFacts = {
        version: message.version,
        addresses: message.addresses,
        appsPort: message.appsPort,
        consolePort: message.consolePort,
        certificateSha256: message.certificateSha256,
      };
      // The addresses apps are given: no link-local ones, IPv4 first (`versions.ts`).
      const forApps = factsForApps(facts);
      if (!sameFacts(sending.slice.facts, forApps))
        sending.slice = { ...sending.slice, facts: forApps };
      return ok(undefined);
    }
    case "clientRefused":
      return onRefused(sending, ctx, message);
    case "clientConnected":
      return onConnected(sending, ctx, message);
    case "clientClosed":
      return onClosed(sending, ctx, message);
    case "clientRequest":
      return onRequest(sending, ctx, deps, message);
    case "opRequest":
      noteConfigAsked(sending, message);
      if (message.owner === "app") onOpRequest(sending, ctx, deps, message);
      return ok(undefined);
    case "opAnswer":
      configAnswered(sending, ctx.view, message.answerTo, message.outcome);
      if (message.answerTo.kind === "app")
        onAnswer(sending, ctx.view, appAnswerTo(message.answerTo), message.outcome);
      return ok(undefined);
    case "answer":
      return isAppRequest(message.request)
        ? onM1aAnswer(sending, ctx, message.request, message.reply)
        : ok(undefined);
    case "clientRemoved": {
      onRemoved(sending, message.client);
      const presence = presenceWithout(sending.slice.presence, message.client);
      if (presence !== sending.slice.presence) sending.slice = { ...sending.slice, presence };
      return ok(undefined);
    }
    case "notificationRaised":
      notificationEvents(
        sending,
        ctx.view,
        message.notification,
        message.clients,
        message.happenedAtMs,
      );
      return ok(undefined);
    case "deviceUpdateEvent":
      deviceUpdateEvents(sending, ctx.view, message.body);
      return ok(undefined);
    default:
      return ok(undefined);
  }
}

/** The handler (m2-design.md section 2, module 8). */
export const handleApp: Handler<"app"> = (slice, message, ctx) => {
  const sending = new Sending(slice, ctx.now);
  // A boot starts a new run, whose count starts again (`sessions-day.ts`).
  const dayOver = message.kind === "boot" ? ok(undefined) : closeDayIfOver(sending, ctx);
  if (dayOver.isErr()) return err(dayOver.error);
  const handled = handleMessage(sending, message, ctx, ctx.deps);
  if (handled.isErr()) return err(handled.error);
  peopleChanges(sending, ctx.view);
  countdownChanges(sending, ctx.view);
  siteChanges(sending, ctx.view);
  const registryChanged = sending.slice.registrySeen !== ctx.view.registry.devices;
  if (registryChanged || sending.slice.firmwareSeen !== ctx.view.firmware.updates) {
    const devicesSeen = deviceChanges(sending, ctx.view, ctx.deps);
    sending.slice = {
      ...sending.slice,
      devicesSeen,
      registrySeen: ctx.view.registry.devices,
      firmwareSeen: ctx.view.firmware.updates,
    };
    if (registryChanged) forgetLost(sending, ctx.view);
  }
  eventsOf(sending, ctx, message);
  if (message.kind === "auditRecord") offeredEvents(sending, ctx.view, message.record);
  relayChanges(sending, ctx.view);
  return ok({ slice: sending.slice, out: sending.out });
};

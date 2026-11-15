/**
 * The notify module's handler (m2-design.md section 2, module 18; section 7, "Notifications";
 * section 3, the durability of notifications and reads).
 *
 * - Raising: every decision record, and the hub events of the disk, is put to the table
 *   (`table.ts`); a client linked (`clientAdded`) is told to the other clients of its person.
 *   Each notification is one `notifications` record naming its recipients (`audience.ts`, read
 *   from `people`'s view) and the record that caused it, and one `notificationRaised` naming the
 *   clients whose categories let it through, for `app` to send to their sessions.
 * - Durability: a critical notification is written now, by this module, whatever the class of the
 *   decision that raised it; a "now" commit takes everything staged, so the decision goes with it
 *   (HD 5). Every other notification, and every read, is routine (section 3).
 * - No flood (`table.ts`): the same kind about the same device at most once every 10 minutes ‡,
 *   unless critical or a person's, a schedule's, a new client's or the hub's. A notice not raised
 *   writes nothing; its decision is still the record.
 * - Operations (`OP_OWNERS`): `notifications.list`, `notifications.read` (a read, not a change:
 *   its rows routine, answered at once) and `notifications.prefs`.
 * - A start restores the notifications and reads of the last 7 days from the snapshot, so what is
 *   unread survives a restart.
 */
import { err, ok, type Result } from "neverthrow";
import {
  type AppError,
  type AppOp,
  categoryBit,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  OPTIONAL_CATEGORIES,
  type OptionalCategory,
} from "@hsn/protocol/app";
import type { AuditRecord } from "../model/audit.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import {
  type ClientId,
  type DeviceId,
  modeId,
  type PersonId,
  personId,
  type Seq,
} from "../model/ids.ts";
import type { Actor, AnswerTo, Internal, OpOutcome } from "../model/messages.ts";
import type { NotificationPrefsRow, NotificationRow } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import { type Mono, monoAfterMs } from "../model/time.ts";
import { anySensorArmed, armedForUser } from "../alarm/view.ts";
import { recordStamp } from "../clock/view.ts";
import { sensorsChanged } from "../layout/view.ts";
import { deviceById, roleName } from "../registry/view.ts";
import { recordMessage } from "../util/records.ts";
import { type About, clientsFor, personOf, recipients } from "./audience.ts";
import { categoryOn, isForPerson, notificationObject } from "./deliver.ts";
import { readBy } from "./reads.ts";
import type { NotifySlice, Raised } from "./state.ts";
import {
  type Classified,
  classifyDecision,
  classifyHubEvent,
  floodExempt,
  NEW_CLIENT,
} from "./table.ts";

type Out = Internal | Effect;
type Step = Result<Handled<"notify">, CoreFault>;
type OpRequest = Extract<Internal, { readonly kind: "opRequest" }>;

function unchanged(slice: NotifySlice): Step {
  return ok({ slice, out: [] });
}

/** Person ids, u32 LE each: a notification's `recipients` (section 4). */
export function recipientBytes(people: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(people.length * 4);
  const view = new DataView(bytes.buffer);
  people.forEach((person, i) => {
    view.setUint32(i * 4, person, true);
  });
  return bytes;
}

/** A notification's recipients from its row. */
export function recipientsOf(row: NotificationRow): readonly PersonId[] {
  const bytes = row.recipients;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const people: PersonId[] = [];
  for (let at = 0; at + 4 <= bytes.byteLength; at += 4) {
    people.push(personId(view.getUint32(at, true)));
  }
  return people;
}

/** What a notification about `device` is about, for its recipients. */
function aboutOf(ctx: Context, device: DeviceId | null, classified: Classified): About {
  if (classified.sensors !== undefined) return { kind: "sensors", sensors: classified.sensors };
  if (device === null) return { kind: "hub" };
  const row = deviceById(ctx.view, device);
  return row !== undefined && roleName(row.role) === "sensor"
    ? { kind: "sensor", device }
    : { kind: "device", device };
}

// ——— Raising ———

interface Raising {
  readonly kind: string;
  readonly device: DeviceId | null;
  readonly cause: Seq | null;
  readonly classified: Classified;
  /** Its recipients when they are not those of what it is about: a new client's person. */
  readonly people: readonly PersonId[] | undefined;
  /** A client it is not for although its person is: the new client of a `newClient` notice. */
  readonly except: ClientId | undefined;
}

function floodKey(raising: Raising): string {
  return `${raising.kind}:${raising.device ?? "hub"}`;
}

/** Whether the flood rule drops this one (section 7, "No flood"). */
function flooded(slice: NotifySlice, ctx: Context, raising: Raising): boolean {
  if (floodExempt(raising.classified)) return false;
  const last = slice.lastRaised.get(floodKey(raising));
  return (
    last !== undefined && ctx.now.mono < monoAfterMs(last, ctx.deps.rules.notify.sameKindEveryMs)
  );
}

/** Flood times older than the rule's window are forgotten, so the map stays small. */
function freshFloodTimes(slice: NotifySlice, ctx: Context): Map<string, Mono> {
  const kept = new Map<string, Mono>();
  for (const [key, at] of slice.lastRaised) {
    if (ctx.now.mono < monoAfterMs(at, ctx.deps.rules.notify.sameKindEveryMs)) kept.set(key, at);
  }
  return kept;
}

/** The notifications still inside the unread window at this step's wall time. */
function inWindow(notifications: readonly Raised[], ctx: Context): readonly Raised[] {
  const from = ctx.now.wall - ctx.deps.rules.notify.unreadWindowMs;
  return notifications.filter((raised) => raised.row.atMs >= from);
}

function raise(slice: NotifySlice, ctx: Context, raising: Raising): Step {
  if (flooded(slice, ctx, raising)) return unchanged(slice);
  const { classified } = raising;
  return ctx.records.take().map((seq) => {
    const people = recipients(
      ctx.view,
      raising.people === undefined
        ? aboutOf(ctx, raising.device, classified)
        : { kind: "people", people: raising.people },
    );
    const row: NotificationRow = {
      seq,
      ...recordStamp(ctx.view, ctx.now),
      kind: raising.kind,
      category: classified.category,
      critical: classified.critical,
      deviceId: raising.device,
      causeSeq: raising.cause,
      recipients: recipientBytes(people),
      detail: null,
    };
    // Critical: written now by notify (section 7); everything else with the routine batch.
    const durability: Durability = classified.critical ? "now" : "routine";
    const raised: Raised = {
      row,
      category: classified.category,
      recipients: people,
      read: new Set(),
    };
    const clients = clientsFor(ctx.view, people).filter(
      (client) =>
        client !== raising.except &&
        categoryOn(slice, client, classified.category, classified.mandatory),
    );
    const out: Out[] = [
      recordMessage(durability, { kind: "notification", row }),
      {
        kind: "notificationRaised",
        notification: notificationObject(raised, false, false),
        clients,
      },
    ];
    const lastRaised = freshFloodTimes(slice, ctx);
    if (!floodExempt(classified)) lastRaised.set(floodKey(raising), ctx.now.mono);
    return {
      slice: {
        ...slice,
        notifications: [...inWindow(slice.notifications, ctx), raised],
        lastRaised,
      },
      out,
    };
  });
}

/** A record on its way to audit: decisions and the disk's hub events may raise a notification. */
function onRecord(slice: NotifySlice, ctx: Context, record: AuditRecord): Step {
  if (record.kind === "decision") {
    const { row } = record;
    const classified = classifyDecision(row.kind, row.deviceId, row.value, row.detail, {
      armed: (sensor) => armedForUser(ctx.view, sensor),
      anyArmed: anySensorArmed(ctx.view),
      switchChanges: (mode) => sensorsChanged(ctx.view, { kind: "mode", mode: modeId(mode) }) ?? [],
    });
    if (classified === undefined) return unchanged(slice);
    return raise(slice, ctx, {
      kind: row.kind,
      device: row.deviceId,
      cause: row.seq,
      classified,
      people: undefined,
      except: undefined,
    });
  }
  if (record.kind === "hubEvent") {
    const classified = classifyHubEvent(record.row.code);
    if (classified === undefined) return unchanged(slice);
    return raise(slice, ctx, {
      kind: record.row.code,
      device: null,
      cause: record.row.seq,
      classified,
      people: undefined,
      except: undefined,
    });
  }
  return unchanged(slice);
}

// ——— The start ———

function isCategory(category: string): category is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
}

/** The notifications and reads of the last 7 days, and every client's categories (section 7). */
function restored(slice: NotifySlice, snapshot: DurableSnapshot): NotifySlice {
  const reads = new Map<number, Set<ClientId>>();
  for (const read of snapshot.m2.notificationReads) {
    const clients = reads.get(read.notificationSeq) ?? new Set<ClientId>();
    clients.add(read.clientId);
    reads.set(read.notificationSeq, clients);
  }
  const notifications: Raised[] = [];
  for (const row of [...snapshot.m2.notifications].sort((a, b) => a.seq - b.seq)) {
    if (!isCategory(row.category)) continue;
    notifications.push({
      row,
      category: row.category,
      recipients: recipientsOf(row),
      read: reads.get(row.seq) ?? new Set(),
    });
  }
  return {
    ...slice,
    notifications,
    prefs: new Map(snapshot.m2.notificationPrefs.map((row) => [row.clientId, row])),
    lastRaised: new Map(),
  };
}

// ——— Operations ———

function answer(answerTo: AnswerTo, outcome: OpOutcome): Internal {
  return { kind: "opAnswer", answerTo, outcome };
}

function refused(answerTo: AnswerTo, error: AppError): Internal {
  return answer(answerTo, { ok: false, error });
}

/** `hsn` and schedules have no client whose reads or categories these could be. */
const NO_CLIENT: AppError = { code: "unauthorized", detail: {} };

/** The client a request speaks for: a person's or the console's; none for `hsn` or a schedule. */
function clientOf(actor: Actor): ClientId | undefined {
  return actor.kind === "person" || actor.kind === "console" ? actor.client : undefined;
}

/** Whose notifications a request sees: its person's; the console's and `hsn`'s every one (null). */
function personAsking(ctx: Context, actor: Actor): PersonId | null | undefined {
  switch (actor.kind) {
    case "person":
      return personOf(ctx.view, actor.client) ?? undefined;
    case "console":
    case "computer":
      return null;
    case "schedule":
      return undefined;
  }
}

function onOp(slice: NotifySlice, ctx: Context, request: OpRequest): Step {
  const { op, actor, answerTo } = request;
  const person = personAsking(ctx, actor);
  const client = clientOf(actor);
  switch (op.op) {
    case "notifications.list":
      if (person === undefined) return ok({ slice, out: [refused(answerTo, NO_CLIENT)] });
      return ok({
        slice,
        out: [answer(answerTo, { ok: true, body: listed(slice, ctx, person, op.body) })],
      });
    case "notifications.read":
      if (client === undefined || person === undefined) {
        return ok({ slice, out: [refused(answerTo, NO_CLIENT)] });
      }
      return markRead(slice, ctx, client, person, op.body.seqs, answerTo);
    case "notifications.prefs":
      if (client === undefined) return ok({ slice, out: [refused(answerTo, NO_CLIENT)] });
      return setPrefs(slice, client, op.body.categories, answerTo);
    default:
      return ok({ slice, out: [refused(answerTo, { code: "notBuilt", detail: { op: op.op } })] });
  }
}

/** `notifications.list`: the person's notifications, read or not, newest first (section 6). */
function listed(
  slice: NotifySlice,
  ctx: Context,
  person: PersonId | null,
  body: Extract<AppOp, { op: "notifications.list" }>["body"],
): { readonly notifications: readonly ReturnType<typeof notificationObject>[] } {
  const { before, limit } = body;
  const notifications = slice.notifications
    .filter((raised) => isForPerson(raised, person))
    .filter((raised) => before === undefined || raised.row.seq < before)
    .reverse()
    .slice(0, limit)
    .map((raised) => notificationObject(raised, readBy(ctx.view, raised, person), false));
  return { notifications };
}

/** `notifications.read`: one routine `notification_reads` row per notification not yet read by it. */
function markRead(
  slice: NotifySlice,
  ctx: Context,
  client: ClientId,
  person: PersonId | null,
  seqs: readonly number[],
  answerTo: AnswerTo,
): Step {
  const bySeq = new Map(slice.notifications.map((raised) => [raised.row.seq as number, raised]));
  const unknown = seqs.find((s) => {
    const raised = bySeq.get(s);
    return raised === undefined || !isForPerson(raised, person);
  });
  if (unknown !== undefined) {
    return ok({
      slice,
      out: [refused(answerTo, { code: "notFound", detail: { what: "notification", id: unknown } })],
    });
  }
  const out: Out[] = [];
  const notifications: Raised[] = [];
  for (const raised of slice.notifications) {
    if (!seqs.includes(raised.row.seq) || raised.read.has(client)) {
      notifications.push(raised);
      continue;
    }
    const taken = ctx.records.take();
    if (taken.isErr()) return err(taken.error);
    out.push(
      recordMessage("routine", {
        kind: "notificationRead",
        row: {
          seq: taken.value,
          ...recordStamp(ctx.view, ctx.now),
          notificationSeq: raised.row.seq,
          clientId: client,
        },
      }),
    );
    notifications.push({ ...raised, read: new Set(raised.read).add(client) });
  }
  out.push(answer(answerTo, { ok: true, body: {} }));
  return ok({ slice: { ...slice, notifications }, out });
}

/** `notifications.prefs`: the client's optional categories, written now (configuration). */
function setPrefs(
  slice: NotifySlice,
  client: ClientId,
  categories: readonly OptionalCategory[],
  answerTo: AnswerTo,
): Step {
  const bits = categories.reduce((sum, c) => sum | categoryBit(c), 0);
  const row: NotificationPrefsRow = {
    clientId: client,
    categories: bits,
    revision: (slice.prefs.get(client)?.revision ?? 0) + 1,
  };
  const on = OPTIONAL_CATEGORIES.filter((c) => (bits & categoryBit(c)) !== 0);
  return ok({
    slice: { ...slice, prefs: new Map(slice.prefs).set(client, row) },
    out: [
      { kind: "write", durability: "now", op: { table: "notification_prefs", op: "upsert", row } },
      answer(answerTo, { ok: true, body: { categories: on, revision: row.revision } }),
    ],
  });
}

// ——— The handler ———

export const handleNotify: Handler<"notify"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "boot":
      return ok({ slice: restored(slice, message.snapshot), out: [] });
    case "auditRecord":
      return onRecord(slice, ctx, message.record);
    case "clientAdded":
      // A new client is told to the other clients of its person, and to the console (section 7).
      return raise(slice, ctx, {
        kind: "client_linked",
        device: null,
        cause: null,
        classified: NEW_CLIENT,
        people: message.person === null ? [] : [message.person],
        except: message.client,
      });
    case "clientRemoved": {
      if (!slice.prefs.has(message.client)) return unchanged(slice);
      const prefs = new Map(slice.prefs);
      prefs.delete(message.client);
      return ok({
        slice: { ...slice, prefs },
        out: [
          {
            kind: "write",
            durability: "now",
            op: { table: "notification_prefs", op: "delete", key: { clientId: message.client } },
          },
        ],
      });
    }
    case "opRequest":
      return message.owner === "notify" ? onOp(slice, ctx, message) : unchanged(slice);
    default:
      return unchanged(slice);
  }
};

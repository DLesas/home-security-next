/**
 * The people module's operations (m2-design.md section 6; section 7, "People and permissions"):
 * people, permissions, user management, clients. Each checks who asks itself, from the actor the
 * request carries, so a request from any source (an app, the console, the hub computer) is held to
 * the same rules. Every change is written now, in the step that answers it (section 3).
 *
 * Linking (`link.create`, `link.cancel`, the console token and the handshake's result) is in
 * `linking.ts`.
 */
import { err, ok, type Result } from "neverthrow";
import type { AppError, AppOpBody, PersonObject } from "@hsn/protocol/app";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context, Handled } from "../model/handler.ts";
import {
  type ClientId,
  clientId,
  type DeviceId,
  deviceId,
  type PersonId,
  personId,
  type Seq,
} from "../model/ids.ts";
import type { Actor, Internal, OpOutcome } from "../model/messages.ts";
import type { ClientRow, PermissionRow, PersonRoleRow, PersonRow } from "../model/rows.ts";
import { clientObject, liveClients, livePeople, personObject, sensorIds } from "./objects.ts";
import { actorHasGlobal, actorPerson, isLastUserManager, isLivePerson } from "./permissions.ts";
import { actorText, peopleDecision, writeNow } from "./records.ts";
import type { PeopleSlice } from "./state.ts";
import { voidTokens } from "./tokens.ts";

export type OpRequest = Extract<Internal, { readonly kind: "opRequest" }>;
export type Step = Result<Handled<"people">, CoreFault>;
type Out = (Internal | Effect)[];

export function answer(request: OpRequest, outcome: OpOutcome): Internal {
  return { kind: "opAnswer", answerTo: request.answerTo, outcome };
}

export function refused(error: AppError): OpOutcome {
  return { ok: false, error };
}

export function unauthorized(permission?: "manageUsers" | "manageSystem"): OpOutcome {
  return refused({ code: "unauthorized", detail: permission === undefined ? {} : { permission } });
}

export function notFound(
  what: Extract<AppError, { readonly code: "notFound" }>["detail"]["what"],
  id: number,
): OpOutcome {
  return refused({ code: "notFound", detail: { what, id } });
}

export function invalid(
  field: string,
  reason: Extract<AppError, { readonly code: "invalid" }>["detail"]["reason"],
  refs?: readonly number[],
): OpOutcome {
  return refused({
    code: "invalid",
    detail: refs === undefined ? { field, reason } : { field, reason, refs },
  });
}

function conflict(revision: number, object: PersonObject): OpOutcome {
  return refused({ code: "conflict", detail: { revision, object } });
}

export function answered(slice: PeopleSlice, request: OpRequest, outcome: OpOutcome): Step {
  return ok({ slice, out: [answer(request, outcome)] });
}

/** Collects decisions, which take record numbers and so may fault. */
class Writes {
  readonly out: Out = [];
  #fault: CoreFault | undefined;

  push(...items: readonly (Internal | Effect)[]): void {
    this.out.push(...items);
  }

  decide(result: Result<Internal, CoreFault>): void {
    if (result.isErr()) this.#fault ??= result.error;
    else this.out.push(result.value);
  }

  done(slice: PeopleSlice): Step {
    return this.#fault === undefined ? ok({ slice, out: this.out }) : err(this.#fault);
  }
}

function nameTaken(slice: PeopleSlice, name: string, except?: PersonId): boolean {
  return [...slice.people.values()].some(
    (row) => row.removedMs === null && row.name === name && row.id !== except,
  );
}

function withPerson(slice: PeopleSlice, row: PersonRow): PeopleSlice {
  const people = new Map(slice.people);
  people.set(row.id, row);
  return { ...slice, people, nextPerson: Math.max(slice.nextPerson, row.id + 1) };
}

function withRole(slice: PeopleSlice, row: PersonRoleRow): PeopleSlice {
  const roles = new Map(slice.roles);
  roles.set(row.personId, row);
  return { ...slice, roles };
}

export function withClient(slice: PeopleSlice, row: ClientRow): PeopleSlice {
  const clients = new Map(slice.clients);
  clients.set(row.id, row);
  return { ...slice, clients, nextClient: Math.max(slice.nextClient, row.id + 1) };
}

/**
 * A new person (section 7). While user management is on, their permissions are set at once, to
 * none (section 11, "Step 1's questions": as built).
 */
export function addPerson(
  slice: PeopleSlice,
  ctx: Context,
  name: string,
  by: string,
  cause: Seq | null,
  writes: Writes,
): { readonly slice: PeopleSlice; readonly person: PersonId } {
  const person = personId(slice.nextPerson);
  const row: PersonRow = {
    id: person,
    name,
    createdMs: ctx.now.wall,
    removedMs: null,
    revision: 0,
  };
  let next = withPerson(slice, row);
  writes.push(writeNow({ table: "people", op: "upsert", row }));
  if (next.userManagement) {
    const role: PersonRoleRow = {
      personId: person,
      manageUsers: false,
      manageSystem: false,
      revision: 0,
    };
    next = withRole(next, role);
    writes.push(writeNow({ table: "person_roles", op: "upsert", row: role }));
  }
  writes.decide(peopleDecision(ctx, "person_added", person, { name, by }, cause));
  return { slice: next, person };
}

/**
 * Removes clients in one commit (section 7, "A lost device"; "Removing a person"): each written
 * removed, every unused token it made void, a `client_removed` decision, and `clientRemoved`, on
 * which `app` closes its sessions.
 */
export function removeClients(
  slice: PeopleSlice,
  ctx: Context,
  ids: readonly ClientId[],
  by: string,
  cause: Seq | null,
  writes: Writes,
): PeopleSlice {
  let next = slice;
  for (const id of ids) {
    const row = next.clients.get(id);
    if (row?.removedMs !== null) continue;
    const removed: ClientRow = { ...row, removedMs: ctx.now.wall };
    next = withClient(next, removed);
    writes.push(writeNow({ table: "clients", op: "upsert", row: removed }));
    const made = [...next.tokens.values()]
      .filter((t) => t.row.createdByClient === id)
      .map((t) => t.row.id);
    const voided = voidTokens(next, made, ctx.now.wall);
    next = voided.slice;
    writes.push(...voided.out);
    writes.decide(
      peopleDecision(
        ctx,
        "client_removed",
        id,
        { person: row.personId, name: row.name, by },
        cause,
      ),
    );
    writes.push({ kind: "clientRemoved", client: id });
  }
  return next;
}

function needsUsers(slice: PeopleSlice, actor: Actor): boolean {
  return !actorHasGlobal(slice, actor, "manageUsers");
}

function personCreate(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"person.create">,
): Step {
  if (needsUsers(slice, request.actor))
    return answered(slice, request, unauthorized("manageUsers"));
  if (nameTaken(slice, body.name)) return answered(slice, request, invalid("name", "taken"));
  const writes = new Writes();
  const made = addPerson(slice, ctx, body.name, actorText(request.actor), request.record, writes);
  const object = personObject(made.slice, ctx.view, made.person);
  writes.push(answer(request, { ok: true, body: object }));
  return writes.done(made.slice);
}

/** The person a request names, live, at the revision it gives; or why not. */
function editable(
  slice: PeopleSlice,
  ctx: Context,
  person: number,
  ifRevision: number,
): Result<PersonRow, OpOutcome> {
  const row = slice.people.get(personId(person));
  if (row?.removedMs !== null) return err(notFound("person", person));
  const object = personObject(slice, ctx.view, row.id);
  if (row.revision !== ifRevision && object !== undefined)
    return err(conflict(row.revision, object));
  return ok(row);
}

function personRename(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"person.rename">,
): Step {
  if (needsUsers(slice, request.actor))
    return answered(slice, request, unauthorized("manageUsers"));
  const found = editable(slice, ctx, body.person, body.ifRevision);
  if (found.isErr()) return answered(slice, request, found.error);
  if (nameTaken(slice, body.name, found.value.id))
    return answered(slice, request, invalid("name", "taken"));
  const row: PersonRow = { ...found.value, name: body.name, revision: found.value.revision + 1 };
  const next = withPerson(slice, row);
  const writes = new Writes();
  writes.push(writeNow({ table: "people", op: "upsert", row }));
  writes.decide(
    peopleDecision(
      ctx,
      "person_renamed",
      row.id,
      { from: found.value.name, to: row.name, by: actorText(request.actor) },
      request.record,
    ),
  );
  writes.push(answer(request, { ok: true, body: personObject(next, ctx.view, row.id) }));
  return writes.done(next);
}

function personRemove(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"person.remove">,
): Step {
  if (needsUsers(slice, request.actor))
    return answered(slice, request, unauthorized("manageUsers"));
  const found = editable(slice, ctx, body.person, body.ifRevision);
  if (found.isErr()) return answered(slice, request, found.error);
  const person = found.value.id;
  if (isLastUserManager(slice, person))
    return answered(slice, request, invalid("person", "lastManager"));
  const by = actorText(request.actor);
  const writes = new Writes();
  const clients = [...slice.clients.values()]
    .filter((c) => c.personId === person && c.removedMs === null)
    .map((c) => c.id);
  let next = removeClients(slice, ctx, clients, by, request.record, writes);
  // Their unused tokens: those made for them (another device of their own).
  const forThem = [...next.tokens.values()]
    .filter((t) => t.row.personId === person)
    .map((t) => t.row.id);
  const voided = voidTokens(next, forThem, ctx.now.wall);
  next = voided.slice;
  writes.push(...voided.out);
  const row: PersonRow = {
    ...found.value,
    removedMs: ctx.now.wall,
    revision: found.value.revision + 1,
  };
  next = withPerson(next, row);
  writes.push(writeNow({ table: "people", op: "upsert", row }));
  writes.decide(
    peopleDecision(ctx, "person_removed", person, { name: row.name, by }, request.record),
  );
  writes.push(answer(request, { ok: true, body: {} }));
  return writes.done(next);
}

function permissionsSet(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"permissions.set">,
): Step {
  if (needsUsers(slice, request.actor))
    return answered(slice, request, unauthorized("manageUsers"));
  const found = editable(slice, ctx, body.person, body.ifRevision);
  if (found.isErr()) return answered(slice, request, found.error);
  const person = found.value.id;
  const sensors: ReadonlySet<number> = new Set(sensorIds(ctx.view));
  const seen = new Set<number>();
  for (const [i, entry] of body.devices.entries()) {
    if (!sensors.has(entry.device))
      return answered(slice, request, invalid(`devices.${i}.device`, "unknownReference"));
    if (seen.has(entry.device))
      return answered(slice, request, invalid(`devices.${i}.device`, "format"));
    seen.add(entry.device);
  }
  if (!body.manageUsers && isLastUserManager(slice, person))
    return answered(slice, request, invalid("manageUsers", "lastManager"));

  const writes = new Writes();
  const before = slice.permissions.get(person) ?? new Map<DeviceId, PermissionRow>();
  const rows = new Map<DeviceId, PermissionRow>();
  for (const entry of body.devices) {
    const row: PermissionRow = {
      personId: person,
      deviceId: deviceId(entry.device),
      manage: entry.manage,
      view: entry.view,
    };
    rows.set(row.deviceId, row);
    writes.push(writeNow({ table: "permissions", op: "upsert", row }));
  }
  for (const device of before.keys()) {
    if (!rows.has(device))
      writes.push(
        writeNow({
          table: "permissions",
          op: "delete",
          key: { personId: person, deviceId: device },
        }),
      );
  }
  const role: PersonRoleRow = {
    personId: person,
    manageUsers: body.manageUsers,
    manageSystem: body.manageSystem,
    revision: (slice.roles.get(person)?.revision ?? -1) + 1,
  };
  const row: PersonRow = { ...found.value, revision: found.value.revision + 1 };
  const permissions = new Map(slice.permissions);
  permissions.set(person, rows);
  const next = withPerson(withRole({ ...slice, permissions }, role), row);
  writes.push(
    writeNow({ table: "person_roles", op: "upsert", row: role }),
    writeNow({ table: "people", op: "upsert", row }),
  );
  writes.decide(
    peopleDecision(
      ctx,
      "permissions_changed",
      person,
      { by: actorText(request.actor) },
      request.record,
    ),
  );
  writes.push(answer(request, { ok: true, body: personObject(next, ctx.view, person) }));
  return writes.done(next);
}

/**
 * Switching user management on writes every permission for each person never set (section 7:
 * "keeps every existing person with every permission until someone changes them"); switching it
 * off keeps what was set, for next time.
 */
function userManagementSet(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"userManagement.set">,
): Step {
  if (needsUsers(slice, request.actor))
    return answered(slice, request, unauthorized("manageUsers"));
  if (body.on === slice.userManagement) return answered(slice, request, { ok: true, body: {} });
  const writes = new Writes();
  let next: PeopleSlice = { ...slice, userManagement: body.on };
  writes.push(
    writeNow({ table: "people_settings", op: "upsert", row: { userManagement: body.on } }),
  );
  if (body.on) {
    const permissions = new Map(next.permissions);
    for (const person of livePeople(next)) {
      if (next.roles.has(person)) continue;
      const role: PersonRoleRow = {
        personId: person,
        manageUsers: true,
        manageSystem: true,
        revision: 0,
      };
      next = withRole(next, role);
      writes.push(writeNow({ table: "person_roles", op: "upsert", row: role }));
      const rows = new Map<DeviceId, PermissionRow>();
      for (const device of sensorIds(ctx.view)) {
        const row: PermissionRow = { personId: person, deviceId: device, manage: true, view: true };
        rows.set(device, row);
        writes.push(writeNow({ table: "permissions", op: "upsert", row }));
      }
      permissions.set(person, rows);
    }
    next = { ...next, permissions };
  }
  writes.decide(
    peopleDecision(
      ctx,
      "user_management_changed",
      body.on ? 1 : 0,
      { by: actorText(request.actor) },
      request.record,
    ),
  );
  writes.push(answer(request, { ok: true, body: {} }));
  return writes.done(next);
}

/** The clients an actor may see: all with *manage users*, else their person's own. */
function visibleClients(slice: PeopleSlice, actor: Actor): readonly ClientRow[] {
  const person = actorPerson(actor);
  if (person === undefined || actorHasGlobal(slice, actor, "manageUsers"))
    return liveClients(slice);
  return liveClients(slice).filter((row) => row.personId === person);
}

function peopleList(slice: PeopleSlice, ctx: Context, request: OpRequest): Step {
  const person = actorPerson(request.actor);
  const all = person === undefined || actorHasGlobal(slice, request.actor, "manageUsers");
  const people = (all ? livePeople(slice) : livePeople(slice).filter((p) => p === person)).flatMap(
    (p) => {
      const object = personObject(slice, ctx.view, p);
      return object === undefined ? [] : [object];
    },
  );
  return answered(slice, request, {
    ok: true,
    body: {
      userManagement: slice.userManagement,
      people,
      clients: visibleClients(slice, request.actor).map(clientObject),
    },
  });
}

function clientsList(slice: PeopleSlice, request: OpRequest): Step {
  return answered(slice, request, {
    ok: true,
    body: { clients: visibleClients(slice, request.actor).map(clientObject) },
  });
}

/** Whether the actor may rename or remove this client: their own, or with *manage users*. */
function mayHandleClient(slice: PeopleSlice, actor: Actor, row: ClientRow): boolean {
  const person = actorPerson(actor);
  return (
    person === undefined ||
    (row.personId === person && isLivePerson(slice, person)) ||
    actorHasGlobal(slice, actor, "manageUsers")
  );
}

function liveClient(slice: PeopleSlice, id: number): ClientRow | undefined {
  const row = slice.clients.get(clientId(id));
  return row?.removedMs === null ? row : undefined;
}

function clientRename(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"client.rename">,
): Step {
  const row = liveClient(slice, body.client);
  if (row === undefined) return answered(slice, request, notFound("client", body.client));
  if (!mayHandleClient(slice, request.actor, row))
    return answered(slice, request, unauthorized("manageUsers"));
  const renamed: ClientRow = { ...row, name: body.name };
  const writes = new Writes();
  writes.push(writeNow({ table: "clients", op: "upsert", row: renamed }));
  writes.decide(
    peopleDecision(
      ctx,
      "client_renamed",
      row.id,
      { from: row.name, to: renamed.name, by: actorText(request.actor) },
      request.record,
    ),
  );
  writes.push(answer(request, { ok: true, body: {} }));
  return writes.done(withClient(slice, renamed));
}

/**
 * `client.remove` (section 7, "A lost device"): the client, and each of `also`, which must have
 * been linked by it within the last 30 days ‡ and not be removed (`invalid` otherwise), and be one
 * the remover may remove (`unauthorized` otherwise); all in one commit.
 */
function clientRemove(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
  body: AppOpBody<"client.remove">,
): Step {
  const row = liveClient(slice, body.client);
  if (row === undefined) return answered(slice, request, notFound("client", body.client));
  if (!mayHandleClient(slice, request.actor, row))
    return answered(slice, request, unauthorized("manageUsers"));
  const recent = ctx.deps.rules.people.recentlyLinkedMs;
  const also: ClientRow[] = [];
  for (const [i, id] of body.also.entries()) {
    const linked = liveClient(slice, id);
    if (linked?.linkedByClient !== row.id)
      return answered(slice, request, invalid(`also.${i}`, "unknownReference"));
    if (ctx.now.wall - linked.createdMs > recent)
      return answered(slice, request, invalid(`also.${i}`, "tooOld"));
    also.push(linked);
  }
  if (also.some((linked) => !mayHandleClient(slice, request.actor, linked)))
    return answered(slice, request, unauthorized("manageUsers"));
  const writes = new Writes();
  const next = removeClients(
    slice,
    ctx,
    [row.id, ...also.map((c) => c.id)],
    actorText(request.actor),
    request.record,
    writes,
  );
  writes.push(answer(request, { ok: true, body: {} }));
  return writes.done(next);
}

/** The operations of section 6 people owns, but linking's. */
export function handlePeopleOp(
  slice: PeopleSlice,
  ctx: Context,
  request: OpRequest,
): Step | undefined {
  const op = request.op;
  switch (op.op) {
    case "person.create":
      return personCreate(slice, ctx, request, op.body);
    case "person.rename":
      return personRename(slice, ctx, request, op.body);
    case "person.remove":
      return personRemove(slice, ctx, request, op.body);
    case "permissions.set":
      return permissionsSet(slice, ctx, request, op.body);
    case "userManagement.set":
      return userManagementSet(slice, ctx, request, op.body);
    case "people.list":
      return peopleList(slice, ctx, request);
    case "clients.list":
      return clientsList(slice, request);
    case "client.rename":
      return clientRename(slice, ctx, request, op.body);
    case "client.remove":
      return clientRemove(slice, ctx, request, op.body);
    default:
      return undefined;
  }
}

export { Writes };

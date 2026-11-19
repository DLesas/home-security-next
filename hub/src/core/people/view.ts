/**
 * Read-only selectors over the people module's slice that other modules may use (hub-design.md
 * section 2): who a client is, what a person or any actor may do (m2-design.md section 7), and the
 * `seq` state of a client (section 5). Every module that decides who may see or do something uses
 * these, so one rule serves requests, events, snapshots, history and notifications.
 */
import type { ClientId, DeviceId, PersonId } from "../model/ids.ts";
import type { Actor } from "../model/messages.ts";
import { ClientKind, type ClientRow, type PersonRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import {
  actorHasGlobal,
  actorMayManage,
  actorMayView,
  type GlobalPermission,
  holdersOf,
  personHasGlobal,
  personMayManage,
  personMayView,
} from "./permissions.ts";
import type { PeopleSlice, StoredReply } from "./state.ts";

export type { GlobalPermission } from "./permissions.ts";
export type { StoredReply } from "./state.ts";
export { clientObject, personObject } from "./objects.ts";
export { encodeReply, repeatOf, replyForVersion, replyOf } from "./replies.ts";

/** The slice itself, for tests. */
export function peopleSlice(view: HubState): PeopleSlice {
  return view.people;
}

/** A client that is linked and not removed. */
export function liveClient(view: HubState, client: ClientId): ClientRow | undefined {
  const row = view.people.clients.get(client);
  return row?.removedMs === null ? row : undefined;
}

/** A person, removed ones included (history names them). */
export function personRow(view: HubState, person: PersonId): PersonRow | undefined {
  return view.people.people.get(person);
}

/** The live clients of a person. */
export function clientsOf(view: HubState, person: PersonId): readonly ClientId[] {
  return [...view.people.clients.values()]
    .filter((row) => row.personId === person && row.removedMs === null)
    .map((row) => row.id);
}

/** The hub's static public key for apps, whose hash is its app identity (section 5). */
export function appStaticPublic(view: HubState): Uint8Array | undefined {
  return view.people.appStaticPublic;
}

/** Whether user management is on (D13). */
export function userManagementOn(view: HubState): boolean {
  return view.people.userManagement;
}

/**
 * The actor a live client acts as (section 2's `Actor`): the console for kind 0, else its person
 * with the actor text `commands.actor` holds, `"Anna (client 7)"` (section 4). Undefined for a
 * client that is not live, or whose person is removed.
 */
export function actorOfClient(view: HubState, client: ClientId): Actor | undefined {
  const row = liveClient(view, client);
  if (row === undefined) return undefined;
  if (row.kind === ClientKind.Console || row.personId === null) return { kind: "console", client };
  const person = view.people.people.get(row.personId);
  if (person?.removedMs !== null) return undefined;
  return { kind: "person", person: person.id, client, name: `${person.name} (client ${client})` };
}

export function mayManage(view: HubState, actor: Actor, device: DeviceId): boolean {
  return actorMayManage(view.people, actor, device);
}

export function mayView(view: HubState, actor: Actor, device: DeviceId): boolean {
  return actorMayView(view.people, actor, device);
}

export function hasGlobal(view: HubState, actor: Actor, permission: GlobalPermission): boolean {
  return actorHasGlobal(view.people, actor, permission);
}

/** Of `devices`, those the actor may not manage (`unauthorized`'s `devices`, section 5). */
export function notManaged(
  view: HubState,
  actor: Actor,
  devices: readonly DeviceId[],
): readonly DeviceId[] {
  return devices.filter((device) => !actorMayManage(view.people, actor, device));
}

export function personMayViewDevice(view: HubState, person: PersonId, device: DeviceId): boolean {
  return personMayView(view.people, person, device);
}

export function personMayManageDevice(view: HubState, person: PersonId, device: DeviceId): boolean {
  return personMayManage(view.people, person, device);
}

export function personHas(view: HubState, person: PersonId, permission: GlobalPermission): boolean {
  return personHasGlobal(view.people, person, permission);
}

/** Every live person who may view a device now (notifications' recipients, D69, D76). */
export function peopleWhoMayView(view: HubState, device: DeviceId): readonly PersonId[] {
  return [...view.people.people.keys()].filter((p) => personMayView(view.people, p, device));
}

/** Every live person with a global permission now (notices about the hub as a whole). */
export function peopleWith(view: HubState, permission: GlobalPermission): readonly PersonId[] {
  return holdersOf(view.people, permission);
}

/** A client's highest accepted `seq`, 0 before the first (section 5). */
export function lastSeq(view: HubState, client: ClientId): number {
  return view.people.clients.get(client)?.lastSeq ?? 0;
}

/** The reply kept for a client's `seq`, or undefined when none is kept (section 5). */
export function storedReply(
  view: HubState,
  client: ClientId,
  seq: number,
): StoredReply | undefined {
  return view.people.replies.get(client)?.get(seq);
}

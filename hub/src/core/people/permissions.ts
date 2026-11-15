/**
 * Who may do what (m2-design.md section 7, "People and permissions"; D13, D33, D61, HB5a), as pure
 * functions of the people slice. Every check of the core goes through these, for requests,
 * events, snapshots, history and notifications alike.
 *
 * - User management off (the default): every person has every permission (D13). The rows are
 *   kept, not applied.
 * - On: a person whose permissions were never set (no `person_roles` row) still has every one
 *   (section 7: "switching it on keeps every existing person with every permission until someone
 *   changes them"); `userManagement.set` writes those rows when it switches on, so this case is
 *   only a database written before it. Otherwise the rows decide: per sensor *manage* and *view*,
 *   *manage* including *view* ‡ (`HubRules.people.manageIncludesView`); globally *manage users* and
 *   *manage system*.
 * - A removed person has none. The console (kind 0), the hub computer and a schedule entry have
 *   every permission (D61, HD 9, section 7 "Schedules"); "only on the console listener" (C) is a
 *   property of the session, checked by `app`.
 */
import type { DeviceId, PersonId } from "../model/ids.ts";
import type { Actor } from "../model/messages.ts";
import type { PermissionRow, PersonRoleRow } from "../model/rows.ts";
import type { PeopleSlice } from "./state.ts";

/** A global permission (D33). */
export type GlobalPermission = "manageUsers" | "manageSystem";

/** A person who exists and is not removed. */
export function isLivePerson(slice: PeopleSlice, person: PersonId): boolean {
  const row = slice.people.get(person);
  return row?.removedMs === null;
}

/** Whether the person's own permissions decide (user management on, and set for them). */
function rowsApply(slice: PeopleSlice, person: PersonId): PersonRoleRow | undefined {
  return slice.userManagement ? slice.roles.get(person) : undefined;
}

export function personHasGlobal(
  slice: PeopleSlice,
  person: PersonId,
  permission: GlobalPermission,
): boolean {
  if (!isLivePerson(slice, person)) return false;
  const role = rowsApply(slice, person);
  return role === undefined || role[permission];
}

function deviceRow(
  slice: PeopleSlice,
  person: PersonId,
  device: DeviceId,
): PermissionRow | undefined {
  return slice.permissions.get(person)?.get(device);
}

export function personMayManage(slice: PeopleSlice, person: PersonId, device: DeviceId): boolean {
  if (!isLivePerson(slice, person)) return false;
  if (rowsApply(slice, person) === undefined) return true;
  return deviceRow(slice, person, device)?.manage ?? false;
}

export function personMayView(slice: PeopleSlice, person: PersonId, device: DeviceId): boolean {
  if (!isLivePerson(slice, person)) return false;
  if (rowsApply(slice, person) === undefined) return true;
  const row = deviceRow(slice, person, device);
  return row !== undefined && (row.view || row.manage);
}

/** The person an actor acts as, or undefined for one with every permission. */
export function actorPerson(actor: Actor): PersonId | undefined {
  return actor.kind === "person" ? actor.person : undefined;
}

export function actorHasGlobal(
  slice: PeopleSlice,
  actor: Actor,
  permission: GlobalPermission,
): boolean {
  const person = actorPerson(actor);
  return person === undefined || personHasGlobal(slice, person, permission);
}

export function actorMayManage(slice: PeopleSlice, actor: Actor, device: DeviceId): boolean {
  const person = actorPerson(actor);
  return person === undefined || personMayManage(slice, person, device);
}

export function actorMayView(slice: PeopleSlice, actor: Actor, device: DeviceId): boolean {
  const person = actorPerson(actor);
  return person === undefined || personMayView(slice, person, device);
}

/** The live people who hold a global permission now. */
export function holdersOf(slice: PeopleSlice, permission: GlobalPermission): readonly PersonId[] {
  return [...slice.people.keys()].filter((p) => personHasGlobal(slice, p, permission));
}

/**
 * Whether taking *manage users* from `person`, or removing them, would leave no live person
 * with it while user management is on (section 7 ‡, `HubRules.people.keepLastUserManager`).
 */
export function isLastUserManager(slice: PeopleSlice, person: PersonId): boolean {
  if (!slice.userManagement || !personHasGlobal(slice, person, "manageUsers")) return false;
  return holdersOf(slice, "manageUsers").every((holder) => holder === person);
}

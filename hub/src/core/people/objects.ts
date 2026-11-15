/**
 * People and clients as the app channel carries them (`personObject`, `clientObject`,
 * m2-design.md section 6), built from the slice.
 */
import { Role } from "@hsn/protocol";
import type { ClientObject, PersonObject } from "@hsn/protocol/app";
import type { DeviceId, PersonId } from "../model/ids.ts";
import { ClientKind, type ClientRow, DeviceState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { registeredDevices } from "../registry/view.ts";
import type { PeopleSlice } from "./state.ts";

/** Every sensor not removed: what "every permission" covers (D33: per sensor). */
export function sensorIds(view: HubState): readonly DeviceId[] {
  return registeredDevices(view)
    .filter((row) => row.role === Role.Sensor && row.state !== DeviceState.Removed)
    .map((row) => row.id);
}

/**
 * A person with their permissions as set. One never set (no `person_roles` row) is shown with
 * every permission, which is what they have (section 7). `revision` is the person's: a rename and
 * a change of permissions both move it, so `ifRevision` guards the person as one object.
 */
export function personObject(
  slice: PeopleSlice,
  view: HubState,
  person: PersonId,
): PersonObject | undefined {
  const row = slice.people.get(person);
  if (row === undefined) return undefined;
  const role = slice.roles.get(person);
  if (role === undefined) {
    return {
      id: row.id,
      name: row.name,
      manageUsers: true,
      manageSystem: true,
      devices: sensorIds(view).map((device) => ({ device, manage: true, view: true })),
      revision: row.revision,
    };
  }
  const devices = [...(slice.permissions.get(person)?.values() ?? [])]
    .toSorted((a, b) => a.deviceId - b.deviceId)
    .map((p) => ({ device: p.deviceId, manage: p.manage, view: p.view }));
  return {
    id: row.id,
    name: row.name,
    manageUsers: role.manageUsers,
    manageSystem: role.manageSystem,
    devices,
    revision: row.revision,
  };
}

const KIND_NAMES = {
  [ClientKind.Console]: "console",
  [ClientKind.Web]: "web",
  [ClientKind.Phone]: "phone",
} as const;

export function clientObject(row: ClientRow): ClientObject {
  return {
    id: row.id,
    person: row.personId,
    kind: KIND_NAMES[row.kind],
    name: row.name,
    createdMs: row.createdMs,
    lastSeenMs: row.lastSeenMs,
    linkedBy: row.linkedByClient,
  };
}

/** The clients not removed, by number. */
export function liveClients(slice: PeopleSlice): readonly ClientRow[] {
  return [...slice.clients.values()]
    .filter((row) => row.removedMs === null)
    .toSorted((a, b) => a.id - b.id);
}

/** The people not removed, by number. */
export function livePeople(slice: PeopleSlice): readonly PersonId[] {
  return [...slice.people.values()]
    .filter((row) => row.removedMs === null)
    .map((row) => row.id)
    .toSorted((a, b) => a - b);
}

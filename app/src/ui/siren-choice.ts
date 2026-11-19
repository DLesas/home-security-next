/**
 * Which sirens sound for a group (D144; docs/app-design.md, "Which sirens sound"). A group sounds
 * every siren, or the sirens chosen for it; when none of its chosen sirens is left (each removed,
 * or reset by its owner and not yet added again), the hub sounds every siren for it, so a group
 * can never sound nothing. The app says so on the group's page, and asks before any action of its
 * own brings it about. Pure, from what the snapshot carries: each device's `state` says a siren is
 * reset (`resetByOwner`) or removed (`removed`); a siren the snapshot no longer lists is taken as
 * removed (sirens are listed to every person, m2-design.md section 6, `arm`: "sirens and
 * gateways: any").
 */
import type { DeviceObject, GroupObject } from "@hsn/protocol/app";
import { deviceName, listOf, type Translate } from "../state/words";

type Devices = Readonly<Record<number, DeviceObject>>;
export type SirenChoice = GroupObject["sirens"];

/** A siren still in use: listed, and neither removed nor reset by its owner. */
export function sirenInUse(device: DeviceObject | undefined): boolean {
  return device?.role === "siren" && device.state !== "removed" && device.state !== "resetByOwner";
}

/** What sounds for a group: every siren by choice, its own sirens in use, or every siren since none is left. */
export type SirensSound =
  | { readonly kind: "every" }
  | { readonly kind: "these"; readonly sirens: readonly number[] }
  | { readonly kind: "noneLeft" };

export function sirensSound(choice: SirenChoice, devices: Devices): SirensSound {
  if (choice === "all") return { kind: "every" };
  const left = choice.filter((id) => sirenInUse(devices[id]));
  return left.length === 0 ? { kind: "noneLeft" } : { kind: "these", sirens: left };
}

/** The devices as they would be once `siren` is gone (removed or reset). */
function without(devices: Devices, siren: number): Devices {
  const device = devices[siren];
  return device === undefined ? devices : { ...devices, [siren]: { ...device, state: "removed" } };
}

/**
 * The groups that removing or resetting `siren` would leave with none of their own sirens, so
 * that every siren sounds for them: each had sirens of its own in use, and `siren` was the last.
 * A group on "every siren", or one already left with none, is not changed by it.
 */
export function groupsLeftWithout(
  groups: readonly GroupObject[],
  devices: Devices,
  siren: number,
): readonly GroupObject[] {
  const after = without(devices, siren);
  return groups.filter(
    (group) =>
      sirensSound(group.sirens, devices).kind === "these" &&
      sirensSound(group.sirens, after).kind === "noneLeft",
  );
}

/** The groups a `group_sirens_gone` record names: its `detail`, u32 little-endian each. */
export function groupsOfDetail(detail: string | null): readonly number[] {
  if (detail === null || detail.length % 8 !== 0 || !/^[0-9a-f]*$/iu.test(detail)) return [];
  const ids: number[] = [];
  for (let at = 0; at < detail.length; at += 8) {
    const bytes = [0, 1, 2, 3].map((i) => parseInt(detail.slice(at + 2 * i, at + 2 * i + 2), 16));
    ids.push(bytes.reduce((sum, byte, i) => sum + byte * 2 ** (8 * i), 0));
  }
  return ids;
}

/**
 * The hub's history record of D144 (`group_sirens_gone`): a siren gone left groups none of their
 * own. No one is notified of it (the product owner's correction to D144): only the person who
 * removes a siren is told, by the dialog that asks first (`siren-dialog.tsx`).
 */
export const SIRENS_GONE = "group_sirens_gone";

/** Groups by id, as the live store keeps them. */
type Groups = Readonly<Record<number, GroupObject>>;

/**
 * D144's history record in words: the siren was removed or reset, so these groups have none of
 * their own sirens left and every siren will sound for them; without the groups' names (a record
 * with none), that a group was left so and where to see which.
 */
export function sirensGoneWords(
  t: Translate,
  facts: { readonly devices: Devices; readonly groups: Groups },
  language: string,
  siren: number,
  groups: readonly number[],
): string {
  const name = deviceName(t, facts, siren);
  if (groups.length === 0) return t("sirens.goneNoGroups", { siren: name });
  return t("sirens.gone", {
    count: groups.length,
    siren: name,
    groups: listOf(
      groups.map((id) => facts.groups[id]?.name ?? t("common.groupNumber", { id })),
      language,
    ),
  });
}

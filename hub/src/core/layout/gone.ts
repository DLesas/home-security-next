/**
 * D144: a group whose chosen sirens are all gone sounds every siren. Only the person who causes it
 * is told, by the app's dialog before they do it; nobody is sent a notification. The hub keeps a
 * record of it in the history: `layout` records `group_sirens_gone` once per occurrence, naming
 * the siren and the groups. `notify` raises nothing from it.
 *
 * - **Such a group** chose sirens (`allSirens` false) and none of them is in use: each is reset by
 *   its owner (kept in the group until it is added again or removed, H1) or gone. In use means
 *   what `triggerSirens` counts: a siren whose registry row still has its name (`isNamed`). A group
 *   on "every siren" is never one.
 * - **A removal** of a group's last siren in use turns the group to every siren (`handle.ts`'s
 *   `onDeviceRemoved`), so it is no longer such a group afterwards; that removal is an occurrence
 *   all the same, unless the group was already one (its sirens reset before, already recorded).
 * - **Once per occurrence.** The slice keeps which groups are such groups now (`sirensGone`,
 *   memory only). A group that stops being one (its siren added again, other sirens chosen, every
 *   siren chosen, the group deleted) leaves the set without a record of its own, as no ending of
 *   this module is recorded elsewhere; a later occurrence is recorded again.
 * - **Only as it arises in a step, never at a start.** A start rebuilds the set from the stored
 *   groups and the registry and records nothing: the reset or removal that made the state is in
 *   the history already, with this record beside it when it arose under this rule. So a restart
 *   never records the same occurrence twice; one that arose before this record existed has only
 *   its reset or removal in the history.
 * - **Who asked.** The record's `value` is the client that asked for the change (a `device.remove`
 *   from the app or `hsn`, its actor text's ` (client <n>)`; a group's change, its actor's
 *   client), for the history; null when nobody asked (the siren's own button, a board seen reset
 *   on USB, `hsn`).
 */
import { err, ok } from "neverthrow";
import type { Context } from "../model/handler.ts";
import {
  type ClientId,
  clientId,
  type DeviceId,
  type GroupId,
  groupId,
  type Seq,
} from "../model/ids.ts";
import { DeviceState } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { deviceById, isNamed } from "../registry/view.ts";
import { decision } from "../util/records.ts";
import type { Changing, Out } from "./out.ts";
import type { Group, LayoutSlice } from "./state.ts";

/** The decision kind (`@hsn/protocol/records`). */
export const SIRENS_GONE = "group_sirens_gone";

/** What brought the change about, for the record. */
export interface GoneCause {
  /** The siren removed or reset; undefined when no one siren did (a group's change, a start). */
  readonly siren: DeviceId | undefined;
  /** The client that asked for it; null when nobody asked. */
  readonly client: ClientId | null;
  /** The request's record, for the decision's cause. */
  readonly record: Seq | undefined;
}

export const NOBODY_ASKED: GoneCause = { siren: undefined, client: null, record: undefined };

function inUse(view: HubState, siren: DeviceId): boolean {
  return isNamed(deviceById(view, siren)?.state ?? DeviceState.Removed);
}

/** The groups that chose sirens and have none of them in use, ascending. */
export function withoutOwnSirens(slice: LayoutSlice, view: HubState): readonly GroupId[] {
  return [...slice.groups.values()]
    .filter((g) => !g.allSirens && g.sirens.length > 0 && g.sirens.every((s) => !inUse(view, s)))
    .map((g) => g.id)
    .sort((a, b) => a - b);
}

/** The client a request's actor text names (` (client <n>)`, m2-design section 7); null for none. */
export function clientOfActorText(actor: string): ClientId | null {
  const found = / \(client (\d+)\)$/u.exec(actor);
  return found?.[1] === undefined ? null : clientId(Number(found[1]));
}

/** Group ids, u32 LE each: the record's `detail`. */
export function groupBytes(groups: readonly GroupId[]): Uint8Array {
  const bytes = new Uint8Array(groups.length * 4);
  const data = new DataView(bytes.buffer);
  groups.forEach((group, i) => {
    data.setUint32(i * 4, group, true);
  });
  return bytes;
}

/** The groups a record's or a notification's `detail` names. */
export function groupsOf(detail: Uint8Array | null): readonly GroupId[] {
  if (detail === null) return [];
  const data = new DataView(detail.buffer, detail.byteOffset, detail.byteLength);
  const groups: GroupId[] = [];
  for (let at = 0; at + 4 <= detail.byteLength; at += 4)
    groups.push(groupId(data.getUint32(at, true)));
  return groups;
}

/** The siren of a group reset most recently: the one a record names when no one siren did. */
function newestReset(view: HubState, group: Group): DeviceId | undefined {
  let best: { readonly siren: DeviceId; readonly at: number } | undefined;
  for (const siren of group.sirens) {
    const at = deviceById(view, siren)?.removedMs ?? -1;
    if (best === undefined || at > best.at) best = { siren, at };
  }
  return best?.siren;
}

/** One record per siren, naming its groups. */
function records(
  ctx: Context,
  fresh: readonly GroupId[],
  slice: LayoutSlice,
  cause: GoneCause,
): Changing {
  const bySiren = new Map<DeviceId | null, GroupId[]>();
  for (const id of fresh) {
    const group = slice.groups.get(id);
    const siren =
      cause.siren ?? (group === undefined ? undefined : newestReset(ctx.view, group)) ?? null;
    bySiren.set(siren, [...(bySiren.get(siren) ?? []), id]);
  }
  const out: Out[number][] = [];
  for (const [siren, groups] of bySiren) {
    const decided = decision(ctx, "now", {
      kind: SIRENS_GONE,
      device: siren,
      value: cause.client,
      detail: groupBytes(groups),
      cause: cause.record,
    });
    if (decided.isErr()) return err(decided.error);
    out.push(decided.value.message);
  }
  return ok({ slice, out });
}

/**
 * After a change to the groups or the devices: records the groups that have become such groups,
 * and those a removal turned to every siren (`emptied`) that were not such groups already; keeps
 * the set of such groups.
 */
export function settleSirens(
  slice: LayoutSlice,
  ctx: Context,
  cause: GoneCause,
  emptied: readonly GroupId[],
): Changing {
  const now = withoutOwnSirens(slice, ctx.view);
  const fresh = [...new Set([...now, ...emptied])]
    .filter((g) => !slice.sirensGone.has(g))
    .sort((a, b) => a - b);
  const next: LayoutSlice = { ...slice, sirensGone: new Set(now) };
  return fresh.length === 0 ? ok({ slice: next, out: [] }) : records(ctx, fresh, next, cause);
}

/** At a start: the set rebuilt from the stored groups and the registry; nothing recorded. */
export function sirensAtStart(slice: LayoutSlice, view: HubState): LayoutSlice {
  return { ...slice, sirensGone: new Set(withoutOwnSirens(slice, view)) };
}

/** The groups a removal turned to every siren: they had chosen sirens before and have none now. */
export function emptiedBy(before: LayoutSlice, after: LayoutSlice): readonly GroupId[] {
  return [...after.groups.values()]
    .filter((g) => g.allSirens && before.groups.get(g.id)?.allSirens === false)
    .map((g) => g.id);
}

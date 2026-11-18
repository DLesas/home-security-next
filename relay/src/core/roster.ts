/**
 * The roster rules (docs/m4-design.md sections 3 and 5): a hub's `roster` is the whole set of
 * its phones' targets each time, and the relay turns the hub's `push {items: [{id, key, h}]}`
 * into the push service's items `{id, hub, platform, env, token, h}` through it. The relay's own
 * alerts are each target's pre-sealed `unreachable` or `back`, sent as they are (D127). Pure.
 *
 * An item whose key id the roster does not hold is answered `failed`, not `badToken`: the hub's
 * newest roster may simply not have arrived, and `badToken` would make the hub drop the phone's
 * target (section 4, "Results"); `failed` is retried.
 */
import type { HubPushItem, RelayPushItem, RosterTarget } from "@hsn/protocol/relay";

/** A hub's targets by key id. */
export type Targets = ReadonlyMap<string, RosterTarget>;

export function targetsOf(list: readonly RosterTarget[]): Targets {
  return new Map(list.map((target) => [target.key, target]));
}

/** A relay push item without the relay's own id, with what it answers on the hub's side. */
export interface ResolvedItem {
  /** The hub's item id, or null for the relay's own alert. */
  readonly hubId: number | null;
  /** The target's key id, so a `badToken` can drop it. */
  readonly key: string;
  readonly item: Omit<RelayPushItem, "id">;
}

/** A hub's push items through its roster: those it can send, and the ids of those it cannot. */
export function resolvePush(
  hub: string,
  items: readonly HubPushItem[],
  targets: Targets,
): { readonly send: readonly ResolvedItem[]; readonly unknown: readonly number[] } {
  const send: ResolvedItem[] = [];
  const unknown: number[] = [];
  for (const item of items) {
    const target = targets.get(item.key);
    if (target === undefined) {
      unknown.push(item.id);
      continue;
    }
    send.push({
      hubId: item.id,
      key: item.key,
      item: { hub, platform: target.platform, env: target.env, token: target.token, h: item.h },
    });
  }
  return { send, unknown };
}

/** The relay's own alert to every target of a hub: its sealed `unreachable` or `back`. */
export function alertItems(
  hub: string,
  targets: Targets,
  alert: "unreachable" | "back",
): readonly ResolvedItem[] {
  return [...targets.values()].map((target) => ({
    hubId: null,
    key: target.key,
    item: {
      hub,
      platform: target.platform,
      env: target.env,
      token: target.token,
      h: alert === "unreachable" ? target.unreachable : target.back,
    },
  }));
}

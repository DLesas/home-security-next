/**
 * Read-only selectors over the relay module's slice that other modules may use (hub-design.md
 * section 2; docs/m4-design.md section 9):
 *
 * - `relayInUse`: `hub.info`'s `relay` (`{url}`, or null when the hub has none) for `app`;
 * - `relayForLinkCode`: a link code's `r=`, present only when the hub's relay is not the default;
 * - `pushTargetState`: the snapshot's `push` for the asking client (`{registered, valid}` for a
 *   phone, null for any other client);
 * - `relayStatus`: `relay.status` as it stands, for the `hub` event's `what: "relay"`.
 */
import type { RelayStatusObject } from "@hsn/protocol/app";
import type { ClientId } from "../model/ids.ts";
import { ClientKind } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { liveClient } from "../people/view.ts";
import { statusOf, urlInUse } from "./settings.ts";
import type { RelaySlice } from "./state.ts";

/** The slice itself, for tests and the owner's first selectors. */
export function relaySlice(view: HubState): RelaySlice {
  return view.relay;
}

/** `hub.info`'s `relay`: the relay in use, or null when there is none. */
export function relayInUse(view: HubState): { readonly url: string } | null {
  const url = urlInUse(view.relay);
  return url === null ? null : { url };
}

/** A link code's `r=`: the relay a person set, or null when the hub uses the default's. */
export function relayForLinkCode(view: HubState): string | null {
  const { url } = view.relay.settings;
  return url === view.relay.defaultUrl ? null : url;
}

/** The snapshot's `push` for `client`: for a phone whether the hub holds a target and it is valid. */
export function pushTargetState(
  view: HubState,
  client: ClientId,
): { readonly registered: boolean; readonly valid: boolean } | null {
  if (liveClient(view, client)?.kind !== ClientKind.Phone) return null;
  const target = view.relay.targets.get(client);
  return { registered: target !== undefined, valid: target?.invalidMs === null };
}

/** `relay.status` as it stands. */
export function relayStatus(view: HubState): RelayStatusObject {
  return statusOf(view.relay);
}

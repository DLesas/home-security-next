/**
 * The live events only channel version 2 names, to version 2 sessions only (a version 1 session
 * is never sent one: its client parses `hub`'s `what` strictly, and knows no `deviceUpdate`):
 *
 * - `hub {what: "relay"}` (m4-design section 9): whenever the relay in use or its link's state
 *   changes, whatever changed it (`relay.set`, the link going up or down), with `relay.status`'s
 *   `url`, `isDefault`, `state` and `sinceMs`; to people with manage system and the console.
 *   Made from `relay`'s view at every step, compared with what was last told (never a reference to
 *   `relay`'s slice, so `app`'s state depends only on what the relay's view says).
 * - `hub {what: "updateOffered"}` (m4-design section 9): `upkeep`'s `update_offered` decision
 *   (once per version), with the offer's version and size from its view; to the same people.
 * - `deviceUpdate` (m3-updates-design section 4): `firmware`'s `deviceUpdateEvent`, the body as
 *   made, to version 2 sessions in `devices` whose person has manage system (`updates.ts`).
 */
import type { AuditRecord } from "../model/audit.ts";
import type { DeviceUpdateEventBody } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";
import { hasGlobal } from "../people/view.ts";
import { relayStatus } from "../relay/view.ts";
import { hubReleaseOffer } from "../upkeep/view.ts";
import type { Sending } from "./events.ts";
import { deviceUpdateFrames } from "./updates.ts";

function relayKey(view: HubState): {
  readonly key: string;
  readonly detail: Record<string, string | number | boolean | null>;
} {
  const status = relayStatus(view);
  const detail = {
    url: status.url,
    isDefault: status.isDefault,
    state: status.state,
    sinceMs: status.sinceMs,
  };
  return { key: JSON.stringify([status.url, status.isDefault, status.state]), detail };
}

/** `hub {what: "relay"}` when the relay in use or its state changed since last told. */
export function relayChanges(sending: Sending, view: HubState): void {
  const { key, detail } = relayKey(view);
  const before = sending.slice.relaySent;
  if (before === key) return;
  sending.slice = { ...sending.slice, relaySent: key };
  if (before === undefined) return;
  sending.versioned(view, "hub", {
    v2: (_session, actor) =>
      hasGlobal(view, actor, "manageSystem") ? { what: "relay", detail } : undefined,
  });
}

/** `hub {what: "updateOffered"}` from `upkeep`'s `update_offered` decision. */
export function offeredEvents(sending: Sending, view: HubState, record: AuditRecord): void {
  if (record.kind !== "decision" || record.row.kind !== "update_offered") return;
  const offer = hubReleaseOffer(view);
  const detail = { version: offer?.version ?? null, bytes: offer?.bytes ?? null };
  sending.versioned(view, "hub", {
    v2: (_session, actor) =>
      hasGlobal(view, actor, "manageSystem") ? { what: "updateOffered", detail } : undefined,
  });
}

/** `firmware`'s `deviceUpdate`, to the version 2 sessions `deviceUpdateFrames` names. */
export function deviceUpdateEvents(
  sending: Sending,
  view: HubState,
  body: DeviceUpdateEventBody,
): void {
  if (deviceUpdateFrames(sending.slice, view, body, 0).length === 0) return;
  const rev = sending.rev();
  for (const frame of deviceUpdateFrames(sending.slice, view, body, rev))
    sending.out.push({ kind: "appSend", conn: frame.conn, message: frame.message });
}

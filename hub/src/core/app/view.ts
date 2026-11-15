/**
 * Read-only selectors over the app module's slice that other modules may use (hub-design.md
 * section 2): the sessions, so `notify` can deliver to them; the live revision; and, for `people`,
 * which client and `seq` a request `app` numbered for an M1a module belongs to.
 */
import type { ClientId, ConnId, RequestId } from "../model/ids.ts";
import type { HubState } from "../model/state.ts";
import type { AppSlice, HubFacts, Session } from "./state.ts";

export type { HubFacts, Session } from "./state.ts";

/** The slice itself, for tests. */
export function appSlice(view: HubState): AppSlice {
  return view.app;
}

/** The change a request to an M1a module carries: its client and `seq`, or undefined for a read. */
export function appRequestChange(
  view: HubState,
  request: RequestId,
): { readonly client: ClientId; readonly seq: number } | undefined {
  const key = view.app.m1a.get(request);
  const pending = key === undefined ? undefined : view.app.pending.get(key);
  const seq = pending?.answerTo.seq;
  return pending === undefined || seq === undefined
    ? undefined
    : { client: pending.answerTo.client, seq };
}

/** The open sessions, by connection. */
export function sessions(view: HubState): ReadonlyMap<ConnId, Session> {
  return view.app.sessions;
}

/** A client's open sessions. */
export function sessionsOfClient(view: HubState, client: ClientId): readonly Session[] {
  return [...view.app.sessions.values()].filter((s) => s.client === client);
}

/** The live revision of the last event sent (section 5). */
export function liveRevision(view: HubState): number {
  return view.app.rev;
}

/** The shell's latest `hubFacts` (section 2), for `hub.info` and the link formats; undefined until the first. */
export function hubFacts(view: HubState): HubFacts | undefined {
  return view.app.facts;
}

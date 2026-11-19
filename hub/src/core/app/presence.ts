/**
 * Presence (M5; docs/m3-design.md section 6; AP11, D25, D98): `presence.set {away}`, the phone
 * itself telling the hub that it left or arrived, and the hub's rule for its two offers. The
 * phone works out leaving and arriving by itself; no location reaches the hub (D59).
 *
 * **The rule** (H1; the design's reading of the product owner's open question 4, "every opted-in
 * person has left"):
 *
 * - A person is **opted in** while one of their phones has reported since the hub started.
 *   A person is **away** when every one of their phones that has reported says away, **home**
 *   when any of them says home.
 * - **Away**: a report that makes every opted-in person away, when before it some opted-in person
 *   was home (or nobody was opted in), and no sensor is armed, offers Away to every opted-in
 *   person: `presence_offer_away`, with the action `armAway`.
 * - **Disarm**: a report of arriving from a phone that was not already home, of a person none of
 *   whose other phones was home, while any sensor is armed, offers Disarm to that person:
 *   `presence_offer_disarm`, with the action `disarm`. A phone reports only when it arrives, so
 *   an arrival after a hub restart (the phone not known yet) counts as one.
 * - A repeated report changes nothing and offers nothing. Nothing is ever armed or disarmed here:
 *   each offer is a decision record, which `notify` turns into a notification of the same kind to
 *   the people its detail names, and `relay` pushes with its one action (D25).
 *
 * **Memory only.** What each phone last said is kept in `app`'s slice, never written (the frozen
 * schema has no table for it): after a restart the hub knows only the phones that have reported
 * since. A phone or person removed is forgotten at once (`clientRemoved`).
 *
 * `presence.set` is a change (with `seq`): its `commands` row is `app`'s as for any change.
 */
import { NOT_A_PHONE } from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import { anySensorArmed } from "../alarm/view.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import { type ClientId, type PersonId, type Seq } from "../model/ids.ts";
import type { Actor, Internal, OpOutcome } from "../model/messages.ts";
import { ClientKind } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { liveClient } from "../people/view.ts";
import { decision } from "../util/records.ts";

/** What one phone last said: away or home, with its person. */
export interface PhonePresence {
  readonly person: PersonId;
  readonly away: boolean;
}

export type PresenceMap = ReadonlyMap<ClientId, PhonePresence>;

/** The notification kinds of the two offers, the decisions' own (`PRESENCE_OFFER_KINDS`). */
export const PRESENCE_OFFERS = {
  armAway: "presence_offer_away",
  disarm: "presence_offer_disarm",
} as const;

/** Each opted-in person, and whether they are away. */
export function peopleAway(presence: PresenceMap): ReadonlyMap<PersonId, boolean> {
  const people = new Map<PersonId, boolean>();
  for (const phone of presence.values())
    people.set(phone.person, (people.get(phone.person) ?? true) && phone.away);
  return people;
}

function everyoneAway(people: ReadonlyMap<PersonId, boolean>): boolean {
  return people.size > 0 && [...people.values()].every((away) => away);
}

/** People as a decision's detail: u32 little-endian each, in number order. */
export function peopleDetail(people: readonly PersonId[]): Uint8Array {
  const bytes = new Uint8Array(people.length * 4);
  const data = new DataView(bytes.buffer);
  for (const [i, person] of people.toSorted((a, b) => a - b).entries())
    data.setUint32(i * 4, person, true);
  return bytes;
}

/** What `presence.set` does: the new map, its offers' records, and its outcome. */
export interface PresenceStep {
  readonly presence: PresenceMap;
  readonly out: readonly Internal[];
  readonly outcome: OpOutcome;
}

/**
 * `presence.set {away}` from `actor`: only a linked phone's own report (`NOT_A_PHONE` for any
 * other client, the console or the hub computer). `cause` is the request's `commands` record.
 */
export function presenceSet(
  view: HubState,
  ctx: Context,
  presence: PresenceMap,
  actor: Actor,
  away: boolean,
  cause: Seq,
): Result<PresenceStep, CoreFault> {
  const phone = actor.kind === "person" ? liveClient(view, actor.client) : undefined;
  if (actor.kind !== "person" || phone?.kind !== ClientKind.Phone)
    return ok({ presence, out: [], outcome: { ok: false, error: NOT_A_PHONE } });
  const person = actor.person;
  const said = presence.get(phone.id);
  const done: PresenceStep = { presence, out: [], outcome: { ok: true, body: {} } };
  if (said?.away === away && said.person === person) return ok(done);
  const next = new Map(presence);
  next.set(phone.id, { person, away });
  const before = peopleAway(presence);
  const after = peopleAway(next);
  const armed = anySensorArmed(view);
  const out: Internal[] = [];
  if (away && !armed && everyoneAway(after) && !everyoneAway(before)) {
    const offered = offer(ctx, "presence_offer_away", [...after.keys()], undefined, cause);
    if (offered.isErr()) return err(offered.error);
    out.push(offered.value);
  }
  const otherHome = [...presence]
    .filter(([client]) => client !== phone.id)
    .some(([, other]) => other.person === person && !other.away);
  if (!away && said?.away !== false && !otherHome && armed) {
    const offered = offer(ctx, "presence_offer_disarm", [person], person, cause);
    if (offered.isErr()) return err(offered.error);
    out.push(offered.value);
  }
  return ok({ presence: next, out, outcome: done.outcome });
}

function offer(
  ctx: Context,
  kind: "presence_offer_away" | "presence_offer_disarm",
  people: readonly PersonId[],
  value: number | undefined,
  cause: Seq,
): Result<Internal, CoreFault> {
  return decision(ctx, "routine", {
    kind,
    device: null,
    cause,
    value: value ?? null,
    detail: peopleDetail(people),
  }).map((made) => made.message);
}

/** A removed client's report is forgotten, so its person may no longer count as opted in. */
export function presenceWithout(presence: PresenceMap, client: ClientId): PresenceMap {
  if (!presence.has(client)) return presence;
  const next = new Map(presence);
  next.delete(client);
  return next;
}

/**
 * The relay link's state and its records (docs/m4-design.md section 4, "Connecting, back-off,
 * keepalive" and "Records"). Keepalive never reaches the core: it hears `up` and `down` only.
 *
 * - **State.** `up` once the relay's `joined` came; `down` from the start and after any failure,
 *   with its reason for `relay.status`. An event for another URL than the one in use (a link the
 *   shell is closing after `relay.set`) is not this link's and is ignored, as is any while no
 *   relay is in use.
 * - **`relay_link`** (info, routine): the ups and downs of each period of
 *   `HubRules.relay.linkRecordEveryMs` (an hour ‡) in which any happened, with the longest down,
 *   one record per period, so a flapping link costs no commit.
 * - **`relay_unreachable`** (a warning, written now): the link down `unreachableAfterMs` (180 s ‡),
 *   once per outage, counted from the start too, since a hub that cannot join is as unreachable.
 *   `relay_reachable` (info, routine) when it is up again after that.
 * - **`relay_identity_in_use`** (a warning, written now): another computer joined with this hub's
 *   key (`replaced`), once per outage.
 */
import type { HubEvent } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import { type Mono, monoAfterMs, msBetween } from "../model/time.ts";
import { onLinkBack, onLinkLost } from "./outbox.ts";
import type { Steps } from "./out.ts";
import { relayEvent } from "./records.ts";
import { urlInUse } from "./settings.ts";
import type { Tally } from "./state.ts";
import { sendRoster } from "./targets.ts";

type RelayLinkEvent = Extract<HubEvent, { readonly kind: "relayLink" }>;

const UNREACHABLE = { module: "relay", kind: "unreachable" } as const;
const LINK_RECORD = { module: "relay", kind: "linkRecord" } as const;
const ROSTER_REFRESH = { module: "relay", kind: "rosterRefresh" } as const;

/** Counts an up or a down into the present period, starting one (and its timer) if none is. */
function count(steps: Steps, ctx: Context, change: (tally: Tally) => Tally): void {
  const before = steps.slice.tally;
  if (before === undefined) {
    steps.timer(LINK_RECORD, monoAfterMs(ctx.now.mono, ctx.deps.rules.relay.linkRecordEveryMs));
  }
  const tally = change(before ?? { ups: 0, downs: 0, longestDownMs: 0 });
  steps.update((slice) => ({ ...slice, tally }));
}

/** An outage begins (or the one at the start): `relay_unreachable` falls due after 180 s ‡. */
export function startOutage(steps: Steps, ctx: Context, since: Mono | undefined): void {
  if (steps.slice.outage !== undefined) return;
  steps.update((slice) => ({
    ...slice,
    outage: { alerted: false, replaced: false, since },
  }));
  steps.timer(UNREACHABLE, monoAfterMs(ctx.now.mono, ctx.deps.rules.relay.unreachableAfterMs));
}

/** No outage any more: none, or no relay in use. */
export function endOutage(steps: Steps): void {
  steps.clear(UNREACHABLE);
  steps.update((slice) => ({ ...slice, outage: undefined }));
}

function linkUp(steps: Steps, ctx: Context, roles: readonly string[]): void {
  const outage = steps.slice.outage;
  const downMs = outage?.since === undefined ? undefined : msBetween(outage.since, ctx.now.mono);
  steps.update((slice) => ({
    ...slice,
    link: { kind: "up", roles },
    changedMs: ctx.now.wall,
  }));
  count(steps, ctx, (tally) => ({
    ...tally,
    ups: tally.ups + 1,
    longestDownMs: Math.max(tally.longestDownMs, downMs ?? 0),
  }));
  if (outage?.alerted === true) {
    steps.pushResult(relayEvent(ctx, "relay_reachable", { downMs: downMs ?? null }));
  }
  endOutage(steps);
  sendRoster(steps, ctx);
  onLinkBack(steps, ctx);
}

function linkDown(steps: Steps, ctx: Context, event: RelayLinkEvent): void {
  const wasUp = steps.slice.link.kind === "up";
  steps.update((slice) => ({
    ...slice,
    link: { kind: "down", reason: event.reason },
    changedMs: wasUp ? ctx.now.wall : slice.changedMs,
  }));
  if (wasUp) {
    count(steps, ctx, (tally) => ({ ...tally, downs: tally.downs + 1 }));
    onLinkLost(steps);
    steps.clear(ROSTER_REFRESH);
    startOutage(steps, ctx, ctx.now.mono);
  } else {
    startOutage(steps, ctx, undefined);
  }
  const outage = steps.slice.outage;
  if (event.reason === "replaced" && outage !== undefined && !outage.replaced) {
    steps.update((slice) => ({ ...slice, outage: { ...outage, replaced: true } }));
    steps.pushResult(relayEvent(ctx, "relay_identity_in_use", null));
  }
}

/** `relayLink`: the shell's report of the link to the relay in use. */
export function onRelayLink(steps: Steps, ctx: Context, event: RelayLinkEvent): void {
  const url = urlInUse(steps.slice);
  if (url === null || event.url !== url) return;
  if (event.state === "up") {
    if (steps.slice.link.kind !== "up") linkUp(steps, ctx, event.roles ?? []);
    return;
  }
  linkDown(steps, ctx, event);
}

/** The link has been down 180 s ‡: `relay_unreachable`, once per outage. */
export function onUnreachableDue(steps: Steps, ctx: Context): void {
  const { outage, link } = steps.slice;
  if (outage === undefined || outage.alerted || link.kind !== "down") return;
  steps.update((slice) => ({ ...slice, outage: { ...outage, alerted: true } }));
  const reason = link.reason ?? null;
  steps.pushResult(relayEvent(ctx, "relay_unreachable", { reason }));
}

/** The record period ended: one `relay_link` for its ups and downs. */
export function onLinkRecordDue(steps: Steps, ctx: Context): void {
  const tally = steps.slice.tally;
  if (tally === undefined) return;
  const outage = steps.slice.outage;
  const ongoing =
    steps.slice.link.kind === "down" && outage?.since !== undefined
      ? msBetween(outage.since, ctx.now.mono)
      : 0;
  steps.update((slice) => ({ ...slice, tally: undefined }));
  steps.pushResult(
    relayEvent(ctx, "relay_link", {
      ups: tally.ups,
      downs: tally.downs,
      longestDownMs: Math.max(tally.longestDownMs, ongoing),
    }),
  );
}

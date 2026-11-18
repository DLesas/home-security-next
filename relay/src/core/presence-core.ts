/**
 * The presence core (docs/m4-design.md section 3, "Presence"; D64, D96), over the frozen types of
 * `presence.ts`, with the values of `PRESENCE_RULES`. Pure: time only from its inputs, no input or
 * output, the map it is given left as it was.
 *
 * | When | The core |
 * | --- | --- |
 * | `frame` | last contact = now; `online`. If it was `alerted`, `sendBack` first |
 * | `tick`, an `online` hub silent `silentCloseMs` | `closeLink`; `quiet` |
 * | `tick`, not `alerted`, with targets, at or past both last contact + `alertAfterMs` and the grace end | `sendUnreachable`; `alerted`. Once per outage |
 * | `restarting {withinMs}` | a frame, then grace end = now + min(`withinMs`, `graceMaxMs`); `restartingAck` |
 * | `linkJoined` | a frame, and the grace ends (grace end 0): the restart is over |
 * | `roster` | whether the hub has targets |
 * | `relayStarted` | every hub not `alerted`: last contact = the start (D96); `alerted` ones stay so |
 *
 * `store` is asked for whenever what is kept of a hub changes: its state, its grace end or
 * whether it has targets, and a hub first heard. Last contact alone is not stored: a frame comes
 * every 30 s, and after a restart the clock starts afresh anyway (D96).
 *
 * Every hub's clock is its own, so the shell may hand the core only the hubs an input concerns
 * (one for a frame, those due for a tick); `nextWakeMs` is then the earliest of those.
 */
import type {
  HubPresence,
  PresenceCore,
  PresenceInput,
  PresenceOutput,
  PresenceStep,
} from "./presence.ts";
import { PRESENCE_RULES } from "./rules.ts";

/** When `hub` next needs a tick, or null when nothing about it waits. */
export function presenceDeadline(hub: HubPresence): number | null {
  if (hub.state === "alerted") return null;
  const alertAt = hub.hasTargets
    ? Math.max(hub.lastContactMs + PRESENCE_RULES.alertAfterMs, hub.graceEndMs)
    : null;
  if (hub.state === "quiet") return alertAt;
  const closeAt = hub.lastContactMs + PRESENCE_RULES.silentCloseMs;
  return alertAt === null ? closeAt : Math.min(closeAt, alertAt);
}

function earliest(hubs: ReadonlyMap<string, HubPresence>): number | null {
  let next: number | null = null;
  for (const hub of hubs.values()) {
    const at = presenceDeadline(hub);
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}

function changed(before: HubPresence | undefined, after: HubPresence): boolean {
  return (
    before?.state !== after.state ||
    before.graceEndMs !== after.graceEndMs ||
    before.hasTargets !== after.hasTargets
  );
}

function fresh(identity: string, atMs: number): HubPresence {
  return { identity, lastContactMs: atMs, state: "online", graceEndMs: 0, hasTargets: false };
}

/** A frame from `identity` at `atMs`: the hub as it is after it, and what to do first. */
function heard(
  before: HubPresence | undefined,
  identity: string,
  atMs: number,
  out: PresenceOutput[],
): HubPresence {
  if (before?.state === "alerted") out.push({ kind: "sendBack", identity });
  return before === undefined
    ? fresh(identity, atMs)
    : { ...before, lastContactMs: Math.max(before.lastContactMs, atMs), state: "online" };
}

/** What `tick` at `atMs` does to one hub. */
function ticked(hub: HubPresence, atMs: number, out: PresenceOutput[]): HubPresence {
  let next = hub;
  if (next.state === "online" && atMs >= next.lastContactMs + PRESENCE_RULES.silentCloseMs) {
    out.push({ kind: "closeLink", identity: next.identity });
    next = { ...next, state: "quiet" };
  }
  if (
    next.state !== "alerted" &&
    next.hasTargets &&
    atMs >= next.lastContactMs + PRESENCE_RULES.alertAfterMs &&
    atMs >= next.graceEndMs
  ) {
    out.push({ kind: "sendUnreachable", identity: next.identity });
    next = { ...next, state: "alerted" };
  }
  return next;
}

export const stepPresence: PresenceCore = (hubs, input) => {
  const next = new Map(hubs);
  const out: PresenceOutput[] = [];
  const keep = (hub: HubPresence) => {
    const before = hubs.get(hub.identity);
    next.set(hub.identity, hub);
    if (changed(before, hub)) out.push({ kind: "store", hub });
  };
  switch (input.kind) {
    case "frame":
      keep(heard(hubs.get(input.identity), input.identity, input.atMs, out));
      break;
    case "linkJoined":
      keep({ ...heard(hubs.get(input.identity), input.identity, input.atMs, out), graceEndMs: 0 });
      break;
    case "restarting": {
      const hub = heard(hubs.get(input.identity), input.identity, input.atMs, out);
      const graceEndMs = input.atMs + Math.min(input.withinMs, PRESENCE_RULES.graceMaxMs);
      out.push({ kind: "restartingAck", identity: input.identity });
      keep({ ...hub, graceEndMs });
      break;
    }
    case "roster": {
      const hub = hubs.get(input.identity) ?? fresh(input.identity, input.atMs);
      keep({ ...hub, hasTargets: input.hasTargets });
      break;
    }
    case "tick":
      for (const hub of hubs.values()) {
        const after = ticked(hub, input.atMs, out);
        if (after !== hub) keep(after);
      }
      break;
    case "relayStarted":
      for (const hub of hubs.values()) {
        if (hub.state !== "alerted") next.set(hub.identity, { ...hub, lastContactMs: input.atMs });
      }
      break;
  }
  return { hubs: next, out, nextWakeMs: earliest(next) } satisfies PresenceStep;
};

/** One input, for callers that hold no map of their own (tests, single hubs). */
export function stepOne(hub: HubPresence | undefined, input: PresenceInput): PresenceStep {
  return stepPresence(hub === undefined ? new Map() : new Map([[hub.identity, hub]]), input);
}

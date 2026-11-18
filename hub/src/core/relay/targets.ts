/**
 * Push targets and the roster (docs/m4-design.md sections 4 and 5, "Push keys and registration";
 * D126, D127).
 *
 * - **Registering** (`push.register`) writes the phone's target and its key now, gives the key to
 *   the `PushKeys` port (`pushKey`), records `push_registered`, and sends a new roster. A second
 *   registration replaces both, a new key included; pushes waiting for that phone are sealed with
 *   the new key when they go, since the shell seals at sending.
 * - **Unregistering** (`push.unregister`, or the client removed) deletes the target, the key and
 *   the phone's waiting pushes in one commit, records `push_unregistered`, and sends a new roster.
 * - **Invalid** (`badToken` from the push service) marks the target invalid now, deletes the
 *   phone's waiting pushes, records `push_target_invalid`, and sends a new roster without it; the
 *   phone registers again at its next session, when the snapshot's `push` says `valid: false`.
 * - **The roster** is every valid target of a live phone, each with the relay's two alerts for the
 *   shell to seal with that phone's key. It is sent while the link is up: when it comes up, at each
 *   change of the targets, when whether any sensor is armed changes (the alerts carry `armed`),
 *   and every `HubRules.relay.rosterEveryMs` (a day ‡), so the sealed alerts are made afresh.
 */
import { type PushEnvironment, type PushPlatform, relayAlertContent } from "@hsn/protocol/app";
import { anySensorArmed } from "../alarm/view.ts";
import type { RosterEntry } from "../model/effects.ts";
import type { Context } from "../model/handler.ts";
import type { ClientId, Seq } from "../model/ids.ts";
import { PushEnvironmentCode, PushPlatformCode, type PushTargetRow } from "../model/rows.ts";
import { monoAfterMs } from "../model/time.ts";
import { hubIdentity, recipientOf } from "./content.ts";
import type { Steps } from "./out.ts";
import {
  deleteKey,
  deleteOutbox,
  deleteTarget,
  type DroppedReason,
  recordDropped,
  pushDecision,
  writeKey,
  writeTarget,
} from "./records.ts";

export function platformName(code: PushTargetRow["platform"]): PushPlatform {
  return code === PushPlatformCode.Apns ? "apns" : "fcm";
}

export function platformCode(name: PushPlatform): PushTargetRow["platform"] {
  return name === "apns" ? PushPlatformCode.Apns : PushPlatformCode.Fcm;
}

export function environmentName(code: PushTargetRow["environment"]): PushEnvironment {
  return code === PushEnvironmentCode.Production ? "production" : "development";
}

export function environmentCode(name: PushEnvironment): PushTargetRow["environment"] {
  return name === "production" ? PushEnvironmentCode.Production : PushEnvironmentCode.Development;
}

/** The roster's targets: every valid target of a live phone, by client. */
export function rosterEntries(steps: Steps, ctx: Context, hub: string): readonly RosterEntry[] {
  const armed = anySensorArmed(ctx.view);
  return [...steps.slice.targets.values()]
    .filter((target) => recipientOf(ctx.view, steps.slice, target.clientId) !== undefined)
    .toSorted((a, b) => a.clientId - b.clientId)
    .map((target) => ({
      client: target.clientId,
      keyId: target.keyId,
      platform: platformName(target.platform),
      environment: environmentName(target.environment),
      token: target.token,
      unreachable: relayAlertContent("unreachable", hub, armed),
      back: relayAlertContent("back", hub, armed),
    }));
}

/**
 * Sends the whole roster when the link is up (nothing when it is down: it goes when it comes
 * up), and sets the next refresh.
 */
export function sendRoster(steps: Steps, ctx: Context): void {
  if (steps.slice.link.kind !== "up") return;
  const hub = hubIdentity(ctx.view, ctx.deps);
  if (hub === undefined) return;
  const targets = rosterEntries(steps, ctx, hub);
  const rev = steps.slice.roster.rev + 1;
  steps.update((slice) => ({ ...slice, roster: { rev, armed: anySensorArmed(ctx.view) } }));
  steps.push({ kind: "relayRoster", rev, targets });
  steps.timer(
    { module: "relay", kind: "rosterRefresh" },
    monoAfterMs(ctx.now.mono, ctx.deps.rules.relay.rosterEveryMs),
  );
}

/** Deletes every waiting push of one phone (routine), recorded with why, and its test pushes. */
export function dropClientPushes(
  steps: Steps,
  ctx: Context,
  client: ClientId,
  reason: DroppedReason,
): void {
  const theirs = (owner: ClientId) => owner === client;
  if (
    ![...steps.slice.outbox.values()].some((pending) => theirs(pending.row.clientId)) &&
    ![...steps.slice.tests.values()].some(theirs)
  ) {
    return;
  }
  const outbox = new Map(steps.slice.outbox);
  let dropped = 0;
  for (const [id, pending] of steps.slice.outbox) {
    if (pending.row.clientId !== client) continue;
    outbox.delete(id);
    steps.clear({ module: "relay", kind: "pushRetry", id });
    steps.push(deleteOutbox(id));
    dropped += 1;
  }
  const tests = new Map([...steps.slice.tests].filter(([, owner]) => owner !== client));
  steps.update((slice) => ({ ...slice, outbox, tests }));
  recordDropped(steps, ctx, reason, dropped);
}

/** Registers (or registers again) a phone's target; the key goes to the store and the port only. */
export function register(
  steps: Steps,
  ctx: Context,
  row: PushTargetRow,
  key: Uint8Array,
  cause: Seq,
): void {
  steps.update((slice) => ({ ...slice, targets: new Map(slice.targets).set(row.clientId, row) }));
  steps.push(writeTarget(row), writeKey(row.clientId, key), {
    kind: "pushKey",
    client: row.clientId,
    keyId: row.keyId,
    key,
  });
  steps.pushResult(pushDecision(ctx, "push_registered", row.clientId, cause));
  sendRoster(steps, ctx);
}

/**
 * Removes a phone's target, key and waiting pushes (`push.unregister`, or its client removed);
 * nothing when it has no target.
 */
export function unregister(
  steps: Steps,
  ctx: Context,
  client: ClientId,
  cause: Seq | null,
  reason: "unregistered" | "removed",
): void {
  const target = steps.slice.targets.get(client);
  dropClientPushes(steps, ctx, client, reason);
  if (target === undefined) return;
  const targets = new Map(steps.slice.targets);
  targets.delete(client);
  steps.update((slice) => ({ ...slice, targets }));
  steps.push(deleteTarget(client), deleteKey(client), {
    kind: "pushKey",
    client,
    keyId: target.keyId,
    key: null,
  });
  steps.pushResult(pushDecision(ctx, "push_unregistered", client, cause));
  sendRoster(steps, ctx);
}

/** The push service refused a phone's token: its target is invalid until it registers again. */
export function invalidate(steps: Steps, ctx: Context, client: ClientId): void {
  dropClientPushes(steps, ctx, client, "invalid");
  const target = steps.slice.targets.get(client);
  if (target?.invalidMs !== null) return;
  const row: PushTargetRow = { ...target, invalidMs: ctx.now.wall };
  steps.update((slice) => ({ ...slice, targets: new Map(slice.targets).set(client, row) }));
  steps.push(writeTarget(row));
  steps.pushResult(pushDecision(ctx, "push_target_invalid", client, null));
  sendRoster(steps, ctx);
}

/** Whether any other client's target already uses this key id (the roster names each once). */
export function keyIdTaken(steps: Steps, client: ClientId, keyId: Uint8Array): boolean {
  return [...steps.slice.targets.values()].some(
    (target) =>
      target.clientId !== client &&
      target.keyId.length === keyId.length &&
      target.keyId.every((byte, i) => byte === keyId[i]),
  );
}

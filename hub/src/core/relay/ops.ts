/**
 * The relay module's operations (docs/m4-design.md section 9; `OP_OWNERS`): `push.register`,
 * `push.unregister`, `push.test` (the phone itself, kind phone), `relay.status` and `relay.set`
 * (*manage system*).
 *
 * - **Who.** `push.*` only from a live client of kind phone, for itself: the console, a browser,
 *   `hsn` and schedules are refused `unauthorized` (`NOT_A_PHONE`). `relay.*` need *manage
 *   system*: `hsn` and the console hold it; a person without it is refused
 *   `unauthorized {permission: "manageSystem"}`.
 * - **`push.register`** (a change): the target and key written now, the key never recorded (it
 *   leaves only in the `push_keys` write and the `pushKey` effect); a key id another phone's target
 *   uses is refused `invalid {field: "keyId", reason: "taken"}`, since the roster names each key id
 *   once. Registering again replaces the target and the key, and makes an invalid target valid.
 * - **`push.unregister`** (a change): the target, key and waiting pushes deleted; nothing to do
 *   when it has none, answered all the same.
 * - **`push.test`** (a change): a test push to this phone, kind `push_test`, when it holds a valid
 *   target and the link is up (`{sent: true}`); otherwise nothing is sent (`{sent: false}`), since
 *   a test that waits for the link would say nothing about it. It is not kept in the outbox; a
 *   `badToken` for it marks the target invalid as any push's does.
 * - **`relay.set`** (a change): `null` for the deployment's default; a URL by `relaySetRefusal`'s
 *   rule. A new setting is written now with the next revision, the shell told (`relayConnect`) when
 *   the relay in use changes, and the link starts again from down (or off); the same setting again
 *   changes nothing. Answered with `relay.status` as it now stands.
 */
import { type AppOpV2, NOT_A_PHONE, parsePushKey, parsePushKeyId } from "@hsn/protocol/app";
import { anySensorArmed } from "../alarm/view.ts";
import type { Context } from "../model/handler.ts";
import type { ClientId } from "../model/ids.ts";
import type { Actor, Internal } from "../model/messages.ts";
import { ClientKind, type PushTargetRow } from "../model/rows.ts";
import { hasGlobal, liveClient } from "../people/view.ts";
import { hubIdentity, recipientOf, testContent } from "./content.ts";
import { endOutage, startOutage } from "./link.ts";
import { onLinkLost, takeId } from "./outbox.ts";
import type { Steps } from "./out.ts";
import { writeSettings } from "./records.ts";
import { linkAtStart, relaySetRefusal, statusOf, urlOf } from "./settings.ts";
import { environmentCode, keyIdTaken, platformCode, register, unregister } from "./targets.ts";

type V2OpRequest = Extract<Internal, { readonly kind: "v2OpRequest" }>;

/** The phone a `push.*` request speaks for: a live client of kind phone, or undefined. */
function phoneOf(ctx: Context, actor: Actor): ClientId | undefined {
  if (actor.kind !== "person" && actor.kind !== "console") return undefined;
  return liveClient(ctx.view, actor.client)?.kind === ClientKind.Phone ? actor.client : undefined;
}

function pushRegister(
  steps: Steps,
  ctx: Context,
  request: V2OpRequest,
  client: ClientId,
  body: Extract<AppOpV2, { readonly op: "push.register" }>["body"],
): void {
  const keyId = parsePushKeyId(body.keyId);
  if (keyId === undefined) {
    steps.refuse(request.answerTo, {
      code: "invalid",
      detail: { field: "keyId", reason: "format" },
    });
    return;
  }
  const key = parsePushKey(body.key);
  if (key === undefined) {
    steps.refuse(request.answerTo, { code: "invalid", detail: { field: "key", reason: "format" } });
    return;
  }
  if (keyIdTaken(steps, client, keyId)) {
    steps.refuse(request.answerTo, {
      code: "invalid",
      detail: { field: "keyId", reason: "taken" },
    });
    return;
  }
  const row: PushTargetRow = {
    clientId: client,
    keyId,
    platform: platformCode(body.platform),
    environment: environmentCode(body.environment),
    token: body.token,
    registeredMs: ctx.now.wall,
    invalidMs: null,
  };
  register(steps, ctx, row, key, request.record);
  steps.answer(request.answerTo, { registered: true });
}

function pushTest(steps: Steps, ctx: Context, request: V2OpRequest, client: ClientId): void {
  const hub = hubIdentity(ctx.view, ctx.deps);
  const target = steps.slice.targets.get(client);
  const sendable =
    steps.slice.link.kind === "up" &&
    hub !== undefined &&
    target !== undefined &&
    recipientOf(ctx.view, steps.slice, client) !== undefined;
  if (!sendable) {
    steps.answer(request.answerTo, { sent: false });
    return;
  }
  const id = takeId(steps);
  steps.update((slice) => ({ ...slice, tests: new Map(slice.tests).set(id, target) }));
  steps.push({
    kind: "pushSend",
    id,
    client,
    content: testContent(hub, request.record, ctx.now, anySensorArmed(ctx.view)),
  });
  steps.answer(request.answerTo, { sent: true });
}

/** `relay.set`: a new setting, and the link started again for the relay it names. */
function relaySet(steps: Steps, ctx: Context, request: V2OpRequest, url: string | null): void {
  if (url !== null) {
    const refusal = relaySetRefusal(url);
    if (refusal !== undefined) {
      steps.refuse(request.answerTo, refusal);
      return;
    }
  }
  const before = steps.slice.settings;
  if (before.url !== url) {
    const settings = { url, revision: before.revision + 1 };
    steps.update((slice) => ({ ...slice, settings }));
    steps.push(writeSettings(settings));
    const from = urlOf(before, steps.slice.defaultUrl);
    const to = urlOf(settings, steps.slice.defaultUrl);
    if (from !== to) {
      steps.push({ kind: "relayConnect", url: to });
      if (steps.slice.link.kind === "up") onLinkLost(steps);
      steps.clear({ module: "relay", kind: "rosterRefresh" });
      steps.update((slice) => ({ ...slice, link: linkAtStart(to), changedMs: ctx.now.wall }));
      if (to === null) endOutage(steps);
      else startOutage(steps, ctx, ctx.now.mono);
    }
  }
  steps.answer(request.answerTo, statusOf(steps.slice));
}

/** One `v2OpRequest` for relay. */
export function relayOp(steps: Steps, ctx: Context, request: V2OpRequest): void {
  const { op, actor, answerTo } = request;
  switch (op.op) {
    case "push.register":
    case "push.unregister":
    case "push.test": {
      const client = phoneOf(ctx, actor);
      if (client === undefined) {
        steps.refuse(answerTo, NOT_A_PHONE);
        return;
      }
      if (op.op === "push.register") pushRegister(steps, ctx, request, client, op.body);
      else if (op.op === "push.test") pushTest(steps, ctx, request, client);
      else {
        unregister(steps, ctx, client, request.record, "unregistered");
        steps.answer(answerTo, {});
      }
      return;
    }
    case "relay.status":
    case "relay.set":
      if (!hasGlobal(ctx.view, actor, "manageSystem")) {
        steps.refuse(answerTo, { code: "unauthorized", detail: { permission: "manageSystem" } });
        return;
      }
      if (op.op === "relay.status") steps.answer(answerTo, statusOf(steps.slice));
      else relaySet(steps, ctx, request, op.body.url);
      return;
    default:
      steps.refuse(answerTo, { code: "notBuilt", detail: { op: op.op } });
  }
}

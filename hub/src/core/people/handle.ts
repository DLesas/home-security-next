/**
 * The people module's handler (m2-design.md section 2, module 6): people, clients, permissions,
 * the user-management switch, link tokens, and each client's last `seq` with its stored replies.
 *
 * It acts on the boot event (its tables, read whole, and the tokens carried across the restart);
 * its operations (`opRequest` with owner `people`) and `hsn open`'s `consoleTokenRequest`; a link
 * handshake's `linkCompleted` and `linkFailed`; its `tokenExpiry` timers; `clientConnected` (a
 * client's last seen, routine); and, for every change an app sends, the request on its way to the
 * owner and its answer (`sequence.ts`).
 */
import { err, ok } from "neverthrow";
import { coreFault } from "../model/errors.ts";
import { appRequestChange } from "../app/view.ts";
import type { Handler } from "../model/handler.ts";
import { isAppRequest, type RequestId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { keyAnswered, keyAsked } from "./backup-epoch.ts";
import { onBoot } from "./boot.ts";
import { consoleTokenWait, settleConsoleWaits } from "./console-wait.ts";
import {
  consoleToken,
  linkCancel,
  linkCompleted,
  linkCreate,
  linkFailed,
  tokenExpired,
} from "./linking.ts";
import { handlePeopleOp, type OpRequest, type Step, withClient } from "./ops.ts";
import { writeRoutine } from "./records.ts";
import { changeAnswered, changeSent, changeSentTo } from "./sequence.ts";
import type { PeopleSlice } from "./state.ts";
import type { Context } from "../model/handler.ts";

function operation(slice: PeopleSlice, ctx: Context, request: OpRequest): Step {
  const op = request.op;
  if (op.op === "link.create") return linkCreate(slice, ctx, request, op.body);
  if (op.op === "link.cancel") return linkCancel(slice, ctx, request, op.body);
  // `OP_OWNERS` gives people only the operations above and `handlePeopleOp`'s.
  return (
    handlePeopleOp(slice, ctx, request) ??
    err(coreFault(ctx.event, "core/people", "an operation people does not own", { op: op.op }))
  );
}

/** A request `app` numbered for an M1a module (section 2), which carries a `request` id. */
function appRequestOf(message: Internal): RequestId | undefined {
  if (message.kind === "answer" || message.kind === "command") return undefined;
  if (!("request" in message) || !("actor" in message)) return undefined;
  return isAppRequest(message.request) ? message.request : undefined;
}

const handleOne: Handler<"people"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "boot":
      return onBoot(ctx, message);
    case "opRequest": {
      const sent = changeSentTo(keyAsked(slice, message), message.answerTo);
      if (message.owner !== "people") return ok({ slice: sent.slice, out: sent.out });
      return operation(sent.slice, ctx, message).map((handled) => ({
        slice: handled.slice,
        out: [...sent.out, ...handled.out],
      }));
    }
    // A version 2 row for another module (docs/m3-m4-plan.md): its change's `seq` is written now
    // and its reply held as pending, exactly as for an `opRequest` (section 5: every change one
    // effect), and a phone's `backup.keyHeld` is noted (A8).
    case "v2OpRequest": {
      const sent = changeSentTo(keyAsked(slice, message), message.answerTo);
      return ok({ slice: sent.slice, out: sent.out });
    }
    case "opAnswer": {
      const held = keyAnswered(slice, message.answerTo, message.outcome);
      const answered = changeAnswered(
        held.slice,
        message.answerTo,
        message.outcome,
        ctx.deps.rules.people.storedReplies,
      );
      return ok({ slice: answered.slice, out: [...held.out, ...answered.out] });
    }
    case "consoleTokenRequest":
      return consoleToken(slice, ctx, message);
    case "consoleTokenWaitRequest":
      return ok(consoleTokenWait(slice, message.request, message.token));
    case "linkCompleted":
      return linkCompleted(slice, ctx, message);
    case "linkFailed":
      return linkFailed(slice, ctx, message);
    case "timer":
      return message.key.module === "people"
        ? tokenExpired(slice, ctx, message.key.token)
        : ok({ slice, out: [] });
    case "clientConnected": {
      const row = slice.clients.get(message.client);
      if (row?.removedMs !== null) return ok({ slice, out: [] });
      const seen = { ...row, lastSeenMs: ctx.now.wall };
      return ok({
        slice: withClient(slice, seen),
        out: [writeRoutine({ table: "clients", op: "upsert", row: seen })],
      });
    }
    default: {
      const request = appRequestOf(message);
      const change = request === undefined ? undefined : appRequestChange(ctx.view, request);
      if (change === undefined) return ok({ slice, out: [] });
      return ok(changeSent(slice, change.client, change.seq));
    }
  }
};

/** The handler: each message, then any `hsn open` wait its token's use or end has settled. */
export const handlePeople: Handler<"people"> = (slice, message, ctx) =>
  handleOne(slice, message, ctx).map((handled) => {
    const settled = settleConsoleWaits(handled.slice);
    return settled.out.length === 0
      ? handled
      : { slice: settled.slice, out: [...handled.out, ...settled.out] };
  });

/**
 * The control module's handler (hub-design.md section 2, module 5; section 9; AL8).
 *
 * A `command` input is routed (`translate.ts`): answered at once from the state, or sent on as a
 * request to the module that owns the change and kept waiting until that module's `answer` (or
 * `opAnswer`, for an operation of M2's modules). `hsn arm --all` and `hsn disarm --all` go to
 * layout as switches to Away and Disarmed; the alarm answers them with `opAnswer`, which control
 * turns into M1a's reply (`m1-replies.ts`), so they are answered as before (m2-design.md
 * section 1).
 * Each command gets exactly one `respond`, and one record in `commands` with its actor, its
 * arguments (secrets left out) and its outcome. A second answer to one request is not passed on;
 * it is recorded as a warning. The answer is made in the step that made the change, so the loop
 * commits every item that change wrote now before it sends the answer (section 4).
 *
 * `hsn log` is recorded here and answered by the shell, which flushes, reads and streams
 * (section 3). The record is routine: a command's effect is what is written now (section 5). So is
 * a granted `firmware.bluetooth` (m3-updates section 5): firmware's answer is a marker without the
 * key, recorded here, and the one reply, with the key, is the shell's (`bluetoothSession`).
 */
import { ok, type Result } from "neverthrow";
import type { ControlCommand, ControlReply } from "../model/control.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import { type ConnId, isAppRequest, type RequestId } from "../model/ids.ts";
import type { Internal, OpOutcome } from "../model/messages.ts";
import { recordStamp } from "../clock/view.ts";
import { sessionGrantedIn } from "../firmware/view.ts";
import { hubEventRecord } from "../registry/view.ts";
import { alarmBefore, armAllReply, disarmAllReply } from "./m1-replies.ts";
import { type ControlSources, VIEW_SOURCES } from "./sources.ts";
import type { ControlSlice, PendingCommand } from "./state.ts";
import { recordedArgs, route } from "./translate.ts";

const ORIGIN = "core/control";

/** `commands.outcome` of a command that succeeded; a failure's is its error code. */
export const OUTCOME_OK = "ok";
/** `commands.outcome` of `hsn log`, which the shell answers. */
export const OUTCOME_SHELL = "answeredByShell";

type Step = Result<Handled<"control">, CoreFault>;

function arrivalStamp(ctx: Context): { readonly atMs: number; readonly clockOk: boolean } {
  const { atMs, clockOk } = recordStamp(ctx.view, ctx.now);
  return { atMs, clockOk };
}

/** The command's record, under the number and time it took when it arrived. */
function commandRecord(command: PendingCommand, outcome: string, detail: string | null): Internal {
  return {
    kind: "auditRecord",
    durability: "routine",
    record: {
      kind: "command",
      row: {
        seq: command.record,
        atMs: command.atMs,
        clockOk: command.clockOk,
        actor: command.actor,
        kind: command.kind,
        args: command.args,
        outcome,
        detail,
      },
    },
  };
}

/** The one answer to a command, with its record. */
function respond(
  request: RequestId,
  command: PendingCommand,
  reply: ControlReply,
): readonly (Internal | Effect)[] {
  const outcome = reply.ok ? OUTCOME_OK : reply.error.code;
  const detail = reply.ok ? null : reply.error.message;
  return [{ kind: "respond", request, reply }, commandRecord(command, outcome, detail)];
}

function withPending(
  slice: ControlSlice,
  request: RequestId,
  command: PendingCommand | undefined,
): ControlSlice {
  const pending = new Map(slice.pending);
  if (command === undefined) pending.delete(request);
  else pending.set(request, command);
  return { ...slice, pending };
}

function commanded(
  slice: ControlSlice,
  ctx: Context,
  request: RequestId,
  conn: ConnId,
  actor: string,
  command: ControlCommand,
  sources: ControlSources,
): Step {
  return ctx.records.take().map((record) => {
    const pending: PendingCommand = {
      kind: command.kind,
      actor,
      args: recordedArgs(command),
      record,
      // Stamped now, with its number: written later with its outcome, it keeps both, so `seq`
      // stays in time order (section 6).
      ...arrivalStamp(ctx),
    };
    const routed = route(ctx.view, ctx.now, sources, request, conn, actor, record, command);
    switch (routed.kind) {
      case "answer":
        return { slice, out: respond(request, pending, routed.reply) };
      case "forward":
        return { slice: withPending(slice, request, pending), out: [routed.message] };
      case "shell":
        return { slice, out: [commandRecord(pending, OUTCOME_SHELL, null)] };
    }
  });
}

function answered(
  slice: ControlSlice,
  ctx: Context,
  request: RequestId,
  reply: ControlReply,
): Step {
  const pending = slice.pending.get(request);
  if (pending === undefined) {
    return hubEventRecord(ctx, {
      level: "warning",
      origin: ORIGIN,
      code: "answer_not_waited_for",
      message: `an answer to request ${request}, which is not waiting: a second answer, or one from before a restart`,
      detail: JSON.stringify({ request }),
    }).map((record) => ({ slice, out: [record] }));
  }
  return ok({
    slice: withPending(slice, request, undefined),
    out: respond(request, pending, reply),
  });
}

/** An operation's outcome as the control socket answers it (m2-design.md section 6). */
function controlReplyOf(outcome: OpOutcome): ControlReply {
  if (outcome.ok) return { ok: true, result: { kind: "op", body: outcome.body } };
  const error = outcome.error;
  return {
    ok: false,
    error: {
      code: error.code === "notBuilt" ? "notBuilt" : "opRefused",
      message: error.code === "notBuilt" ? `${error.detail.op} is not built yet` : error.code,
      app: error,
    },
  };
}

/** The handler, reading other modules through `sources` (`sources.ts`). */
export function makeControlHandler(sources: ControlSources): Handler<"control"> {
  return (slice, message, ctx) => {
    switch (message.kind) {
      case "boot":
        // Requests of an earlier run have no client left to answer.
        return ok({ slice: { ...slice, pending: new Map() }, out: [] });
      case "command":
        return commanded(
          slice,
          ctx,
          message.request,
          message.conn,
          message.actor,
          message.command,
          sources,
        );
      case "answer":
        // `app`'s requests to M1a's modules are numbered from 2⁴⁰ (m2-design.md section 2): their
        // answers are `app`'s, not control's.
        return isAppRequest(message.request)
          ? ok({ slice, out: [] })
          : answered(slice, ctx, message.request, message.reply);
      case "armSensors": {
        // `hsn disarm --all` on its way to the alarm: how the alarm stands as it acts, for
        // M1a's answer, which names what the disarm cancelled and ended (`m1-replies.ts`).
        const { answerTo } = message;
        const pending =
          answerTo.kind === "control" ? slice.pending.get(answerTo.request) : undefined;
        if (answerTo.kind !== "control" || pending?.kind !== "disarm") {
          return ok({ slice, out: [] });
        }
        return ok({
          slice: withPending(slice, answerTo.request, {
            ...pending,
            before: alarmBefore(ctx.view),
          }),
          out: [],
        });
      }
      case "opAnswer": {
        if (message.answerTo.kind !== "control") return ok({ slice, out: [] });
        const { request } = message.answerTo;
        const pending = slice.pending.get(request);
        // A granted Bluetooth session (m3-updates section 5, step 1): the one reply, with its key,
        // is the shell's (`bluetoothSession`); this answer is firmware's marker of it, without the
        // key or the nonce, recorded here and the command no longer waiting.
        if (pending !== undefined && sessionGrantedIn(message.outcome) !== undefined) {
          return ok({
            slice: withPending(slice, request, undefined),
            out: [commandRecord(pending, OUTCOME_OK, null)],
          });
        }
        const reply =
          pending?.kind === "arm"
            ? armAllReply(ctx.view, message.outcome)
            : pending?.kind === "disarm"
              ? disarmAllReply(ctx.view, pending.before, message.outcome)
              : controlReplyOf(message.outcome);
        return answered(slice, ctx, request, reply);
      }
      case "inputRejected": {
        // A control line the socket refused (section 9): answered there, recorded here, its
        // length and shape errors only, never its content.
        const { rejection } = message;
        if (rejection.source !== "control") return ok({ slice, out: [] });
        return hubEventRecord(ctx, {
          level: rejection.reason === "badReply" ? "critical" : "warning",
          origin: "shell/control",
          code: "request_rejected",
          message: `a control line was refused: ${rejection.reason} (${rejection.bytes} bytes)`,
          detail: JSON.stringify({
            reason: rejection.reason,
            bytes: rejection.bytes,
            issues: rejection.issues,
          }),
        }).map((record) => ({ slice, out: [record] }));
      }
      default:
        return ok({ slice, out: [] });
    }
  };
}

export const handleControl: Handler<"control"> = makeControlHandler(VIEW_SOURCES);

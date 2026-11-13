/**
 * Read-only selectors over the control module's slice that other modules may use (hub-design.md
 * section 2), and the `answer` messages every module that handles a request gives back to
 * control, which turns each into the request's one `respond` (section 9).
 */
import type { CommandResult, ControlError } from "../model/control.ts";
import type { RequestId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";

/** Why a command failed (control-protocol `controlErrorCode`). */
export type ControlErrorCode = ControlError["code"];

/** The `answer` for a command that succeeded. */
export function answerOk(request: RequestId, result: CommandResult): Internal {
  return { kind: "answer", request, reply: { ok: true, result } };
}

/** The `answer` for a command that failed, with what to do about it. */
export function answerError(
  request: RequestId,
  code: ControlErrorCode,
  message: string,
  names?: readonly string[],
): Internal {
  const error: ControlError =
    names === undefined ? { code, message } : { code, message, names: [...names] };
  return { kind: "answer", request, reply: { ok: false, error } };
}

/** True while `request` waits for its answer. */
export function isPending(view: HubState, request: RequestId): boolean {
  return view.control.pending.has(request);
}

/**
 * Step 0's answer for an operation whose module is still a stub (m2-design.md section 11): the
 * error `notBuilt`, which a test can tell from every real refusal. Goes once step 1 builds the
 * module; nothing else in a stub answers.
 */
import type { AppOp } from "@hsn/protocol/app";
import type { Internal } from "../model/messages.ts";
import type { M2ModuleName } from "../model/modules.ts";

/** The `opAnswer` that says `op` is not built yet, for a request to `module`. */
export function notBuiltAnswer(
  message: Extract<Internal, { readonly kind: "opRequest" }>,
): Internal {
  return {
    kind: "opAnswer",
    answerTo: message.answerTo,
    outcome: { ok: false, error: { code: "notBuilt", detail: { op: message.op.op } } },
  };
}

/** The control `answer` that says `hsn open`'s console token is not built yet (people's). */
export function consoleTokenNotBuilt(
  message: Extract<Internal, { readonly kind: "consoleTokenRequest" }>,
): Internal {
  return {
    kind: "answer",
    request: message.request,
    reply: {
      ok: false,
      error: { code: "notBuilt", message: "the console token is not built yet (people, step 1)" },
    },
  };
}

/** Whether a message is an operation for `module`. */
export function isOpFor(
  module: M2ModuleName,
  message: Internal,
): message is Extract<Internal, { readonly kind: "opRequest" }> {
  return message.kind === "opRequest" && message.owner === module;
}

/** The operation's name, for records. */
export function opName(op: AppOp): string {
  return op.op;
}

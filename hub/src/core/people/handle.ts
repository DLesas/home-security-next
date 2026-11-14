/**
 * The people module's handler (m2-design.md section 2, the module table). Step 0's stub: it changes
 * nothing, and answers every operation it owns (`OP_OWNERS`) with `notBuilt`, and `hsn open`'s
 * console token too; owner A3 builds it in step 1.
 */
import { ok } from "neverthrow";
import type { Handler } from "../model/handler.ts";
import { consoleTokenNotBuilt, isOpFor, notBuiltAnswer } from "../util/not-built.ts";

export const handlePeople: Handler<"people"> = (slice, message) => {
  if (isOpFor("people", message)) return ok({ slice, out: [notBuiltAnswer(message)] });
  if (message.kind === "consoleTokenRequest") {
    return ok({ slice, out: [consoleTokenNotBuilt(message)] });
  }
  return ok({ slice, out: [] });
};

/**
 * The health module's handler (m2-design.md section 2, the module table). Step 0's stub: it changes
 * nothing, and answers every operation it owns (`OP_OWNERS`) with `notBuilt`; owner A6
 * builds it in step 1.
 */
import { ok } from "neverthrow";
import type { Handler } from "../model/handler.ts";
import { isOpFor, notBuiltAnswer } from "../util/not-built.ts";

export const handleHealth: Handler<"health"> = (slice, message) =>
  ok(isOpFor("health", message) ? { slice, out: [notBuiltAnswer(message)] } : { slice, out: [] });

/**
 * The upkeep module's handler (m2-design.md section 2, the module table; section 9): backups,
 * restore and updates. Step 0's stub: it changes nothing, and answers every operation it owns
 * (`OP_OWNERS`: `backup.*`, `restore.start`, `update.*`) with `notBuilt`; owner A8 builds it in
 * step 1.
 */
import { ok } from "neverthrow";
import type { Handler } from "../model/handler.ts";
import { isOpFor, notBuiltAnswer } from "../util/not-built.ts";

export const handleUpkeep: Handler<"upkeep"> = (slice, message) =>
  ok(isOpFor("upkeep", message) ? { slice, out: [notBuiltAnswer(message)] } : { slice, out: [] });

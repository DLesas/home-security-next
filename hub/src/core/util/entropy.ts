/** The input's random bytes, handed out in order (hub-design.md section 2, "Time and randomness"). */
import { err, ok } from "neverthrow";
import { coreFault } from "../model/errors.ts";
import type { HubEvent } from "../model/events.ts";
import type { EntropyCursor } from "../model/handler.ts";

/**
 * A cursor over `bytes`: each `take` returns the next `length` bytes, as a copy. Asking for more
 * than are left is a `CoreFault` naming `event`, the kind of the input they came with.
 */
export function entropyCursor(bytes: Uint8Array, event: HubEvent["kind"]): EntropyCursor {
  let offset = 0;
  return {
    take(length) {
      if (!Number.isInteger(length) || length < 0 || offset + length > bytes.length) {
        return err(
          coreFault(event, "core/util/entropy", "entropy exhausted", {
            asked: length,
            left: bytes.length - offset,
          }),
        );
      }
      const taken = bytes.slice(offset, offset + length);
      offset += length;
      return ok(taken);
    },
  };
}

/**
 * `Bun.serve`'s WebSocket behind results (hub-design.md sections 3 and 10). `sendBinary`
 * answers with a status instead of throwing: −1 for back-pressure (the message is queued, but
 * the link is falling behind) and 0 for dropped; both become `sendFailed` (section 3). A socket
 * that is closed throws or reports 0, which is `closed`.
 */
import type { ServerWebSocket } from "bun";
import { err, ok, type Result } from "neverthrow";
import type { LinkError } from "../../ports/links.ts";
import { linkError } from "./link-error.ts";

/** `sendBinary`'s status for back-pressure. */
const BACK_PRESSURE = -1;
/** `sendBinary`'s status for a message dropped. */
const DROPPED = 0;
/** `readyState` of an open WebSocket. */
const OPEN = 1;

/** Sends one binary message: one packet per message (section 3). */
export function sendWebSocket<T>(
  socket: ServerWebSocket<T>,
  bytes: Uint8Array,
  origin: string,
): Result<void, LinkError> {
  if (socket.readyState !== OPEN)
    return err(linkError("closed", origin, "send on a closed socket"));
  let status: number;
  try {
    status = socket.sendBinary(bytes);
  } catch (thrown) {
    return err(linkError("closed", origin, "send on the WebSocket", thrown));
  }
  if (status === BACK_PRESSURE) return err(linkError("backPressure", origin, "back-pressure"));
  if (status === DROPPED) return err(linkError("dropped", origin, "message dropped"));
  return ok(undefined);
}

/** Closes the socket with a code (1003 for a text message, section 3) and a reason. */
export function closeWebSocket<T>(
  socket: ServerWebSocket<T>,
  code: number,
  reason: string,
  origin: string,
): Result<void, LinkError> {
  try {
    socket.close(code, reason);
    return ok(undefined);
  } catch (thrown) {
    return err(linkError("closed", origin, "close the WebSocket", thrown));
  }
}

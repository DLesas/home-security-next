/**
 * Bun's WebSockets behind results, for relay links: the push service's server sockets, and the
 * client socket a relay opens to the push service (`ws+unix://<socket>:/v1/relay` for the
 * operator's relay, `wss://…/v1/relay` for a self-hosted one).
 *
 * A server socket's send answers how much it took (Bun: bytes sent, -1 queued under back-pressure,
 * 0 dropped); a reader too slow to take its data is closed (D142: "a slow client cannot hold
 * memory"), so a send is refused once the socket holds `MAX_BUFFERED_BYTES` unsent.
 */
import type { ServerWebSocket } from "bun";
import { err, ok, type Result } from "neverthrow";
import { PROTECTION_LIMITS } from "../../core/rules.ts";
import { type PushError, pushError } from "../errors.ts";
import type { LinkSocket } from "../relay-link.ts";
import { thrownCode } from "./thrown.ts";

/**
 * Unsent bytes a relay link may hold before its reader counts as too slow: a hub link's 4 MiB ‡
 * (D142), room for every release piece a link may have in hand (4 of 256 KiB) and more.
 */
export const MAX_BUFFERED_BYTES = PROTECTION_LIMITS.memory.pendingToHubLinkBytes;

function took(status: number, buffered: () => number): boolean {
  if (status > 0) return true;
  return status === -1 && buffered() <= MAX_BUFFERED_BYTES;
}

/** A server WebSocket as a link's socket. */
export function serverSocket<T>(ws: ServerWebSocket<T>): LinkSocket {
  const buffered = () => ws.getBufferedAmount();
  return {
    sendText(text) {
      try {
        return took(ws.send(text), buffered);
      } catch {
        return false;
      }
    },
    sendBinary(bytes) {
      try {
        return took(ws.send(bytes), buffered);
      } catch {
        return false;
      }
    },
    close(code) {
      try {
        ws.close(code);
      } catch {
        // Already closed.
      }
    },
  };
}

/** Opens a client WebSocket; a malformed URL is an error, a failed connection a `close` event. */
export function openWebSocket(url: string, ca: string | undefined): Result<WebSocket, PushError> {
  try {
    const socket = ca === undefined ? new WebSocket(url) : new WebSocket(url, { tls: { ca } });
    socket.binaryType = "arraybuffer";
    return ok(socket);
  } catch (thrown) {
    const code = thrownCode(thrown);
    return err(
      pushError(
        "link",
        "push/safe/websocket",
        "open the relay link",
        code === undefined ? undefined : { code },
      ),
    );
  }
}

/** Sends on a client socket; false when it could not. */
export function clientSend(socket: WebSocket, data: string | Uint8Array): boolean {
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
}

/** Closes a client socket, whatever its state. */
export function clientClose(socket: WebSocket, code: number): void {
  try {
    socket.close(code);
  } catch {
    // Already closed, or a code the socket refuses: it is closing either way.
  }
}

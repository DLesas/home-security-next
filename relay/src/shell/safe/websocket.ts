/**
 * Bun's server WebSockets behind plain answers, for hub links and phone streams (docs/m4-design.md
 * section 3, D142 "Memory per connection").
 *
 * A send answers whether the socket took it within its budget of unsent bytes: 256 KiB to a
 * phone, 4 MiB to a hub link (`PROTECTION_LIMITS.memory`). Bun answers a send with the bytes it
 * wrote, -1 when it queued them under back-pressure, or 0 when it dropped them; anything dropped,
 * or a queue past the budget, is `false`, and the caller closes the socket with 4429: "a reader
 * too slow to take its data is closed, so a slow client cannot hold memory".
 */
import type { ServerWebSocket } from "bun";

export interface RelaySocket {
  /** False when the socket is closed, dropped it, or now holds more unsent than its budget. */
  sendText(text: string): boolean;
  sendBinary(bytes: Uint8Array): boolean;
  close(code: number): void;
  /** Unsent bytes held now. */
  readonly pending: number;
}

/** A server WebSocket as a relay socket, with `pendingLimit` bytes of unsent data at most. */
export function serverSocket<T>(ws: ServerWebSocket<T>, pendingLimit: number): RelaySocket {
  const buffered = () => {
    try {
      return ws.getBufferedAmount();
    } catch {
      return 0;
    }
  };
  const send = (data: string | Uint8Array): boolean => {
    try {
      const status = ws.send(data);
      if (status === 0) return false;
      return buffered() <= pendingLimit;
    } catch {
      return false;
    }
  };
  return {
    sendText: send,
    sendBinary: send,
    close(code) {
      try {
        ws.close(code);
      } catch {
        // Already closed.
      }
    },
    get pending() {
      return buffered();
    },
  };
}

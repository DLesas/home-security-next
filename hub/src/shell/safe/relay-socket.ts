/**
 * The hub's WebSocket client to its relay behind results (docs/m4-design.md section 4,
 * "Connecting"; hub-design.md section 10): Bun's built-in `WebSocket`, whose constructor throws on
 * a URL it cannot use and whose `send` and `close` throw on a socket in the wrong state. Every
 * message is handed on as it arrives: text as a string, binary as bytes. A failure to connect
 * (a name that does not resolve, no TCP connection, TLS refused) is a close with code 1006, as
 * the WebSocket standard has it; the standard gives the client no finer reason. Owner B6.
 */
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { errorFrom } from "./thrown.ts";

const ORIGIN = "shell/safe/relay-socket";
/** `readyState` of an open WebSocket. */
const OPEN = 1;

/** What the socket tells its owner, each at most once but `binary` and `text`. */
export interface RelaySocketEvents {
  open(): void;
  text(text: string): void;
  binary(bytes: Uint8Array): void;
  /** The socket closed, or never opened (1006). Nothing is told after this. */
  closed(code: number): void;
}

/** One link to a relay, as the relay client uses it. */
export interface RelaySocket {
  sendText(text: string): Result<void, HubError>;
  sendBinary(bytes: Uint8Array): Result<void, HubError>;
  /** Closes it; `closed` follows. Never throws. */
  close(code: number): void;
}

/** Opens a link; the factory the relay client is given, so tests can give their own. */
export type RelaySocketFactory = (
  url: string,
  events: RelaySocketEvents,
) => Result<RelaySocket, HubError>;

function send(socket: WebSocket, data: string | Uint8Array): Result<void, HubError> {
  if (socket.readyState !== OPEN)
    return err({ kind: "link", origin: ORIGIN, message: "send on a relay link that is not open" });
  try {
    socket.send(data);
    return ok(undefined);
  } catch (thrown) {
    return err(errorFrom("link", ORIGIN, "send on the relay link", thrown));
  }
}

/** Opens `url` with Bun's WebSocket client. */
export const openRelaySocket: RelaySocketFactory = (url, events) => {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (thrown) {
    return err(errorFrom("link", ORIGIN, "open the relay link", thrown));
  }
  socket.binaryType = "arraybuffer";
  let ended = false;
  socket.onopen = () => {
    if (!ended) events.open();
  };
  socket.onmessage = (event: MessageEvent) => {
    if (ended) return;
    const data: unknown = event.data;
    if (typeof data === "string") events.text(data);
    else if (data instanceof ArrayBuffer) events.binary(new Uint8Array(data));
  };
  socket.onclose = (event: CloseEvent) => {
    if (ended) return;
    ended = true;
    events.closed(event.code);
  };
  return ok({
    sendText: (text) => send(socket, text),
    sendBinary: (bytes) => send(socket, bytes),
    close: (code) => {
      try {
        socket.close(code);
      } catch {
        // A code the standard does not allow a client: closed plainly instead.
        try {
          socket.close();
        } catch {
          // Already closing: its `close` event follows.
        }
      }
    },
  });
};

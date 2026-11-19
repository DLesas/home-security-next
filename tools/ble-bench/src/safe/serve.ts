/**
 * Listening with Bun.serve, which throws when the port is taken, behind a result (rule 3: every
 * `try` of the bench is in this folder): a WebSocket server on one address, its sockets each with
 * the state `open` makes, and plain HTTP answered by `fetch` when given (the desk page).
 */
import { fault, ok, type Outcome } from "../outcome.ts";

/** One socket, as the handlers see it. */
export interface SocketPeer {
  send(text: string): void;
  close(): void;
}

export interface ServeSockets<S> {
  readonly hostname: string;
  readonly port: number;
  open(peer: SocketPeer): S;
  message(peer: SocketPeer, state: S, text: string): void;
  close(state: S): void;
  /** Answers a request that is not an upgrade; 404 when absent. */
  readonly fetch?: (request: Request) => Response | Promise<Response>;
}

export interface Served {
  readonly port: number;
  stop(): void;
}

interface Data<S> {
  state: S | undefined;
}

function peerOf(ws: { send(text: string): unknown; close(): void }): SocketPeer {
  return {
    send: (text) => {
      try {
        ws.send(text);
      } catch {
        // A socket closing as it is written to: the close handler follows.
      }
    },
    close: () => {
      ws.close();
    },
  };
}

export function serveSockets<S>(options: ServeSockets<S>): Outcome<Served, "cannotListen"> {
  try {
    const server = Bun.serve<Data<S>>({
      hostname: options.hostname,
      port: options.port,
      fetch(request, srv) {
        if (srv.upgrade(request, { data: { state: undefined } })) return undefined;
        return options.fetch?.(request) ?? new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.data.state = options.open(peerOf(ws));
        },
        message(ws, message) {
          const state = ws.data.state;
          if (state === undefined || typeof message !== "string") return;
          options.message(peerOf(ws), state, message);
        },
        close(ws) {
          const state = ws.data.state;
          if (state !== undefined) options.close(state);
        },
      },
    });
    return ok({
      port: server.port ?? options.port,
      stop: () => {
        void server.stop(true);
      },
    });
  } catch {
    return fault("cannotListen");
  }
}

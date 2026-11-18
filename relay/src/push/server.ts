/**
 * The push service's listeners (docs/m4-design.md section 3, "Roles" and D142): `/v1/relay` on
 * the local socket the operator's relay opens (the socket's mode lets only that account in), and,
 * when configured, on a TLS listener for self-hosted relays. Before an upgrade the link guard
 * decides, so a refused peer gets an HTTP answer and nothing else: no WebSocket, no Noise state.
 */
import type { Server, ServerWebSocket } from "bun";
import { err, ok, type Result } from "neverthrow";
import { RELAY_LIMITS, RELAY_PATHS } from "@hsn/protocol/relay";
import type { PushError } from "./errors.ts";
import { addressKey } from "./link-guard.ts";
import type { PushService } from "./push-service.ts";
import type { RelayLinkServer } from "./relay-link.ts";
import { removeStaleSocket, setMode } from "./safe/fs.ts";
import { serve } from "./safe/serve.ts";
import { serverSocket } from "./safe/websocket.ts";

interface SocketData {
  readonly address: string | null;
  readonly local: boolean;
  link?: RelayLinkServer;
}

/** A push frame of 32 items with the longest tokens and `h` fits well inside this ‡. */
export const MAX_RELAY_FRAME_BYTES = 256 * 1024;

export interface ListenOptions {
  /** The local socket's path, for the operator's relay. */
  readonly socketPath?: string;
  /** The socket file's mode: 0600 when the relay runs as the same account, 0660 with a shared group. */
  readonly socketMode?: number;
  /** A TLS listener for self-hosted relays. */
  readonly tcp?: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: { readonly key: string; readonly cert: string };
  };
}

export interface PushListeners {
  /** The TLS listener's port, when there is one. */
  readonly port: number | undefined;
  stop(): Promise<void>;
}

function handlers(service: PushService, local: boolean) {
  return {
    fetch(request: Request, server: Server<SocketData>): Response | undefined {
      if (new URL(request.url).pathname !== RELAY_PATHS.relay) {
        return new Response(null, { status: 404 });
      }
      const ip = local ? null : server.requestIP(request)?.address;
      const address = ip === null || ip === undefined ? null : addressKey(ip);
      if (!local && address === null) return new Response(null, { status: 400 });
      const answer = service.upgrade(address);
      if (answer === "rate") return new Response(null, { status: 429 });
      if (answer === "busy") return new Response(null, { status: 503 });
      if (!server.upgrade(request, { data: { address, local } })) {
        service.abandon(address);
        return new Response(null, { status: 400 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: MAX_RELAY_FRAME_BYTES,
      // The links' own clocks close slow handshakes and silent links (`relay-link.ts`).
      idleTimeout: Math.ceil((RELAY_LIMITS.silentLinkMs * 2) / 1000),
      sendPings: false,
      open(ws: ServerWebSocket<SocketData>) {
        ws.data.link = service.open(serverSocket(ws), {
          address: ws.data.address,
          local: ws.data.local,
        });
      },
      message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
        ws.data.link?.receive(typeof message === "string" ? message : new Uint8Array(message));
      },
      close(ws: ServerWebSocket<SocketData>, code: number) {
        ws.data.link?.socketClosed(code);
      },
    },
  };
}

/** Starts the listeners the options name. */
export function listen(
  service: PushService,
  options: ListenOptions,
): Result<PushListeners, PushError> {
  const servers: Server<SocketData>[] = [];
  const stopAll = async () => {
    service.stop();
    for (const server of servers) await server.stop(true);
  };
  if (options.socketPath !== undefined) {
    const path = options.socketPath;
    const removed = removeStaleSocket(path);
    if (removed.isErr()) return err(removed.error);
    const local = serve<SocketData>({ unix: path, ...handlers(service, true) }, "the local socket");
    if (local.isErr()) return err(local.error);
    servers.push(local.value);
    const mode = setMode(path, options.socketMode ?? 0o600);
    if (mode.isErr()) {
      void local.value.stop(true);
      return err(mode.error);
    }
  }
  const tcp = options.tcp;
  let port: number | undefined;
  if (tcp !== undefined) {
    const remote = serve<SocketData>(
      {
        hostname: tcp.hostname,
        port: tcp.port,
        tls: { key: tcp.tls.key, cert: tcp.tls.cert },
        ...handlers(service, false),
      },
      `${tcp.hostname}:${tcp.port}`,
    );
    if (remote.isErr()) {
      for (const server of servers) void server.stop(true);
      return err(remote.error);
    }
    servers.push(remote.value);
    port = remote.value.port;
  }
  return ok({ port, stop: stopAll });
}

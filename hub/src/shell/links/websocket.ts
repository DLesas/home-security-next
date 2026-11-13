/**
 * WebSocket links (hub-design.md section 3, "WebSocket links"; protocol.md §10): Hono on
 * `Bun.serve`, path `/device`, on the apps' port. Binary messages only, one packet each, at most
 * 1,024 bytes (§3). A text message closes the socket with code 1003, and its `linkClosed` is
 * counted by the core as a `textFrame` rejection. A message over 1,024 bytes is passed on as a
 * frame, which the core refuses as `tooLong` and counts; Bun closes a socket whose message
 * passes `MESSAGE_LIMIT_BYTES`. Bun answers the siren's pings; a socket idle for 60 s ‡ (no
 * message and no ping) is closed. Back-pressure and a dropped message are `send` errors.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { Hono } from "hono";
import { ok } from "neverthrow";
import type { LinkId } from "../../core/model/ids.ts";
import { closeWebSocket, sendWebSocket } from "../safe/websocket.ts";
import { type LinkRegistry, ORIGIN } from "./registry.ts";

/** The devices' path on the apps' port (§10). */
export const DEVICE_PATH = "/device";

/** A socket with no message and no ping for this long is closed (section 3, 60 s ‡). */
export const IDLE_CLOSE_MS = 60_000;

/** The close code for a text message: unsupported data (RFC 6455, section 3). */
export const CLOSE_UNSUPPORTED_DATA = 1003;
/** The close code when the hub closes a socket itself. */
export const CLOSE_NORMAL = 1000;

/**
 * The largest message Bun takes before it closes the socket: well above a packet's 1,024 bytes
 * (§3), so an oversized packet still reaches the core and is counted, and small enough to bound
 * what one message can cost. This design's choice.
 */
export const MESSAGE_LIMIT_BYTES = 16 * 1024;

/** What each socket carries. */
export interface DeviceSocket {
  readonly label: string;
  link: LinkId | undefined;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Its close was already reported (a text message, idle, or the hub's own close). */
  reported: boolean;
}

/** The endpoint: its routes and its WebSocket handlers. */
export interface DeviceEndpoint {
  /** The routes: `/device` upgrades to a WebSocket. Mount it on the apps' Hono app. */
  readonly app: Hono<{ Bindings: Server<DeviceSocket> }>;
  /** Bun's WebSocket handlers, for `Bun.serve({ websocket })`. */
  readonly websocket: WebSocketHandler<DeviceSocket>;
}

/** The endpoint's idle time, which tests shorten. */
export interface EndpointOptions {
  readonly idleMs?: number;
}

/** The `/device` endpoint, its links registered with `registry`. */
export function deviceEndpoint(
  registry: LinkRegistry,
  options: EndpointOptions = {},
): DeviceEndpoint {
  const idleMs = options.idleMs ?? IDLE_CLOSE_MS;
  const app = new Hono<{ Bindings: Server<DeviceSocket> }>();
  app.get(DEVICE_PATH, (c) => {
    const server = c.env;
    const peer = server.requestIP(c.req.raw);
    const label = peer === null ? "unknown peer" : `${peer.address}:${peer.port}`;
    const data: DeviceSocket = { label, link: undefined, idle: undefined, reported: false };
    return server.upgrade(c.req.raw, { data })
      ? new Response(null)
      : c.text("WebSocket upgrade required", 426);
  });

  const report = (
    ws: ServerWebSocket<DeviceSocket>,
    reason: "remote" | "idle" | "textMessage",
  ): void => {
    clearTimeout(ws.data.idle);
    if (ws.data.reported || ws.data.link === undefined) return;
    ws.data.reported = true;
    registry.closed(ws.data.link, reason);
  };

  const shut = (
    ws: ServerWebSocket<DeviceSocket>,
    code: number,
    why: string,
    reason: "idle" | "textMessage",
  ): void => {
    report(ws, reason);
    closeWebSocket(ws, code, why, ORIGIN).match(
      () => undefined,
      () => undefined,
    );
  };

  const stillActive = (ws: ServerWebSocket<DeviceSocket>): void => {
    clearTimeout(ws.data.idle);
    ws.data.idle = setTimeout(() => {
      shut(ws, CLOSE_NORMAL, "idle", "idle");
    }, idleMs);
  };

  const websocket: WebSocketHandler<DeviceSocket> = {
    maxPayloadLength: MESSAGE_LIMIT_BYTES,
    // The hub keeps its own idle rule, which counts pings as activity.
    idleTimeout: 0,
    sendPings: false,
    open(ws) {
      ws.data.link = registry.open("network", ws.data.label, {
        send: (bytes) => sendWebSocket(ws, bytes, ORIGIN),
        close: (reason) => {
          ws.data.reported = true;
          clearTimeout(ws.data.idle);
          return closeWebSocket(ws, CLOSE_NORMAL, reason, ORIGIN).orElse(() => ok(undefined));
        },
      });
      stillActive(ws);
    },
    message(ws, message) {
      if (typeof message === "string") {
        shut(ws, CLOSE_UNSUPPORTED_DATA, "binary messages only", "textMessage");
        return;
      }
      stillActive(ws);
      if (ws.data.link !== undefined) registry.frame(ws.data.link, new Uint8Array(message));
    },
    ping(ws) {
      stillActive(ws);
    },
    close(ws) {
      report(ws, "remote");
    },
  };
  return { app, websocket };
}

/** Serves the endpoint alone on `port` (0 for any free port): the bench bridge's and tests' way. */
export function serveDevices(
  registry: LinkRegistry,
  port: number,
  options: EndpointOptions = {},
): Server<DeviceSocket> {
  const endpoint = deviceEndpoint(registry, options);
  return Bun.serve<DeviceSocket>({
    port,
    fetch: (request, server) => endpoint.app.fetch(request, server),
    websocket: endpoint.websocket,
  });
}

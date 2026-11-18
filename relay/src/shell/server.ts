/**
 * The relay's listener (docs/m4-design.md section 3): `/v1/hub` for hub links and
 * `/v1/phone/<identity>/<path>` for phone streams, on one `Bun.serve`, over TLS or behind a
 * reverse proxy. Anything else is 404 and is never upgraded.
 *
 * **Before any state is kept** (D142, layer 1): the per-address and global rates are asked of the
 * relay with the address from `server.requestIP` before `upgrade`, so a refused peer gets HTTP 429
 * or 503 and no WebSocket, no Noise state and no X25519.
 *
 * **The client's address** is the socket's own, or, only when the socket's peer is one of the
 * configured `trustedProxies`, the last address of `X-Forwarded-For` that the proxy added (layer
 * 2: "the client's own address passed to the relay ... or layer 1's per-address limits count the
 * filter, not the attacker"). The load test uses this to come from many addresses on one Mac.
 *
 * **Message sizes.** Bun takes one largest message for a whole server: the largest binary frame
 * of a hub link (`RELAY_BINARY_LIMITS.maxFrameBytes`, a whole release piece), so a larger message
 * is closed by Bun (1009) before it is buffered. A phone's message is then checked against 65,535
 * bytes as it arrives (`checkPhoneMessage`: 1009); a phone can make the relay hold at most one
 * message of up to `maxFrameBytes` at a time.
 */
import type { Server, ServerWebSocket } from "bun";
import { RELAY_BINARY_LIMITS, RELAY_PATHS } from "@hsn/protocol/relay";
import type { Result } from "neverthrow";
import { addressKey } from "../core/address.ts";
import { PROTECTION_LIMITS } from "../core/rules.ts";
import type { RelayError } from "./errors.ts";
import type { HubLink } from "./hub-link.ts";
import type { PhoneStream } from "./phone-stream.ts";
import type { Relay } from "./relay.ts";
import { serve, upgrade } from "./safe/serve.ts";
import { serverSocket } from "./safe/websocket.ts";

interface SocketData {
  readonly kind: "hub" | "phone";
  readonly address: string;
  readonly url: string;
  hub?: HubLink | undefined;
  phone?: PhoneStream | undefined;
}

export interface ListenOptions {
  readonly hostname: string;
  readonly port: number;
  readonly tls?: { readonly key: string; readonly cert: string };
  /** Peers whose `X-Forwarded-For` is believed: a reverse proxy or filter in front. */
  readonly trustedProxies?: readonly string[];
}

export interface RelayListener {
  readonly port: number;
  stop(): Promise<void>;
}

/** The path of an absolute request URL, without query or fragment. */
export function requestPath(url: string): string {
  const rest = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(?<path>[^?#]*)/u.exec(url)?.groups?.path;
  return rest === undefined || rest === "" ? "/" : rest;
}

/** The address a request counts under, or undefined when none can be told. */
export function clientAddress(
  socketIp: string | undefined,
  forwardedFor: string | null,
  trusted: ReadonlySet<string>,
): string | undefined {
  if (socketIp === undefined) return undefined;
  const socketKey = addressKey(socketIp);
  if (socketKey === undefined) return undefined;
  if (!trusted.has(socketIp) && !trusted.has(socketKey)) return socketKey;
  const last = forwardedFor?.split(",").at(-1)?.trim();
  return last === undefined || last === "" ? undefined : addressKey(last);
}

export function listen(relay: Relay, options: ListenOptions): Result<RelayListener, RelayError> {
  const trusted = new Set(options.trustedProxies ?? []);
  const phonePrefix = `${RELAY_PATHS.phonePrefix}/`;
  const handlers = {
    fetch(request: Request, server: Server<SocketData>): Response | undefined {
      const path = requestPath(request.url);
      const kind =
        path === RELAY_PATHS.hub ? "hub" : path.startsWith(phonePrefix) ? "phone" : undefined;
      if (kind === undefined) return new Response(null, { status: 404 });
      const address = clientAddress(
        server.requestIP(request)?.address,
        request.headers.get("x-forwarded-for"),
        trusted,
      );
      if (address === undefined) return new Response(null, { status: 400 });
      const answer = kind === "hub" ? relay.hubUpgrade(address) : relay.phoneUpgrade(address);
      if (answer === "rate") return new Response(null, { status: 429 });
      if (answer === "busy") return new Response(null, { status: 503 });
      if (!upgrade(server, request, { kind, address, url: request.url })) {
        return new Response(null, { status: 400 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: RELAY_BINARY_LIMITS.maxFrameBytes,
      // Bun queues past our own budgets; `serverSocket` closes a reader past them (4429).
      backpressureLimit:
        PROTECTION_LIMITS.memory.pendingToHubLinkBytes + RELAY_BINARY_LIMITS.maxFrameBytes,
      closeOnBackpressureLimit: false,
      // The relay's own clocks close slow handshakes, silent links and idle streams.
      idleTimeout: 0,
      sendPings: false,
      open(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind === "hub") {
          ws.data.hub = relay.openHub(
            serverSocket(ws, PROTECTION_LIMITS.memory.pendingToHubLinkBytes),
            ws.data.address,
          );
        } else {
          ws.data.phone = relay.openPhone(
            serverSocket(ws, PROTECTION_LIMITS.memory.pendingToPhoneBytes),
            ws.data.address,
            ws.data.url,
          );
        }
      },
      message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
        const data = typeof message === "string" ? message : new Uint8Array(message);
        if (ws.data.hub !== undefined) ws.data.hub.receive(data);
        else ws.data.phone?.receive(data);
      },
      close(ws: ServerWebSocket<SocketData>, code: number) {
        ws.data.hub?.socketClosed();
        ws.data.phone?.socketClosed(code);
      },
    },
  };
  const what = `${options.hostname}:${options.port}`;
  const started = serve<SocketData>(
    {
      hostname: options.hostname,
      port: options.port,
      ...(options.tls === undefined ? {} : { tls: options.tls }),
      ...handlers,
    },
    what,
  );
  return started.map((server) => ({
    port: server.port ?? options.port,
    async stop() {
      relay.stop();
      await server.stop(true);
    },
  }));
}

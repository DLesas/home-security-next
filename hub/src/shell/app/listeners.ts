/**
 * The two app listeners (m2-design.md section 5, "Listeners"); the devices keep their own plain
 * WebSocket listener, `/device` on 8443 ‡ (`shell/links/websocket.ts`), untouched:
 *
 * | Listener | Address | Serves |
 * | --- | --- | --- |
 * | Apps on the home network | 8444 ‡ on every address, HTTPS with the hub's own certificate | the web app's files at `/`, the channel at `wss://…/app` |
 * | The hub computer's console | 8445 ‡ on 127.0.0.1 only, plain HTTP | the same files, `ws://127.0.0.1:8445/app` |
 *
 * The channel's three paths each carry one handshake: `/app` a session, `/app/link` and
 * `/app/restore` the two XXpsk3 handshakes (`HANDSHAKE_PATHS`).
 *
 * Every request passes `policy.ts`'s checks in order: the `Host` (421), for `/app` the upgrade and
 * the `Origin` (403), then the channel's admission (503) before the upgrade; every response,
 * refusals and the upgrade's included, carries the content security policy. Only `GET` and `HEAD`
 * reach the files; there are no cookies and no other endpoint. Each WebSocket message is at most
 * 65,535 bytes (one Noise message; Bun closes a socket that sends more), is never compressed, and
 * Bun's own idle timer and pings are off: liveness is the channel's, inside Noise.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { NOISE_LIMITS } from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { AppListener } from "../../core/model/events.ts";
import type { ConnId } from "../../core/model/ids.ts";
import { openServer, stopServer } from "../safe/app-serve.ts";
import { closeWebSocket, sendWebSocket } from "../safe/websocket.ts";
import { type CertificateNames, pem, type TlsMaterial } from "./certificate.ts";
import { hostKey } from "./addresses.ts";
import { type AppChannel, type ChannelSocket, handshakeOfPath, type Ticket } from "./channel.ts";
import {
  consoleRule,
  hostAllowed,
  type HostRule,
  lanRule,
  originAllowed,
  securityHeaders,
} from "./policy.ts";
import type { StaticFiles } from "./static-files.ts";

const ORIGIN = "shell/app/listeners";

/** The console listener's one address (section 5): loopback only, so no firewall rule opens. */
export const CONSOLE_HOST = "127.0.0.1";

/** Bytes queued on a slow socket before it is closed ‡: a peer cannot make the hub hold more. */
export const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;

interface SocketData {
  readonly ticket: Ticket;
  readonly listener: AppListener;
  conn: ConnId | undefined;
}

export interface ListenerOptions {
  readonly channel: AppChannel;
  readonly files: StaticFiles;
  /** The content security policy's value (`loadPolicy`). */
  readonly policy: string;
  /** The home network's listener; none in tests that need only the console. */
  readonly lan?: {
    readonly port: number;
    /** Every address by default. */
    readonly hostname?: string;
    readonly tls: TlsMaterial;
    readonly names: CertificateNames;
  };
  readonly console?: { readonly port: number };
}

function namesOf(names: CertificateNames): ReadonlySet<string> {
  return new Set([...names.dns, ...names.ips].map(hostKey));
}

function channelSocket(ws: ServerWebSocket<SocketData>): ChannelSocket {
  return {
    send: (bytes) => {
      const sent = sendWebSocket(ws, bytes, ORIGIN);
      // Back-pressure means queued, and still sent; the listener closes a socket past its limit.
      return { ok: sent.isOk() || sent.error.code === "backPressure" };
    },
    close: (code, reason) => {
      closeWebSocket(ws, code, reason, ORIGIN).match(
        () => undefined,
        () => undefined,
      );
    },
  };
}

export class AppListeners {
  readonly #options: ListenerOptions;
  readonly #headers: Record<string, string>;
  #lan: Server<SocketData> | undefined;
  #lanNames: ReadonlySet<string>;
  #console: Server<SocketData> | undefined;

  private constructor(options: ListenerOptions) {
    this.#options = options;
    this.#headers = securityHeaders(options.policy);
    this.#lanNames = options.lan === undefined ? new Set() : namesOf(options.lan.names);
  }

  /** Opens the listeners the options name; an error if one cannot open, with none left open. */
  static open(options: ListenerOptions): Result<AppListeners, HubError> {
    const listeners = new AppListeners(options);
    if (options.console !== undefined) {
      const opened = listeners.#serve("console", options.console.port, CONSOLE_HOST, undefined);
      if (opened.isErr()) return err(opened.error);
      listeners.#console = opened.value;
    }
    if (options.lan !== undefined) {
      const lan = options.lan;
      const opened = listeners.#serve("lan", lan.port, lan.hostname, lan.tls);
      if (opened.isErr()) {
        listeners.stop();
        return err(opened.error);
      }
      listeners.#lan = opened.value;
    }
    return ok(listeners);
  }

  get lanPort(): number | undefined {
    return this.#lan?.port;
  }

  get consolePort(): number | undefined {
    return this.#console?.port;
  }

  /**
   * A new certificate (a new address, or the renewal at 700 days ‡, section 5): the home
   * network's listener reopens on its port with it; sessions already open stay as they are.
   */
  useCertificate(tls: TlsMaterial, names: CertificateNames): Result<void, HubError> {
    const old = this.#lan;
    const lan = this.#options.lan;
    if (old === undefined || lan === undefined) return ok(undefined);
    const port = old.port ?? lan.port;
    const stopped = stopServer(old, false);
    if (stopped.isErr()) return err(stopped.error);
    this.#lanNames = namesOf(names);
    const opened = this.#serve("lan", port, lan.hostname, tls);
    if (opened.isErr()) {
      this.#lan = undefined;
      return err(opened.error);
    }
    this.#lan = opened.value;
    return ok(undefined);
  }

  /** Stops both listeners and closes their connections. */
  stop(): void {
    for (const server of [this.#lan, this.#console]) {
      if (server !== undefined)
        stopServer(server, true).match(
          () => undefined,
          () => undefined,
        );
    }
    this.#lan = undefined;
    this.#console = undefined;
  }

  #rule(listener: AppListener): HostRule {
    return listener === "console"
      ? consoleRule(this.#console?.port ?? 0)
      : lanRule(this.#lan?.port ?? 0, this.#lanNames);
  }

  #serve(
    listener: AppListener,
    port: number,
    hostname: string | undefined,
    tls: TlsMaterial | undefined,
  ): Result<Server<SocketData>, HubError> {
    return openServer<SocketData>(
      listener === "lan" ? "the apps' listener" : "the console listener",
      {
        port,
        ...(hostname === undefined ? {} : { hostname }),
        ...(tls === undefined
          ? {}
          : {
              tls: {
                key: pem("PRIVATE KEY", tls.privateKey),
                cert: pem("CERTIFICATE", tls.certificate),
              },
            }),
        fetch: (request, server) => this.#fetch(listener, request, server),
        websocket: this.#websocket(),
      },
    );
  }

  #respond(status: number, text: string, extra: Record<string, string> = {}): Response {
    return new Response(`${text}\n`, {
      status,
      headers: { ...this.#headers, "content-type": "text/plain; charset=utf-8", ...extra },
    });
  }

  #fetch(
    listener: AppListener,
    request: Request,
    server: Server<SocketData>,
  ): Response | undefined {
    const rule = this.#rule(listener);
    const host = request.headers.get("host");
    if (!hostAllowed(rule, host)) return this.#respond(421, "misdirected request");
    const url = URL.parse(request.url);
    if (url === null) return this.#respond(400, "bad request");
    const handshake = handshakeOfPath(url.pathname);
    if (handshake !== undefined) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return this.#respond(426, "WebSocket upgrade required");
      }
      if (!originAllowed(rule, host, request.headers.get("origin"))) {
        return this.#respond(403, "forbidden");
      }
      const address = server.requestIP(request)?.address ?? "unknown";
      const ticket = this.#options.channel.admit(address, handshake);
      if (ticket.refused) return this.#respond(ticket.status, "busy: try again");
      const data: SocketData = { ticket, listener, conn: undefined };
      if (server.upgrade(request, { data, headers: this.#headers })) return undefined;
      this.#options.channel.cancel(ticket);
      return this.#respond(400, "bad upgrade");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return this.#respond(405, "method not allowed", { allow: "GET, HEAD" });
    }
    const file = this.#options.files.find(url.pathname);
    if (file === undefined) return this.#respond(404, "not found");
    return new Response(request.method === "HEAD" ? null : Bun.file(file.path), {
      headers: { ...this.#headers, "content-type": file.type },
    });
  }

  #websocket(): WebSocketHandler<SocketData> {
    const channel = this.#options.channel;
    return {
      maxPayloadLength: NOISE_LIMITS.maxMessageBytes,
      idleTimeout: 0,
      sendPings: false,
      perMessageDeflate: false,
      backpressureLimit: BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
      open: (ws) => {
        ws.data.conn = channel.open(ws.data.ticket, channelSocket(ws), ws.data.listener);
      },
      message: (ws, message) => {
        const conn = ws.data.conn;
        if (conn === undefined) return;
        if (typeof message === "string") channel.text(conn);
        else channel.receive(conn, new Uint8Array(message));
      },
      close: (ws) => {
        const conn = ws.data.conn;
        if (conn !== undefined) channel.closed(conn);
        else channel.cancel(ws.data.ticket);
      },
    };
  }
}

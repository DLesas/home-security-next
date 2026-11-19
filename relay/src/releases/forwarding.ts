/**
 * Release frames from relay links, routed to the releases role on the operated service
 * (docs/m4-design.md sections 3 and 6, D142). A self-hosted relay fills its cache with
 * `release.check` and `release.get` over its relay link to the operated push service, which is
 * B3's own process under its own account; the releases role runs in the relay program. This is the
 * way between them: a local socket in the relay program, opened only by the push process's
 * account (the socket file's mode), on which the push process opens one WebSocket per joined relay
 * link and passes that link's release frames through, both ways, unchanged.
 *
 *   ws+unix://<socket>:/v1/releases/<identity>/<address>
 *
 * `<identity>` is the relay key the push service's XN proved; `<address>` the link's address key,
 * URL-encoded, or `local` for the operator's own socket. The release frames are the relay link's
 * own (`relayToPush`: `release.check`, `release.get`; `pushToRelay`: `release.offer`,
 * `release.error`, and binary kind 2 pieces), so the push process forwards text and binary as they
 * are. Any other frame closes the socket with 4400. Budgets count the relay key and the address
 * as on a hub link, with the per-relay-key row added (`core/release-budget.ts`).
 *
 * `ReleaseForwarder` is the push process's side, ready for its relay link to use; and a
 * self-hosted relay's cache can be filled through it on one host (`upstream.ts`).
 */
import { chmodSync } from "node:fs";
import type { Server, ServerWebSocket } from "bun";
import {
  decodeTextFrame,
  encodeTextFrame,
  IDENTITY_TEXT,
  type PushToRelayFrame,
  RELAY_BINARY_KIND,
  RELAY_BINARY_LIMITS,
  RELAY_CLOSE,
  RELAY_LIMITS,
  relayBinaryCodec,
} from "@hsn/protocol/relay";
import { err, ok, type Result } from "neverthrow";
import type { ReleasePeer } from "../core/release-budget.ts";
import { PROTECTION_LIMITS } from "../core/rules.ts";
import type { RelayError } from "../shell/errors.ts";
import type { RelayLog } from "../shell/log.ts";
import { attempt } from "../shell/safe/attempt.ts";
import { serve, upgrade } from "../shell/safe/serve.ts";
import { type RelaySocket, serverSocket } from "../shell/safe/websocket.ts";
import { localSocketUrl } from "../shell/safe/unix-websocket.ts";
import { remove } from "./safe/fs.ts";
import { checkOf, type ReleaseAnswers, requestOf } from "./service.ts";

const ORIGIN = "releases/forwarding";
export const RELEASES_PATH = "/v1/releases";
/** The address part for the operator's own local socket, which has no address. */
export const LOCAL_ADDRESS = "local";

/** The path a forwarded relay link opens. */
export function forwardingPath(identity: string, address: string | null): string {
  return `${RELEASES_PATH}/${identity}/${encodeURIComponent(address ?? LOCAL_ADDRESS)}`;
}

/** The peer a forwarded path names, or undefined. */
export function peerOfPath(path: string): ReleasePeer | undefined {
  const parts = path.split("/");
  // "", "v1", "releases", identity, address
  if (parts.length !== 5 || `/${parts[1]}/${parts[2]}` !== RELEASES_PATH) return undefined;
  const identity = parts[3] ?? "";
  if (!IDENTITY_TEXT.test(identity)) return undefined;
  const address = attempt("link", ORIGIN, "read the address", () =>
    decodeURIComponent(parts[4] ?? ""),
  ).unwrapOr("");
  if (address === "") return undefined;
  return { kind: "relay", identity, address: address === LOCAL_ADDRESS ? null : address };
}

/** One forwarded relay link's release frames. */
class ForwardedLink {
  private inHand = 0;
  private open = true;

  constructor(
    private readonly socket: RelaySocket,
    private readonly peer: ReleasePeer,
    private readonly releases: ReleaseAnswers,
  ) {}

  private send(frame: PushToRelayFrame): void {
    const text = encodeTextFrame("pushToRelay", frame);
    if (text.ok && !this.socket.sendText(text.value)) this.close(RELAY_CLOSE.overLimit);
  }

  receive(message: string | Uint8Array): void {
    if (!this.open) return;
    const frame = typeof message === "string" ? decodeTextFrame("relayToPush", message) : undefined;
    if (
      frame?.ok !== true ||
      (frame.value.t !== "release.check" && frame.value.t !== "release.get")
    ) {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    const value = frame.value;
    if (value.t === "release.check") {
      this.send({
        t: "release.offer",
        releases: [...this.releases.check(this.peer, checkOf(value))],
      });
      return;
    }
    if (this.inHand >= RELAY_LIMITS.maxReleasePiecesInFlight) {
      this.send({ t: "release.error", id: value.id, reason: "limit" });
      return;
    }
    this.inHand += 1;
    void this.releases.get(this.peer, requestOf(value)).then((answer) => {
      this.inHand -= 1;
      if (!this.open) return;
      if (!answer.ok) {
        this.send({
          t: "release.error",
          id: value.id,
          reason: answer.reason,
          ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }),
        });
        return;
      }
      const piece = relayBinaryCodec.encode({
        kind: RELAY_BINARY_KIND.releasePiece,
        id: value.id,
        bytes: answer.bytes,
      });
      if (!piece.ok) {
        this.send({ t: "release.error", id: value.id, reason: "unavailable" });
      } else if (!this.socket.sendBinary(piece.value)) {
        this.close(RELAY_CLOSE.overLimit);
      }
    });
  }

  close(code: number): void {
    if (!this.open) return;
    this.open = false;
    this.socket.close(code);
  }

  closed(): void {
    this.open = false;
  }
}

interface SocketData {
  readonly peer: ReleasePeer;
  link?: ForwardedLink;
}

export interface ForwardingListener {
  stop(): Promise<void>;
}

/** The relay program's side: the local socket at `path`, mode `mode` (0600 by default). */
export function listenForwarding(
  releases: ReleaseAnswers,
  path: string,
  log: RelayLog,
  mode = 0o600,
): Result<ForwardingListener, RelayError> {
  // A socket file left by a run that did not stop cleanly.
  remove(path).unwrapOr(undefined);
  const started = serve<SocketData>(
    {
      unix: path,
      fetch(request: Request, server: Server<SocketData>) {
        const pathname = /^[a-z+]+:\/\/[^/]*(?<p>\/[^?#]*)/u.exec(request.url)?.groups?.p ?? "";
        const peer = peerOfPath(pathname);
        if (peer === undefined) return new Response(null, { status: 404 });
        return upgrade(server, request, { peer }) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        maxPayloadLength: RELAY_BINARY_LIMITS.maxFrameBytes,
        idleTimeout: 0,
        sendPings: false,
        open(ws: ServerWebSocket<SocketData>) {
          ws.data.link = new ForwardedLink(
            serverSocket(ws, PROTECTION_LIMITS.memory.pendingToHubLinkBytes),
            ws.data.peer,
            releases,
          );
        },
        message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
          ws.data.link?.receive(typeof message === "string" ? message : new Uint8Array(message));
        },
        close(ws: ServerWebSocket<SocketData>) {
          ws.data.link?.closed();
        },
      },
    },
    "the releases socket",
  );
  if (started.isErr()) return err(started.error);
  const chmod = attempt("link", ORIGIN, "set the releases socket's mode", () => {
    chmodSync(path, mode);
  });
  if (chmod.isErr()) {
    void started.value.stop(true);
    return err(chmod.error);
  }
  log.write("info", "listening", { link: "local" });
  return ok({
    async stop() {
      await started.value.stop(true);
    },
  });
}

/** An answer through the forwarding socket: a text frame or a release piece, as they came. */
export type ForwardedAnswer = string | Uint8Array;

/**
 * The push process's side, for one joined relay link: opens the forwarding socket for the peer
 * its XN proved, passes the link's `release.check` and `release.get` text frames through as they
 * are, and gives back every answer (text or binary) to send on the relay link as it is.
 */
export class ReleaseForwarder {
  private readonly socket: WebSocket;
  private ready: Promise<boolean>;
  private open = false;

  private constructor(
    socket: WebSocket,
    onAnswer: (answer: ForwardedAnswer) => void,
    onClose: () => void,
  ) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this.ready = new Promise((resolve) => {
      socket.onopen = () => {
        this.open = true;
        resolve(true);
      };
      socket.onclose = () => {
        this.open = false;
        resolve(false);
        onClose();
      };
    });
    socket.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === "string") onAnswer(data);
      else if (data instanceof ArrayBuffer) onAnswer(new Uint8Array(data));
    };
  }

  /** Opens the forwarding socket at `socketPath` for `peer`. */
  static open(
    socketPath: string,
    peer: { readonly identity: string; readonly address: string | null },
    onAnswer: (answer: ForwardedAnswer) => void,
    onClose: () => void = () => undefined,
  ): Result<ReleaseForwarder, RelayError> {
    const url = `ws+unix://${socketPath}:${forwardingPath(peer.identity, peer.address)}`;
    return attempt(
      "link",
      ORIGIN,
      "open the releases socket",
      () => new WebSocket(localSocketUrl(url)),
    ).map((socket) => new ReleaseForwarder(socket, onAnswer, onClose));
  }

  /** Passes one release frame through; false when the socket is not open. */
  async forward(text: string): Promise<boolean> {
    if (!(await this.ready) || !this.open) return false;
    return attempt("link", ORIGIN, "forward a release frame", () => {
      this.socket.send(text);
      return true;
    }).unwrapOr(false);
  }

  close(): void {
    attempt("link", ORIGIN, "close the releases socket", () => {
      this.socket.close(1000);
    }).unwrapOr(undefined);
  }
}

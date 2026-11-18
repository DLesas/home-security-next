/**
 * The push service's side of one relay link, `/v1/relay` (docs/m4-design.md section 3, D142):
 * the relay proves its own static key in `Noise_XN_25519_ChaChaPoly_SHA256` with the prologue
 * `hsn-relay-peer/1`, as a hub does on its link, then sends frames in the clear inside TLS (or
 * the operator's local socket).
 *
 * | Message | Direction | Noise | Payload |
 * | --- | --- | --- | --- |
 * | 1 | relay → push | `e` | `RelayPeerHello {proto, relay}` |
 * | 2 | push → relay | `e, ee` | `RelayWelcome {proto, relay, roles: ["push"], limits}`, or close 4426 |
 * | 3 | relay → push | `s, se` | `RelayJoin {}`: the relay's key is proved; `joined {identity}` |
 *
 * The push service has no static key in XN: TLS with its certificate tells a relay it reached the
 * right service, and the local socket only the operator's relay's account can open. The handshake,
 * its payloads, the shared version and the proved identity are `@hsn/protocol/relay`'s
 * (`startRelayResponder("relay")`, B1's).
 *
 * Release frames go to the releases role when the host has a way to it (`releases-route.ts`),
 * opened at join for the identity XN proved and closed with the link; with none, `release.check`
 * is answered with an empty offer and `release.get` with `unavailable`. The link's own caps hold on
 * this path: pieces in hand, the largest binary frame, and a reader too slow for them (4429).
 *
 * Closes, as section 3 has them: 4400 a frame it cannot read (a text frame before the handshake
 * ends, a binary one after, a handshake message that does not verify, a payload no schema
 * accepts); 4408 the handshake not finished within 10 s, and a joined link silent for 75 s; 4426
 * no shared version; 4429 over a limit, a second message queued during a handshake step, and a
 * send the socket could not take; 4403 a relay key the operator refuses; 4001 replaced by a newer
 * link of the same key; 1001 the service stopping.
 */
import type { Handshake } from "@hsn/protocol/app";
import {
  decodeRelayJoin,
  decodeTextFrame,
  decodeRelayPeerHello,
  encodeRelayWelcome,
  provedIdentity,
  type PushOutcome,
  type PushToRelayFrame,
  RELAY_BINARY_KIND,
  RELAY_CLOSE,
  RELAY_LIMITS,
  relayBinaryCodec,
  type RelayPushItem,
  relayToPushFrame,
  sharedRelayProto,
  startRelayResponder,
} from "@hsn/protocol/relay";
import type { LinkClock } from "./clock.ts";
import type { PushLog } from "./log.ts";
import type { OpenReleaseRoute, ReleaseRoute } from "./releases-route.ts";
import { parseJson } from "./safe/json.ts";

/** The socket under a link: Bun's server WebSocket, through `safe/websocket.ts`. */
export interface LinkSocket {
  /** False when the socket could not take it (closed, or its buffer full). */
  sendText(text: string): boolean;
  sendBinary(bytes: Uint8Array): boolean;
  close(code: number): void;
}

/** One item's outcome. */
export interface ItemResult {
  readonly id: number;
  readonly outcome: PushOutcome;
}

/** What a push frame gets: a result per item, and a `limit` to send first when the link is over one. */
export interface PushAnswer {
  readonly results: readonly ItemResult[];
  readonly limitRetryAfterMs?: number;
}

/** What the push service gives each link. */
export interface LinkHost {
  /** The push role's version, `MAJOR.MINOR.PATCH`. */
  readonly version: string;
  readonly clock: LinkClock;
  readonly log: PushLog;
  /** Push frames one link may have in hand at once. */
  readonly framesInHand: number;
  /** The relay proved `identity`: let it join, or say why not. */
  join(link: RelayLinkServer, identity: string): "ok" | "refused" | "full";
  /** Sends a frame's items; resolves when every item has an outcome. Never rejects. */
  push(link: RelayLinkServer, items: readonly RelayPushItem[]): Promise<PushAnswer>;
  /** The link closed; called once. */
  gone(link: RelayLinkServer): void;
  /** The way to the releases role, opened at join; none when no releases socket is configured. */
  readonly openReleases?: OpenReleaseRoute | undefined;
}

/** Where the link came from. */
export interface LinkPeer {
  /** The address key (`addressKey`), or null on the local socket. */
  readonly address: string | null;
  /** The operator's local socket. */
  readonly local: boolean;
}

type LinkState = "hello" | "join" | "joined" | "closed";

export class RelayLinkServer {
  private state: LinkState = "hello";
  private handshake: Handshake | undefined;
  private busy = false;
  private queued: (string | Uint8Array)[] = [];
  private inHand = 0;
  private wasJoined = false;
  private relayIdentity: string | undefined;
  private cancelTimer: () => void;
  private releases: ReleaseRoute | undefined;
  /** `release.get` ids sent to the releases role and not yet answered. */
  private readonly piecesInHand = new Set<number>();

  constructor(
    private readonly socket: LinkSocket,
    private readonly host: LinkHost,
    readonly peer: LinkPeer,
  ) {
    this.cancelTimer = host.clock.after(RELAY_LIMITS.handshakeMs, () => {
      this.close(RELAY_CLOSE.handshakeTimeout);
    });
  }

  /** Read through a method: the state changes across an `await`, which narrowing does not see. */
  private isClosed(): boolean {
    return this.state === "closed";
  }

  /** The relay's identity, once it proved its key. */
  get identity(): string | undefined {
    return this.relayIdentity;
  }

  get joined(): boolean {
    return this.state === "joined";
  }

  /** A WebSocket message from the relay. */
  receive(message: string | Uint8Array): void {
    if (this.state === "closed") return;
    if (this.state === "joined") {
      this.frame(message);
      return;
    }
    // A handshake step: one message in hand and one queued, at most (D142).
    if (this.busy) {
      if (this.queued.length >= 1) {
        this.close(RELAY_CLOSE.overLimit);
        return;
      }
      this.queued.push(message);
      return;
    }
    this.busy = true;
    void this.step(message).then(() => {
      this.busy = false;
      const next = this.queued.shift();
      if (next !== undefined) this.receive(next);
    });
  }

  private async step(message: string | Uint8Array): Promise<void> {
    if (typeof message === "string") {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    if (this.state === "hello") await this.hello(message);
    else if (this.state === "join") await this.join(message);
  }

  private async hello(message: Uint8Array): Promise<void> {
    const started = startRelayResponder("relay");
    if (!started.ok) {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    const handshake = started.value;
    this.handshake = handshake;
    const read = await handshake.readMessage(message);
    if (this.isClosed()) return;
    const hello = read.ok ? decodeRelayPeerHello(read.value) : undefined;
    if (hello?.ok !== true) {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    const shared = sharedRelayProto(hello.value.proto);
    if (shared === undefined) {
      this.close(RELAY_CLOSE.noSharedVersion);
      return;
    }
    const welcome = encodeRelayWelcome({
      proto: shared,
      relay: this.host.version,
      roles: ["push"],
      limits: {
        maxRosterBytes: RELAY_LIMITS.maxRosterBytes,
        maxPushItemsPerFrame: RELAY_LIMITS.maxPushItemsPerFrame,
        maxReleasePieceBytes: RELAY_LIMITS.maxReleasePieceBytes,
        maxRestartWithinMs: RELAY_LIMITS.maxRestartWithinMs,
      },
    });
    if (!welcome.ok) {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    const written = await handshake.writeMessage(welcome.value);
    if (this.isClosed()) return;
    if (!written.ok) {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    this.state = "join";
    this.sendOrClose(this.socket.sendBinary(written.value));
  }

  private async join(message: Uint8Array): Promise<void> {
    const handshake = this.handshake;
    if (handshake === undefined) return;
    const read = await handshake.readMessage(message);
    if (this.isClosed()) return;
    const identity = read.ok ? provedIdentity(handshake) : undefined;
    if (!read.ok || identity === undefined || !decodeRelayJoin(read.value).ok) {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    this.relayIdentity = identity;
    this.handshake = undefined;
    const answer = this.host.join(this, identity);
    if (answer !== "ok") {
      this.host.log.write("warning", "linkRefused", {
        why: answer === "refused" ? "relayKey" : "authenticated",
        peer: this.peer.local ? "local" : "remote",
      });
      this.close(answer === "refused" ? RELAY_CLOSE.refused : RELAY_CLOSE.overLimit);
      return;
    }
    this.state = "joined";
    this.wasJoined = true;
    this.host.log.write("info", "linkJoined", { peer: this.peer.local ? "local" : "remote" });
    this.send({ t: "joined", identity });
    this.heard();
    this.releases = this.host.openReleases?.(
      { identity, address: this.peer.address },
      (answer) => {
        this.releaseAnswer(answer);
      },
      () => {
        this.releasesGone();
      },
    );
  }

  /** Any frame on a joined link: the silent-link clock starts again. */
  private heard(): void {
    this.cancelTimer();
    this.cancelTimer = this.host.clock.after(RELAY_LIMITS.silentLinkMs, () => {
      this.close(RELAY_CLOSE.handshakeTimeout);
    });
  }

  private frame(message: string | Uint8Array): void {
    if (typeof message !== "string") {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    const parsed = parseJson(message, "link", "push/relay-link", "a relay's frame")
      .map((json) => relayToPushFrame.safeParse(json))
      .unwrapOr(undefined);
    if (parsed?.success !== true) {
      this.close(RELAY_CLOSE.badFrame);
      return;
    }
    this.heard();
    const frame = parsed.data;
    switch (frame.t) {
      case "ping":
        this.send({ t: "pong", n: frame.n });
        return;
      case "push":
        this.push(frame.items);
        return;
      case "release.check":
        this.releaseCheck(message);
        return;
      case "release.get":
        this.releaseGet(message, frame.id);
        return;
    }
  }

  /** `release.check`: to the releases role, or an empty offer when there is none to ask. */
  private releaseCheck(text: string): void {
    const releases = this.releases;
    if (releases === undefined) {
      this.send({ t: "release.offer", releases: [] });
      return;
    }
    void releases.forward(text).then((sent) => {
      if (!sent) this.send({ t: "release.offer", releases: [] });
    });
  }

  /**
   * `release.get`: to the releases role, at most `maxReleasePiecesInFlight` at once on this link
   * (the hub pulls, so nothing piles up; one more is `limit`), or `unavailable` when there is no
   * releases role to ask or the id is already in hand.
   */
  private releaseGet(text: string, id: number): void {
    const releases = this.releases;
    if (releases === undefined || this.piecesInHand.has(id)) {
      this.send({ t: "release.error", id, reason: "unavailable" });
      return;
    }
    if (this.piecesInHand.size >= RELAY_LIMITS.maxReleasePiecesInFlight) {
      this.send({ t: "release.error", id, reason: "limit", retryAfterMs: 1000 });
      return;
    }
    this.piecesInHand.add(id);
    void releases.forward(text).then((sent) => {
      if (sent || !this.piecesInHand.delete(id)) return;
      this.send({ t: "release.error", id, reason: "unavailable" });
    });
  }

  /**
   * An answer from the releases role, sent on as it is: a `release.offer`, a `release.error`, or a
   * piece for a `release.get` in hand, no larger than the largest binary frame. Anything else
   * closes the way to the releases role; the link itself stays.
   */
  private releaseAnswer(answer: string | Uint8Array): void {
    if (this.state !== "joined") return;
    if (typeof answer === "string") {
      const frame = decodeTextFrame("pushToRelay", answer);
      if (!frame.ok || (frame.value.t !== "release.offer" && frame.value.t !== "release.error")) {
        this.badReleaseAnswer();
        return;
      }
      if (frame.value.t === "release.error") this.piecesInHand.delete(frame.value.id);
      this.sendOrClose(this.socket.sendText(answer));
      return;
    }
    // The codec refuses a piece over `RELAY_BINARY_LIMITS.maxFrameBytes` (`badLength`).
    const piece = relayBinaryCodec.decode(answer);
    if (
      !piece.ok ||
      piece.value.kind !== RELAY_BINARY_KIND.releasePiece ||
      !this.piecesInHand.delete(piece.value.id)
    ) {
      this.badReleaseAnswer();
      return;
    }
    this.sendOrClose(this.socket.sendBinary(answer));
  }

  private badReleaseAnswer(): void {
    this.host.log.write("warning", "releasesUnreachable", { why: "badRequest" });
    this.releases?.close();
    this.releasesGone();
  }

  /** The way to the releases role closed: every piece in hand is answered `unavailable`. */
  private releasesGone(): void {
    this.releases = undefined;
    const ids = [...this.piecesInHand];
    this.piecesInHand.clear();
    if (this.state !== "joined") return;
    for (const id of ids) this.send({ t: "release.error", id, reason: "unavailable" });
  }

  private push(items: readonly RelayPushItem[]): void {
    if (this.inHand >= this.host.framesInHand) {
      this.send({ t: "limit", what: "pushes", retryAfterMs: 1000 });
      this.send({
        t: "pushResult",
        results: items.map((item) => ({ id: item.id, outcome: "limited" })),
      });
      return;
    }
    this.inHand += 1;
    void this.host.push(this, items).then((answer) => {
      this.inHand -= 1;
      if (this.state !== "joined") return;
      if (answer.limitRetryAfterMs !== undefined) {
        this.send({ t: "limit", what: "pushes", retryAfterMs: answer.limitRetryAfterMs });
      }
      this.send({ t: "pushResult", results: answer.results });
    });
  }

  private send(frame: PushToRelayFrame): void {
    if (this.state === "closed") return;
    this.sendOrClose(this.socket.sendText(JSON.stringify(frame)));
  }

  private sendOrClose(sent: boolean): void {
    if (!sent) this.close(RELAY_CLOSE.overLimit);
  }

  /** Closes the link with `code`; the host hears `gone` once. */
  close(code: number): void {
    if (this.state === "closed") return;
    this.socket.close(code);
    this.socketClosed(code);
  }

  /** The socket closed, by either side. */
  socketClosed(code?: number): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.cancelTimer();
    this.handshake = undefined;
    this.queued = [];
    const releases = this.releases;
    this.releases = undefined;
    this.piecesInHand.clear();
    releases?.close();
    if (this.wasJoined) {
      this.host.log.write("info", "linkClosed", {
        peer: this.peer.local ? "local" : "remote",
        ...(code === undefined ? {} : { code }),
      });
    }
    this.host.gone(this);
  }

  /** Whether it finished its handshake at some point, for the guard's counts. */
  get everJoined(): boolean {
    return this.wasJoined;
  }
}

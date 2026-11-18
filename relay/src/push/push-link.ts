/**
 * `PushSender` over a relay link (docs/m4-design.md section 3, D142; `sender.ts`): a relay's own
 * link to the push service. The operated relay opens it on the push role's local socket
 * (`ws+unix://<socket>:/v1/relay`), a self-hosted relay at `<DEPLOYMENT.push.url>/v1/relay`.
 *
 * It runs XN as the initiator with the relay's own static key (made at the relay's first start
 * and kept in its data folder, which is B2's), and keeps the link up as a hub keeps its own: the
 * hub's back-off after a failure (`RELAY_BACKOFF`, reset once a link lasted 60 s), the wait a
 * close asks for (4429 the `limit` frame's `retryAfterMs` or 10 minutes, 4426 10 minutes, 4001
 * 10 minutes), a `ping` every 30 s and a close when no `pong` comes within 15 s. Which of these a
 * close calls for is `relayCloseReconnect`'s; on 4403 (the operator refuses this relay's key) it
 * stops, reports it once, and tries again only when started again.
 *
 * It also carries a self-hosted relay's release cache (`relay/src/releases/upstream.ts`, B2's):
 * `releaseChannel` sends its `release.check` and `release.get`; the answers, `release.offer`,
 * `release.error` and binary kind 2 pieces, go to the cache `attachReleases` gave, which is told
 * when the link drops and asked to fill whenever the link joins, so a cut fetch resumes.
 *
 * `send` puts at most 32 items in a `push` frame and resolves when its `pushResult` arrives, or
 * with a `PushSendError`: `linkDown` when the link is not joined or closes first, `limited` while
 * the push service's last `limit` lasts, `timeout` after `resultTimeoutMs`. Never rejects.
 */
import type { Handshake, StaticKey } from "@hsn/protocol/app";
import {
  decodeRelayWelcome,
  encodeRelayJoin,
  encodeTextFrame,
  encodeRelayPeerHello,
  pushToRelayFrame,
  RELAY_BACKOFF,
  RELAY_CLOSE,
  RELAY_LIMITS,
  RELAY_PROTO,
  type RelayPushItem,
  relayCloseReconnect,
  type RelayToPushFrame,
  startRelayInitiator,
} from "@hsn/protocol/relay";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import {
  readUpstreamAnswer,
  type UpstreamCache,
  type UpstreamChannel,
} from "../releases/upstream.ts";
import type { LinkClock } from "./clock.ts";
import type { PushLog } from "./log.ts";
import { parseJson } from "./safe/json.ts";
import { clientClose, clientSend, openWebSocket } from "./safe/websocket.ts";
import type { PushSender, PushSendError, PushSendResult } from "./sender.ts";

const SECOND = 1000;

export interface PushLinkOptions {
  /** `ws+unix://<socket>:/v1/relay`, or `wss://<push host>/v1/relay`. */
  readonly url: string;
  /** The relay's own static key. */
  readonly staticKey: StaticKey;
  /** The relay program's version, `MAJOR.MINOR.PATCH`. */
  readonly version: string;
  readonly clock: LinkClock;
  readonly log: PushLog;
  /** A certificate authority to trust instead of the system's (tests, and a stand-in push service). */
  readonly ca?: string;
  /** A `pushResult` within this long, or the batch is `timeout` ‡. */
  readonly resultTimeoutMs?: number;
  /** The back-off's jitter, 0 to 1; `Math.random` when not given. */
  readonly random?: () => number;
}

/** What the link needs of a self-hosted relay's release cache. */
export type ReleaseCacheOf = Pick<UpstreamCache, "answer" | "linkDown" | "fill">;

/** The time a whole frame may take: APNs's and Google's own times, and a token fetch ‡. */
export const PUSH_RESULT_TIMEOUT_MS = 30 * SECOND;

/** `refused`: the push service refused this relay's key (4403); nothing is retried. */
type LinkState = "stopped" | "refused" | "waiting" | "handshaking" | "joining" | "up";

interface Batch {
  readonly ids: ReadonlySet<number>;
  readonly resolve: (result: Result<readonly PushSendResult[], PushSendError>) => void;
  readonly cancel: () => void;
}

export class PushLink implements PushSender {
  private state: LinkState = "stopped";
  private socket: WebSocket | undefined;
  private handshake: Handshake | undefined;
  private failures = 0;
  private upSinceMs = 0;
  private limitedUntilMs = 0;
  private lastRetryAfterMs: number | undefined;
  private pingN = 0;
  private readonly batches = new Set<Batch>();
  private cancelTimer: () => void = () => undefined;
  private cancelPong: () => void = () => undefined;
  private chain: Promise<void> = Promise.resolve();
  private cache: ReleaseCacheOf | undefined;

  constructor(private readonly options: PushLinkOptions) {}

  /** The cache's way upstream: release frames on this link, while it is joined. */
  readonly releaseChannel: UpstreamChannel = {
    send: (frame) => {
      const socket = this.socket;
      if (socket === undefined || this.state !== "up") return false;
      const text = encodeTextFrame("relayToPush", frame);
      return text.ok && clientSend(socket, text.value);
    },
  };

  /** The cache release answers go to; it fills each time the link joins. */
  attachReleases(cache: ReleaseCacheOf): void {
    this.cache = cache;
    if (this.state === "up") void cache.fill();
  }

  get up(): boolean {
    return this.state === "up";
  }

  /** Whether the push service refused this relay's key (4403): the link stays down until `start`. */
  get refused(): boolean {
    return this.state === "refused";
  }

  /** Opens the link and keeps it up until `stop`; after a refusal, tries once more. */
  start(): void {
    if (this.state !== "stopped" && this.state !== "refused") return;
    this.connect();
  }

  /** Closes the link for good: batches in flight end `linkDown`. */
  stop(): void {
    this.state = "stopped";
    this.cancelTimer();
    this.cancelPong();
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) clientClose(socket, 1000);
    this.failBatches();
    this.cache?.linkDown();
  }

  send(items: readonly RelayPushItem[]): ResultAsync<readonly PushSendResult[], PushSendError> {
    return new ResultAsync(this.sendAll(items));
  }

  private async sendAll(
    items: readonly RelayPushItem[],
  ): Promise<Result<readonly PushSendResult[], PushSendError>> {
    if (this.state !== "up") return err({ kind: "linkDown" });
    const nowMs = this.options.clock.now();
    if (nowMs < this.limitedUntilMs) {
      return err({ kind: "limited", retryAfterMs: this.limitedUntilMs - nowMs });
    }
    if (items.length === 0) return ok([]);
    const frames: (readonly RelayPushItem[])[] = [];
    for (let at = 0; at < items.length; at += RELAY_LIMITS.maxPushItemsPerFrame) {
      frames.push(items.slice(at, at + RELAY_LIMITS.maxPushItemsPerFrame));
    }
    const answers = await Promise.all(frames.map((frame) => this.sendFrame(frame)));
    const results: PushSendResult[] = [];
    for (const answer of answers) {
      if (answer.isErr()) return err(answer.error);
      results.push(...answer.value);
    }
    return ok(results);
  }

  private sendFrame(
    items: readonly RelayPushItem[],
  ): Promise<Result<readonly PushSendResult[], PushSendError>> {
    const socket = this.socket;
    if (socket === undefined || this.state !== "up")
      return Promise.resolve(err({ kind: "linkDown" }));
    return new Promise((resolve) => {
      const batch: Batch = {
        ids: new Set(items.map((item) => item.id)),
        resolve: (result) => {
          this.batches.delete(batch);
          batch.cancel();
          resolve(result);
        },
        cancel: this.options.clock.after(
          this.options.resultTimeoutMs ?? PUSH_RESULT_TIMEOUT_MS,
          () => {
            batch.resolve(err({ kind: "timeout" }));
          },
        ),
      };
      this.batches.add(batch);
      const frame: RelayToPushFrame = { t: "push", items };
      if (!clientSend(socket, JSON.stringify(frame))) batch.resolve(err({ kind: "linkDown" }));
    });
  }

  private failBatches(): void {
    for (const batch of [...this.batches]) batch.resolve(err({ kind: "linkDown" }));
  }

  private connect(): void {
    const opened = openWebSocket(this.options.url, this.options.ca);
    if (opened.isErr()) {
      this.options.log.write(
        "error",
        "relayLinkDown",
        { failures: this.failures + 1 },
        opened.error,
      );
      this.retry(undefined);
      return;
    }
    const socket = opened.value;
    this.socket = socket;
    this.state = "handshaking";
    this.cancelTimer();
    this.cancelTimer = this.options.clock.after(RELAY_LIMITS.handshakeMs, () => {
      if (this.socket === socket && this.state !== "up")
        clientClose(socket, RELAY_CLOSE.handshakeTimeout);
    });
    socket.onopen = () => {
      this.queue(socket, () => this.hello(socket));
    };
    socket.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      const message =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : undefined;
      if (message !== undefined) this.queue(socket, () => this.receive(socket, message));
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.closed(event.code);
    };
  }

  /** Handles a socket's events one at a time, in order: a handshake step awaits. */
  private queue(socket: WebSocket, run: () => Promise<void> | void): void {
    this.chain = this.chain.then(() => (this.socket === socket ? run() : undefined));
  }

  private async hello(socket: WebSocket): Promise<void> {
    const started = startRelayInitiator("relay", this.options.staticKey);
    const hello = encodeRelayPeerHello({
      proto: [RELAY_PROTO.min, RELAY_PROTO.max],
      relay: this.options.version,
    });
    if (!started.ok || !hello.ok) {
      clientClose(socket, RELAY_CLOSE.badFrame);
      return;
    }
    this.handshake = started.value;
    const written = await started.value.writeMessage(hello.value);
    if (!written.ok || !clientSend(socket, written.value))
      clientClose(socket, RELAY_CLOSE.badFrame);
  }

  private async receive(socket: WebSocket, message: string | Uint8Array): Promise<void> {
    if (this.state === "handshaking") {
      const handshake = this.handshake;
      if (typeof message === "string" || handshake === undefined) {
        clientClose(socket, RELAY_CLOSE.badFrame);
        return;
      }
      const read = await handshake.readMessage(message);
      const welcome = read.ok ? decodeRelayWelcome(read.value) : undefined;
      const join = encodeRelayJoin({});
      if (
        welcome?.ok !== true ||
        !join.ok ||
        welcome.value.proto < RELAY_PROTO.min ||
        welcome.value.proto > RELAY_PROTO.max ||
        !welcome.value.roles.includes("push")
      ) {
        clientClose(socket, RELAY_CLOSE.badFrame);
        return;
      }
      const written = await handshake.writeMessage(join.value);
      this.handshake = undefined;
      if (!written.ok || !clientSend(socket, written.value)) {
        clientClose(socket, RELAY_CLOSE.badFrame);
        return;
      }
      this.state = "joining";
      return;
    }
    if (typeof message !== "string") {
      // After the handshake, only release pieces; the codec refuses one over the largest binary
      // frame (`RELAY_BINARY_LIMITS.maxFrameBytes`).
      const piece = this.state === "up" ? readUpstreamAnswer(message) : undefined;
      if (piece?.kind !== "piece") {
        clientClose(socket, RELAY_CLOSE.badFrame);
        return;
      }
      this.cache?.answer(piece);
      return;
    }
    const parsed = parseJson(message, "link", "push/push-link", "the push service's frame")
      .map((json) => pushToRelayFrame.safeParse(json))
      .unwrapOr(undefined);
    if (parsed?.success !== true) {
      clientClose(socket, RELAY_CLOSE.badFrame);
      return;
    }
    const frame = parsed.data;
    switch (frame.t) {
      case "joined":
        if (this.state === "joining") this.joined(socket);
        return;
      case "pong":
        this.cancelPong();
        return;
      case "pushResult": {
        const first = frame.results[0]?.id;
        const batch = [...this.batches].find((b) => first !== undefined && b.ids.has(first));
        batch?.resolve(ok(frame.results));
        return;
      }
      case "limit":
        this.lastRetryAfterMs = frame.retryAfterMs;
        this.limitedUntilMs = this.options.clock.now() + frame.retryAfterMs;
        return;
      case "release.offer":
      case "release.error": {
        const answer = readUpstreamAnswer(message);
        if (answer !== undefined) this.cache?.answer(answer);
        return;
      }
    }
  }

  private joined(socket: WebSocket): void {
    this.state = "up";
    this.upSinceMs = this.options.clock.now();
    this.options.log.write("info", "relayLinkUp", { failures: this.failures });
    this.ping(socket);
    if (this.cache !== undefined) void this.cache.fill();
  }

  private ping(socket: WebSocket): void {
    this.cancelTimer();
    this.cancelTimer = this.options.clock.after(RELAY_LIMITS.hubPingEveryMs, () => {
      if (this.socket !== socket || this.state !== "up") return;
      this.pingN = (this.pingN + 1) >>> 0;
      const frame: RelayToPushFrame = { t: "ping", n: this.pingN };
      clientSend(socket, JSON.stringify(frame));
      this.cancelPong();
      this.cancelPong = this.options.clock.after(RELAY_LIMITS.pongWithinMs, () => {
        if (this.socket === socket) clientClose(socket, RELAY_CLOSE.handshakeTimeout);
      });
      this.ping(socket);
    });
  }

  private closed(code: number): void {
    const wasUp = this.state === "up";
    this.socket = undefined;
    this.handshake = undefined;
    this.cancelTimer();
    this.cancelPong();
    this.failBatches();
    this.cache?.linkDown();
    if (this.state === "stopped") return;
    if (wasUp && this.options.clock.now() - this.upSinceMs >= RELAY_BACKOFF.resetAfterMs) {
      this.failures = 0;
    }
    const next = relayCloseReconnect(code);
    const retryAfterMs = this.lastRetryAfterMs;
    this.lastRetryAfterMs = undefined;
    if (next === "never") {
      // Not a limit: waiting changes nothing. Said once, as an error for the operator.
      this.state = "refused";
      this.options.log.write("error", "relayLinkRefused", { code });
      return;
    }
    this.options.log.write("warning", "relayLinkDown", { code, failures: this.failures + 1 });
    if (next === "backoff") {
      this.retry(undefined);
      return;
    }
    this.retry(
      code === RELAY_CLOSE.replaced
        ? RELAY_LIMITS.identityInUseWaitMs
        : code === RELAY_CLOSE.overLimit
          ? (retryAfterMs ?? RELAY_LIMITS.limitWaitMs)
          : RELAY_LIMITS.limitWaitMs,
    );
  }

  /** Waits `waitMs`, or the back-off's next step with jitter, then connects again. */
  private retry(waitMs: number | undefined): void {
    this.state = "waiting";
    this.failures += 1;
    const step = RELAY_BACKOFF.stepsMs[this.failures - 1] ?? RELAY_BACKOFF.thenEveryMs;
    const jitter = 1 + RELAY_BACKOFF.jitter * (2 * (this.options.random ?? Math.random)() - 1);
    const delay = waitMs ?? Math.round(step * jitter);
    this.cancelTimer();
    this.cancelTimer = this.options.clock.after(delay, () => {
      if (this.state === "waiting") this.connect();
    });
  }
}

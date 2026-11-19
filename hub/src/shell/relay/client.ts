/**
 * The hub's relay client (docs/m4-design.md section 4): the link to the relay the core names,
 * kept up with back-off and keepalive; phones' streams into the app channel; sealed pushes and the
 * roster; releases checked and fetched; and the announcement before a restart. The core hears
 * only `relayLink {up | down}` with the URL it asked for, `pushResults` and `releaseOffered`.
 *
 * **Effects** (the loop performs them after the commit that justifies them, as it does the
 * channel's): `relayConnect {url}` opens the link to `url` (null: closes it and stays off);
 * `relayRoster`, `pushSend` and `pushKey` are the push side's (`push.ts`). A `fileJob
 * {fetchRelease}` is `fetch` (`releases.ts`).
 *
 * **Connecting, back-off.** A `relayConnect` for a new URL closes the old link and opens the new
 * one at once, with the back-off reset; a URL `hubLinkUrl` cannot use is reported and no link is
 * tried until the setting changes. After a link ends, what the relay's close code means
 * (`relayCloseReconnect`): 4403, the relay refuses this hub's key, is reported once and nothing
 * is tried again until the setting changes or the hub restarts; 4001, 4426 and 4429 wait
 * (`waitAfterClose`); anything else, and every close the hub made itself, backs off 1, 2, 4, 8,
 * 16, 32 s, then every 60 s ‡, each ±20% ‡, reset once a link lasted 60 s ‡ (`backoff.ts`). Each
 * end is `relayLink {down}` with its reason. `networkChanged` (the computer's addresses changed,
 * checked every minute) connects at once with the back-off reset if a wait is running, and probes
 * a link that is up with a `ping`.
 *
 * **Low cost (D112).** No polling: one timer for the next attempt while down, one keepalive timer
 * while up (`link.ts`), one for the daily release check, one for an unacknowledged roster. Nothing
 * of the keepalive reaches the core or the database.
 *
 * **Announcing a restart** (`announceRestart`, section 4): `restarting {reason, withinMs}` with
 * 10 minutes ‡ (or the relay's smaller bound), then the switch goes on once `restartingAck` came
 * or 2 s ‡ passed; with the link down nothing is sent, since the relay is already counting.
 */
import type { StaticKey } from "@hsn/protocol/app";
import {
  hubLinkUrl,
  RELAY_BINARY_KIND,
  RELAY_LIMITS,
  type RelayBinaryFrame,
  relayCloseReconnect,
  type RelayToHubFrame,
  type RelayWelcome,
} from "@hsn/protocol/relay";
import type { Result } from "neverthrow";
import type { Effect, FileWork } from "../../core/model/effects.ts";
import type { HubError } from "../../core/model/errors.ts";
import type { HubEvent } from "../../core/model/events.ts";
import type { JobId } from "../../core/model/ids.ts";
import type { PushKeys } from "../../ports/push-keys.ts";
import type { Timers } from "../app/channel.ts";
import type { JobStarted } from "../loop.ts";
import { openRelaySocket, type RelaySocketFactory } from "../safe/relay-socket.ts";
import { Backoff, waitAfterClose } from "./backoff.ts";
import { type LinkEnd, type LinkOwner, RelayLink } from "./link.ts";
import { RelayPush } from "./push.ts";
import { type ReleaseOptions, RelayReleases } from "./releases.ts";
import { RelayedStreams, type StreamChannel } from "./streams.ts";

const ORIGIN = "shell/relay/client";

/** The effects the relay client performs. */
export type RelayEffect = Extract<
  Effect,
  { readonly kind: "relayConnect" | "relayRoster" | "pushSend" | "pushKey" }
>;

/** Why a switch announces itself (section 4). */
export type RestartReason = "update" | "restore";

export interface RelayClientOptions {
  /** The hub's app static key: the one key of its IK sessions and its relay link (QR2). */
  readonly staticKey: StaticKey;
  readonly hubVersion: string;
  readonly channel: StreamChannel;
  readonly pushKeys: PushKeys;
  /** Every event for the core (`relayLink`, `pushResults`, `releaseOffered`, recorded faults). */
  readonly emit: (event: HubEvent) => void;
  /** What the client could not do and the core need not know, for standard error. */
  readonly report: (error: HubError) => void;
  readonly timers: Timers;
  /** Milliseconds on a monotonic clock. */
  readonly now: () => number;
  /** `length` fresh bytes from the system's secure generator: nonces, and the jitter's draws. */
  readonly random: (length: number) => Result<Uint8Array, HubError>;
  /** Opens a socket; Bun's WebSocket client when not given. */
  readonly connect?: RelaySocketFactory;
  /** Releases: the platform, the running version, the store, the staging, the loop's wake. */
  readonly releases: Omit<ReleaseOptions, "emit" | "timers">;
}

/** The state the client is in, for tests and `hsn status` later. */
export type RelayClientState =
  | { readonly kind: "off" }
  | { readonly kind: "connecting"; readonly url: string }
  | { readonly kind: "up"; readonly url: string }
  | { readonly kind: "waiting"; readonly url: string; readonly ms: number }
  | { readonly kind: "refused"; readonly url: string }
  | { readonly kind: "badUrl"; readonly url: string };

export class RelayClient implements LinkOwner {
  readonly #o: RelayClientOptions;
  readonly #backoff = new Backoff();
  readonly #push: RelayPush;
  readonly #releases: RelayReleases;
  #url: string | null = null;
  #link: RelayLink | undefined;
  #streams: RelayedStreams | undefined;
  #welcome: RelayWelcome | undefined;
  #retry: (() => void) | undefined;
  #state: RelayClientState = { kind: "off" };
  #stopped = false;
  readonly #restartWaiters = new Set<() => void>();

  constructor(options: RelayClientOptions) {
    this.#o = options;
    this.#push = new RelayPush({
      keys: options.pushKeys,
      nonce: () => options.random(12),
      emit: options.emit,
      report: options.report,
      timers: options.timers,
    });
    this.#releases = new RelayReleases({
      ...options.releases,
      emit: options.emit,
      timers: options.timers,
    });
  }

  get state(): RelayClientState {
    return this.#state;
  }

  /** The push side, for tests. */
  get push(): RelayPush {
    return this.#push;
  }

  /** The releases side, for tests. */
  get releases(): RelayReleases {
    return this.#releases;
  }

  /** Relayed streams open now. */
  get streams(): number {
    return this.#streams?.open ?? 0;
  }

  /** The back-off's failures since its last reset, for tests. */
  get failures(): number {
    return this.#backoff.failures;
  }

  // ----- The core's effects -----

  perform(effect: RelayEffect): void {
    switch (effect.kind) {
      case "relayConnect":
        this.#connectTo(effect.url);
        return;
      case "relayRoster":
        this.#push.roster(effect);
        return;
      case "pushSend":
        this.#push.send(effect);
        return;
      case "pushKey":
        this.#push.key(effect);
        return;
    }
  }

  /** `fileJob {fetchRelease}`. */
  fetch(job: JobId, work: Extract<FileWork, { readonly kind: "fetchRelease" }>): JobStarted {
    return this.#releases.start(job, work);
  }

  /** The computer's addresses changed: connect now if waiting, probe the link if up. */
  networkChanged(): void {
    if (this.#stopped || this.#url === null) return;
    if (this.#link?.up === true) {
      this.#link.probe();
      return;
    }
    if (this.#retry !== undefined) {
      this.#retry();
      this.#retry = undefined;
      this.#backoff.reset();
      this.#open();
    }
  }

  /**
   * Before a switch the hub makes itself (an update's or a restore's): `restarting {reason,
   * withinMs}`, then resolved when `restartingAck` came, 2 s ‡ passed, or the link ended; at once
   * when the link is not up. Never rejects.
   */
  announceRestart(reason: RestartReason): Promise<void> {
    const link = this.#link;
    const welcome = this.#welcome;
    if (link?.up !== true || welcome === undefined) return Promise.resolve();
    const withinMs = Math.min(RELAY_LIMITS.maxRestartWithinMs, welcome.limits.maxRestartWithinMs);
    if (link.sendText({ t: "restarting", reason, withinMs }).isErr()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        stopTimer();
        this.#restartWaiters.delete(done);
        resolve();
      };
      const stopTimer = this.#o.timers.after(RELAY_LIMITS.restartAckWaitMs, done);
      this.#restartWaiters.add(done);
    });
  }

  /** The hub is stopping: the link closes and nothing more is tried. */
  stop(): void {
    this.#stopped = true;
    this.#retry?.();
    this.#retry = undefined;
    this.#link?.close("stopping");
    this.#releases.stop();
    this.#push.stop();
  }

  // ----- Connecting -----

  #connectTo(url: string | null): void {
    if (this.#stopped) return;
    if (url === this.#url && this.#state.kind !== "off") return;
    const old = this.#link;
    this.#link = undefined;
    this.#retry?.();
    this.#retry = undefined;
    this.#url = url;
    this.#backoff.reset();
    // The old link's end is not this URL's: it is told to nobody, but what rode on it ends.
    this.#lost();
    old?.close("closed");
    if (url === null) {
      this.#state = { kind: "off" };
      return;
    }
    if (hubLinkUrl(url) === undefined) {
      this.#state = { kind: "badUrl", url };
      this.#o.report({ kind: "config", origin: ORIGIN, message: "the relay's URL cannot be used" });
      this.#o.emit({ kind: "relayLink", state: "down", url, reason: "connect" });
      return;
    }
    this.#open();
  }

  #open(): void {
    const url = this.#url;
    const linkUrl = url === null ? undefined : hubLinkUrl(url);
    if (this.#stopped || url === null || linkUrl === undefined) return;
    const link = new RelayLink({
      url: linkUrl,
      staticKey: this.#o.staticKey,
      hubVersion: this.#o.hubVersion,
      connect: this.#o.connect ?? openRelaySocket,
      timers: this.#o.timers,
      now: this.#o.now,
      owner: this,
      report: this.#o.report,
    });
    this.#link = link;
    this.#state = { kind: "connecting", url };
    link.start();
  }

  // ----- The link's events (`LinkOwner`) -----

  joined(link: RelayLink, welcome: RelayWelcome): void {
    const url = this.#url;
    if (link !== this.#link || url === null) return;
    this.#welcome = welcome;
    this.#state = { kind: "up", url };
    this.#streams = new RelayedStreams(this.#o.channel, link);
    this.#push.linkUp(link, welcome);
    this.#o.emit({ kind: "relayLink", state: "up", url, roles: welcome.roles });
    this.#releases.linkUp(link, welcome);
  }

  text(link: RelayLink, frame: RelayToHubFrame): void {
    if (link !== this.#link) return;
    switch (frame.t) {
      case "open":
        this.#streams?.opened(frame);
        return;
      case "close":
        this.#streams?.closedByRelay(frame.stream);
        return;
      case "rosterAck":
        this.#push.acked(frame.rev);
        return;
      case "pushResult":
        this.#push.results(frame.results);
        return;
      case "restartingAck":
        for (const done of [...this.#restartWaiters]) done();
        return;
      case "release.offer":
        this.#releases.offered(frame.releases);
        return;
      case "release.error":
        this.#releases.refused(frame.id, frame.reason, frame.retryAfterMs);
        return;
      case "limit":
      case "joined":
      case "pong":
        return;
    }
  }

  binary(link: RelayLink, frame: RelayBinaryFrame): void {
    if (link !== this.#link) return;
    if (frame.kind === RELAY_BINARY_KIND.streamData)
      this.#streams?.data(frame.stream, frame.message);
    else this.#releases.piece(frame.id, frame.bytes);
  }

  ended(link: RelayLink, end: LinkEnd): void {
    if (link !== this.#link) return;
    this.#link = undefined;
    this.#lost();
    const url = this.#url;
    if (url === null) return;
    this.#o.emit({ kind: "relayLink", state: "down", url, reason: end.reason });
    if (this.#stopped) return;
    const reaction = end.byHub ? "backoff" : relayCloseReconnect(end.code);
    if (reaction === "never") {
      this.#state = { kind: "refused", url };
      this.#o.report({
        kind: "link",
        origin: ORIGIN,
        message:
          "the relay refuses this hub's key (4403): no link until the setting changes or the hub restarts",
      });
      return;
    }
    let ms: number;
    if (reaction === "wait") {
      ms = waitAfterClose(end.code, end.limitRetryAfterMs);
      this.#backoff.reset();
    } else {
      if (end.wasUp && this.#backoff.lasted(end.upMs)) this.#backoff.reset();
      ms = this.#backoff.next(this.#draw());
    }
    this.#state = { kind: "waiting", url, ms };
    this.#retry = this.#o.timers.after(ms, () => {
      this.#retry = undefined;
      this.#open();
    });
  }

  /**
   * What rode on a link that is gone: every relayed connection closed, pushes and the roster
   * forgotten, fetches waiting, an announcement waited for no longer.
   */
  #lost(): void {
    this.#welcome = undefined;
    const streams = this.#streams;
    this.#streams = undefined;
    streams?.linkLost();
    this.#push.linkLost();
    this.#releases.linkLost();
    for (const done of [...this.#restartWaiters]) done();
  }

  /** A draw in [0, 1) for the jitter, from the secure generator; 0.5 (no jitter) if it fails. */
  #draw(): number {
    const bytes = this.#o.random(4);
    if (bytes.isErr()) return 0.5;
    const [a = 0, b = 0, c = 0, d = 0] = bytes.value;
    return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) / 0x1_0000_0000;
  }
}

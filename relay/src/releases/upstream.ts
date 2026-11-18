/**
 * A self-hosted relay's release cache (docs/m4-design.md sections 3 and 6): its releases role
 * serves from a folder it fills from the operated service, with the relay link's own frames,
 * `release.check` and `release.get`, so it needs no other connection (D84).
 *
 * When its channel comes up and every `RELEASES_RULES.refreshMs` after, it asks for the newest
 * release of each platform (`release.check {platform, running: "0.0.0"}`) and the newest firmware
 * (no `firmware`), and fetches every offered file its folder does not hold with that SHA-256: in
 * pieces of `RELAY_LIMITS.maxReleasePieceBytes`, one at a time, into `.partial-<file>` in the
 * folder, so a fetch cut by a dropped link or a restart resumes at the partial file's length. A
 * whole file whose SHA-256 is the offer's is moved into place and indexed; one that is not is
 * thrown away. A `limit` stops the fill until its `retryAfterMs`. Signatures are not checked here,
 * as the operated service does not: the hub checks them.
 *
 * `UpstreamChannel` is what carries the frames: the self-hosted relay's relay link to the push
 * service (B3's link, which passes them on to the operated releases role), or, on one host, the
 * forwarding socket itself (`socketChannel`).
 */
import { join } from "node:path";
import { RELEASE_PLATFORMS } from "@hsn/protocol/release";
import {
  decodeTextFrame,
  encodeTextFrame,
  RELAY_BINARY_KIND,
  RELAY_LIMITS,
  relayBinaryCodec,
  type ReleaseOffer,
  type RelayToPushFrame,
} from "@hsn/protocol/relay";
import { type Result } from "neverthrow";
import { RELEASES_RULES } from "../core/rules.ts";
import type { RelayClock } from "../shell/clock.ts";
import type { RelayError } from "../shell/errors.ts";
import type { RelayLog } from "../shell/log.ts";
import type { FolderReleaseIndex } from "./folder-index.ts";
import { ReleaseForwarder } from "./forwarding.ts";
import { remove, rename, sha256FileInPieces, sizeOrZero, truncate, writeAt } from "./safe/fs.ts";

/** A release frame the cache sends upstream. */
export type UpstreamRequest = Extract<RelayToPushFrame, { t: "release.check" | "release.get" }>;

/** What comes back. */
export type UpstreamAnswer =
  | { readonly kind: "offer"; readonly releases: readonly ReleaseOffer[] }
  | {
      readonly kind: "error";
      readonly id: number;
      readonly reason: string;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: "piece"; readonly id: number; readonly bytes: Uint8Array };

/** The way to the operated releases role. */
export interface UpstreamChannel {
  /** Sends one frame; false when the channel is down. */
  send(frame: UpstreamRequest): boolean;
}

/** Reads one answer as the relay link carries it: a text frame or a binary piece. */
export function readUpstreamAnswer(data: string | Uint8Array): UpstreamAnswer | undefined {
  if (typeof data !== "string") {
    const piece = relayBinaryCodec.decode(data);
    return piece.ok && piece.value.kind === RELAY_BINARY_KIND.releasePiece
      ? { kind: "piece", id: piece.value.id, bytes: piece.value.bytes }
      : undefined;
  }
  const frame = decodeTextFrame("pushToRelay", data);
  if (!frame.ok) return undefined;
  if (frame.value.t === "release.offer") return { kind: "offer", releases: frame.value.releases };
  if (frame.value.t === "release.error") {
    const { id, reason, retryAfterMs } = frame.value;
    return retryAfterMs === undefined
      ? { kind: "error", id, reason }
      : { kind: "error", id, reason, retryAfterMs };
  }
  return undefined;
}

type Waiting =
  | {
      readonly kind: "offer";
      readonly done: (releases: readonly ReleaseOffer[] | undefined) => void;
    }
  | {
      readonly kind: "piece";
      readonly id: number;
      readonly done: (answer: UpstreamAnswer | undefined) => void;
    };

export interface UpstreamOptions {
  readonly index: FolderReleaseIndex;
  readonly clock: RelayClock;
  readonly log: RelayLog;
  readonly channel: UpstreamChannel;
}

export class UpstreamCache {
  private waiting: Waiting[] = [];
  private nextId = 1;
  private filling = false;
  private holdUntilMs = 0;
  private cancelTimer: () => void = () => undefined;
  private stopped = false;

  constructor(private readonly options: UpstreamOptions) {}

  /** Fills now, and every `RELEASES_RULES.refreshMs` after. */
  start(): void {
    void this.fill();
    this.cancelTimer = this.options.clock.after(RELEASES_RULES.refreshMs, () => {
      if (!this.stopped) this.start();
    });
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer();
    this.linkDown();
  }

  /** The channel went down: everything waiting fails, and the next fill resumes. */
  linkDown(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const w of waiting) w.done(undefined);
  }

  /** An answer from upstream. */
  answer(answer: UpstreamAnswer): void {
    if (answer.kind === "offer") {
      const at = this.waiting.findIndex((w) => w.kind === "offer");
      const w = this.waiting[at];
      if (w?.kind !== "offer") return;
      this.waiting.splice(at, 1);
      w.done(answer.releases);
      return;
    }
    const at = this.waiting.findIndex((w) => w.kind === "piece" && w.id === answer.id);
    const w = this.waiting[at];
    if (w?.kind !== "piece") return;
    this.waiting.splice(at, 1);
    w.done(answer);
  }

  private ask(
    frame: UpstreamRequest,
  ): Promise<UpstreamAnswer | readonly ReleaseOffer[] | undefined> {
    return new Promise((resolve) => {
      if (frame.t === "release.check") this.waiting.push({ kind: "offer", done: resolve });
      else this.waiting.push({ kind: "piece", id: frame.id, done: resolve });
      if (!this.options.channel.send(frame)) this.linkDown();
    });
  }

  /** One fill: what was fetched, or nothing while a `limit` lasts or a fill runs. */
  async fill(): Promise<number> {
    if (this.filling || this.options.clock.now() < this.holdUntilMs) return 0;
    this.filling = true;
    let fetched = 0;
    const offers = new Map<string, ReleaseOffer>();
    for (const platform of RELEASE_PLATFORMS) {
      const answer = await this.ask({ t: "release.check", platform, running: "0.0.0" });
      if (answer === undefined || !Array.isArray(answer)) break;
      for (const offer of answer as readonly ReleaseOffer[]) offers.set(offer.file, offer);
    }
    for (const offer of offers.values()) {
      const held = this.options.index.find(offer.file);
      if (held?.sha256 === offer.sha256) continue;
      const result = await this.fetch(offer);
      if (result === "fetched") fetched += 1;
      if (result === "stop") break;
    }
    if (fetched > 0) {
      const refreshed = await this.options.index.refresh();
      if (refreshed.isErr()) this.options.log.write("warning", "upstream", { why: "failed" });
    }
    this.options.log.write("info", "upstream", { offered: offers.size, fetched });
    this.filling = false;
    return fetched;
  }

  private async fetch(offer: ReleaseOffer): Promise<"fetched" | "failed" | "stop"> {
    const folder = this.options.index.folder;
    const partial = join(folder, `.partial-${offer.file}`);
    let offset = sizeOrZero(partial);
    if (offset > offer.bytes) {
      remove(partial).unwrapOr(undefined);
      offset = 0;
    }
    while (offset < offer.bytes) {
      const length = Math.min(RELAY_LIMITS.maxReleasePieceBytes, offer.bytes - offset);
      const id = this.nextId;
      this.nextId = (this.nextId % RELAY_LIMITS.maxStream) + 1;
      const answer = await this.ask({ t: "release.get", id, file: offer.file, offset, length });
      if (answer === undefined || Array.isArray(answer)) return "stop";
      const a = answer as UpstreamAnswer;
      if (a.kind === "error") {
        if (a.reason === "limit") {
          this.holdUntilMs =
            this.options.clock.now() + (a.retryAfterMs ?? RELAY_LIMITS.limitWaitMs);
          this.options.log.write("warning", "upstream", { why: "limit" });
          return "stop";
        }
        this.options.log.write("warning", "upstream", { why: "failed" });
        return "failed";
      }
      if (a.kind !== "piece" || a.bytes.length !== length) return "stop";
      const written: Result<void, RelayError> = writeAt(partial, offset, a.bytes);
      if (written.isErr()) {
        this.options.log.write("error", "upstream", {}, written.error);
        truncate(partial, offset).unwrapOr(undefined);
        return "stop";
      }
      offset += length;
    }
    const hash = await sha256FileInPieces(partial, RELAY_LIMITS.maxReleasePieceBytes);
    if (hash.isErr() || hash.value !== offer.sha256) {
      this.options.log.write("warning", "upstream", { why: "failed" });
      remove(partial).unwrapOr(undefined);
      return "failed";
    }
    const moved = rename(partial, join(folder, offer.file));
    if (moved.isErr()) {
      this.options.log.write("error", "upstream", {}, moved.error);
      return "failed";
    }
    this.options.log.write("info", "upstream", { why: "fetched", bytes: offer.bytes });
    return "fetched";
  }
}

/** A channel over the forwarding socket, with the cache its answers go to. */
export interface SocketChannel extends UpstreamChannel {
  /** The cache the answers go to; answers before it is set are dropped. */
  attach(cache: UpstreamCache): void;
  close(): void;
}

/**
 * A channel over the forwarding socket (`forwarding.ts`) on one host: the relay's own key's
 * identity names it, as the push process names a joined relay link's.
 */
export function socketChannel(
  socketPath: string,
  identity: string,
): Result<SocketChannel, RelayError> {
  let cache: UpstreamCache | undefined;
  return ReleaseForwarder.open(
    socketPath,
    { identity, address: null },
    (data) => {
      const answer = readUpstreamAnswer(data);
      if (answer !== undefined) cache?.answer(answer);
    },
    () => {
      cache?.linkDown();
    },
  ).map((forwarder) => ({
    attach(to: UpstreamCache): void {
      cache = to;
    },
    send(frame: UpstreamRequest): boolean {
      const text = encodeTextFrame("relayToPush", frame);
      if (!text.ok) return false;
      void forwarder.forward(text.value).then((sent) => {
        if (!sent) cache?.linkDown();
      });
      return true;
    },
    close() {
      forwarder.close();
    },
  }));
}

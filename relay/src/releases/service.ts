/**
 * The releases role's answers (docs/m4-design.md section 6; D142's "Releases" row): `release.check`
 * and `release.get`, on authenticated links only, in pieces of at most
 * `RELAY_LIMITS.maxReleasePieceBytes`, at any offset (so a fetch resumes where it stopped), within
 * the per-identity, per-address, per-relay-key and daily budgets (`core/release-budget.ts`).
 *
 * Only a joined hub link or a relay link ever reaches this: the callers are the hub link's frame
 * handler after message 3 and the forwarding socket the push process opens per joined relay link
 * (`forwarding.ts`). Nothing here reads a frame from an unauthenticated peer.
 *
 * A `release.get` is answered, in this order: `notFound` (no such file in the index), `range`
 * (`offset + length` past the file), `limit` with `retryAfterMs` until midnight UTC (a budget
 * spent), `unavailable` (the file could not be read); otherwise exactly `length` bytes.
 */
import type { ReleaseCheck, ReleaseOffer } from "@hsn/protocol/relay";
import { type ReleaseBudget, type ReleasePeer } from "../core/release-budget.ts";
import type { RelayClock } from "../shell/clock.ts";
import type { RelayLog } from "../shell/log.ts";
import type { FolderReleaseIndex } from "./folder-index.ts";

/** A `release.get`'s fields. */
export interface PieceRequest {
  readonly id: number;
  readonly file: string;
  readonly offset: number;
  readonly length: number;
}

/** What a `release.get` is answered with. */
export type PieceAnswer =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly reason: "notFound" | "range" | "limit" | "unavailable";
      readonly retryAfterMs?: number;
    };

/** A `release.check` frame's body. */
export function checkOf(frame: ReleaseCheck & { readonly t: "release.check" }): ReleaseCheck {
  return frame.firmware === undefined
    ? { platform: frame.platform, running: frame.running }
    : { platform: frame.platform, running: frame.running, firmware: frame.firmware };
}

/** A `release.get` frame's body. */
export function requestOf(frame: PieceRequest & { readonly t: "release.get" }): PieceRequest {
  return { id: frame.id, file: frame.file, offset: frame.offset, length: frame.length };
}

/** What the relay's links ask of the releases role. */
export interface ReleaseAnswers {
  check(peer: ReleasePeer, check: ReleaseCheck): readonly ReleaseOffer[];
  get(peer: ReleasePeer, request: PieceRequest): Promise<PieceAnswer>;
}

export class ReleaseService implements ReleaseAnswers {
  constructor(
    readonly index: FolderReleaseIndex,
    private readonly budget: ReleaseBudget,
    private readonly clock: RelayClock,
    private readonly log: RelayLog,
  ) {}

  check(_peer: ReleasePeer, check: ReleaseCheck): readonly ReleaseOffer[] {
    return this.index.offer(check);
  }

  async get(peer: ReleasePeer, request: PieceRequest): Promise<PieceAnswer> {
    const entry = this.index.find(request.file);
    if (entry === undefined) return this.refuse("notFound");
    if (request.offset + request.length > entry.bytes) return this.refuse("range");
    const admitted = this.budget.admit(
      peer,
      entry.file,
      entry.bytes,
      request.length,
      this.clock.now(),
    );
    if (!admitted.ok) {
      this.log.write("warning", "releaseRefused", { why: "limit", link: peer.kind });
      return { ok: false, reason: "limit", retryAfterMs: admitted.retryAfterMs };
    }
    const read = await this.index.read(request.file, request.offset, request.length);
    return read.match(
      (bytes): PieceAnswer => ({ ok: true, bytes }),
      (error): PieceAnswer => this.refuse(error.kind),
    );
  }

  private refuse(reason: "notFound" | "range" | "unavailable"): PieceAnswer {
    this.log.write("warning", "releaseRefused", { why: reason });
    return { ok: false, reason };
  }
}

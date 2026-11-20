/**
 * Signed releases over the relay link (docs/m4-design.md section 6; D84, D129): one transport for
 * both kinds of file, `release.check` and `release.get`.
 *
 * - **Checking.** When the link comes up, and every 24 hours ‡ while it stays up, the hub sends
 *   `release.check {platform, running, firmware?}` (the newest firmware in its store, when it holds
 *   one); the relay's `release.offer` goes to the core as `releaseOffered`, as it is. A computer
 *   whose platform no release is made for sends no check.
 * - **Fetching, only when asked** (`fileJob {fetchRelease}`): the file is checked against its
 *   kind's cap before any byte is asked for (a hub release at most M2's 256 MB, a firmware file at
 *   most 8 MB: `tooLarge`), then fetched in pieces of 256 KiB ‡ (or the relay's smaller bound), at
 *   most 4 in flight ‡, into the upload store as an upload of the relay link's own connection,
 *   hashed as it goes. The loop takes one piece a turn, within its limit (m2-design.md section 3):
 *   each `next()` writes and hashes at most one piece. While nothing has come it says it is
 *   waiting, so the loop does not turn for it; a piece's arrival asks for a turn.
 * - **Cut and resumed.** A link that drops during a fetch is waited for up to 10 minutes ‡; the
 *   fetch continues at the first byte it does not hold, so a resumed fetch re-fetches only the
 *   pieces in flight when the link dropped (the relay's budget counts fetched bytes). Then it fails
 *   `unreachable`. A fetch started while the link is down waits the same way.
 * - **Refused by the relay** (`release.error`): `limit` (its budget, with when to retry),
 *   `notFound` and `unavailable` fail the job `unreachable`; `range` fails it `badFile`. A piece
 *   whose length is not the one asked for fails it `badFile`.
 * - **Then the staging an upload gets**: once the whole is in and is the offer's length and
 *   SHA-256 (else `badFile`), a hub release runs M2's two staging passes exactly as `update.upload`
 *   does, ending `updateStaged` or M2's refusals (`stageUpdate`), and a firmware release the updates
 *   design's `stageFirmware` (`own: null`). The fetched file is freed when the job ends, however.
 */
import { RELAY_LIMITS, type RelayWelcome } from "@hsn/protocol/relay";
import type { ReleasePlatform } from "@hsn/protocol/release";
import type { FileWork, UploadRef } from "../../core/model/effects.ts";
import type { HubEvent, FileOutcome, FileFailure } from "../../core/model/events.ts";
import type { ConnId, JobId } from "../../core/model/ids.ts";
import type { FirmwareImageRow } from "../../core/model/rows.ts";
import type { HubState } from "../../core/model/state.ts";
import { newerVersion } from "../../core/upkeep/update.ts";
import { upkeepSlice } from "../../core/upkeep/view.ts";
import type { FetchedFile, UploadStore } from "../app/uploads.ts";
import type { Timers } from "../app/channel.ts";
import type { JobPieces, JobStarted } from "../loop.ts";
import type { RelayLink } from "./link.ts";

type FetchRelease = Extract<FileWork, { readonly kind: "fetchRelease" }>;

/** The largest file of each kind fetched; larger offers are refused before any byte (section 6). */
export const RELEASE_CAPS = {
  hub: RELAY_LIMITS.maxHubReleaseBytes,
  firmware: RELAY_LIMITS.maxFirmwareReleaseBytes,
} as const;

export interface ReleaseOptions {
  /** The platform of this computer's hub releases; undefined when none is made for it. */
  readonly platform: ReleasePlatform | undefined;
  /** The version the hub runs. */
  readonly running: string;
  /** The newest firmware image in the store, as `MAJOR.MINOR.PATCH`; undefined when none. */
  readonly firmware: () => string | undefined;
  readonly uploads: Pick<UploadStore, "beginFetch" | "release">;
  /** The relay link's own connection: fetched files are its uploads. */
  readonly conn: ConnId;
  /** Whether the hub still wants this job to fetch or stage its release. */
  readonly wanted: (job: JobId, release: FetchRelease["release"]) => boolean;
  /** The staging a fetched file then gets: `stageUpdate` or `stageFirmware`, through the file jobs. */
  readonly stage: (job: JobId, work: FileWork) => JobStarted;
  readonly emit: (event: HubEvent) => void;
  /** Asks the loop for a turn: a fetch has work. */
  readonly wake: () => void;
  readonly timers: Timers;
}

/** The newest image a store holds, as `MAJOR.MINOR.PATCH` (`devices.firmware`'s number). */
export function newestFirmware(images: Iterable<FirmwareImageRow>): string | undefined {
  let newest: number | undefined;
  for (const image of images) {
    if (image.removedMs !== null) continue;
    if (newest === undefined || image.version > newest) newest = image.version;
  }
  if (newest === undefined) return undefined;
  return `${String(Math.floor(newest / 65_536))}.${String(Math.floor(newest / 256) % 256)}.${String(newest % 256)}`;
}

/** The staging a fetched release gets: an upload's. */
export function stagingOf(release: FetchRelease["release"], upload: UploadRef): FileWork {
  return release === "hub"
    ? { kind: "stageUpdate", upload }
    : { kind: "stageFirmware", upload, own: null };
}

/** A requested hub release stays wanted while its staging job is current and no newer offer has replaced it. */
export function hubReleaseWanted(state: HubState, job: JobId): boolean {
  const { staging, offer } = upkeepSlice(state);
  return (
    staging?.source === "fetch" &&
    staging.job === job &&
    (offer === undefined || !newerVersion(offer.version, staging.version))
  );
}

function failed(reason: FileFailure, message: string): FileOutcome {
  return { kind: "failed", reason, message };
}

const UNWANTED = failed("io", "the release fetch is no longer wanted");

export class RelayReleases {
  readonly #o: ReleaseOptions;
  #link: RelayLink | undefined;
  #pieceBytes: number = RELAY_LIMITS.maxReleasePieceBytes;
  #checkTimer: (() => void) | undefined;
  readonly #fetches = new Set<ReleaseFetch>();
  /** Null holds a slot for a request already sent by a fetch that ended. */
  readonly #byRequest = new Map<number, ReleaseFetch | null>();
  #nextRequest = 1;

  constructor(options: ReleaseOptions) {
    this.#o = options;
  }

  /** Fetches running. */
  get fetching(): number {
    return this.#fetches.size;
  }

  linkUp(link: RelayLink, welcome: RelayWelcome): void {
    this.#link = link;
    this.#pieceBytes = Math.min(
      welcome.limits.maxReleasePieceBytes,
      RELAY_LIMITS.maxReleasePieceBytes,
    );
    this.check();
    for (const fetch of this.#fetches) fetch.linkUp();
  }

  linkLost(): void {
    this.#link = undefined;
    this.#checkTimer?.();
    this.#checkTimer = undefined;
    this.#byRequest.clear();
    for (const fetch of this.#fetches) fetch.linkLost();
  }

  /** `release.check` now, and again in 24 hours ‡ while the link stays up. */
  check(): void {
    this.#checkTimer?.();
    this.#checkTimer = undefined;
    const link = this.#link;
    const platform = this.#o.platform;
    if (link?.up !== true || platform === undefined) return;
    const firmware = this.#o.firmware();
    link
      .sendText({
        t: "release.check",
        platform,
        running: this.#o.running,
        ...(firmware === undefined ? {} : { firmware }),
      })
      .match(
        () => undefined,
        () => undefined,
      );
    this.#checkTimer = this.#o.timers.after(RELAY_LIMITS.releaseCheckEveryMs, () => {
      this.#checkTimer = undefined;
      this.check();
    });
  }

  /** The relay's `release.offer`. */
  offered(releases: Extract<HubEvent, { readonly kind: "releaseOffered" }>["releases"]): void {
    this.#o.emit({ kind: "releaseOffered", releases });
  }

  /** A kind 2 frame: the bytes of request `id`. */
  piece(id: number, bytes: Uint8Array): void {
    this.#answered(id)?.piece(id, bytes);
  }

  /** The relay's `release.error`. */
  refused(
    id: number,
    reason: "notFound" | "range" | "limit" | "unavailable",
    retryAfterMs?: number,
  ): void {
    this.#answered(id)?.refused(reason, retryAfterMs);
  }

  /** `fileJob {fetchRelease}`: refused at once over the cap, else a fetch in pieces. */
  start(job: JobId, work: FetchRelease): JobStarted {
    if (!this.#o.wanted(job, work.release)) return { kind: "ready", outcome: UNWANTED };
    const cap = RELEASE_CAPS[work.release];
    if (work.bytes > cap)
      return {
        kind: "ready",
        outcome: failed(
          "tooLarge",
          `${String(work.bytes)} bytes, over the ${String(cap)} a ${work.release} release may have`,
        ),
      };
    const upload: UploadRef = { conn: this.#o.conn, job };
    const file = this.#o.uploads.beginFetch(upload);
    if (file.isErr()) return { kind: "ready", outcome: failed("io", file.error.message) };
    const fetch = new ReleaseFetch(this, job, work, upload, file.value);
    this.#fetches.add(fetch);
    if (this.#link?.up === true) fetch.linkUp();
    else fetch.linkLost();
    return { kind: "pieces", pieces: fetch };
  }

  stop(): void {
    for (const fetch of this.#fetches) fetch.abort();
    this.linkLost();
  }

  // ----- For the fetches -----

  get options(): ReleaseOptions {
    return this.#o;
  }

  get pieceBytes(): number {
    return this.#pieceBytes;
  }

  /** Asks for a piece when the link has room in its shared in-flight window. */
  request(fetch: ReleaseFetch, file: string, offset: number, length: number): number | undefined {
    const link = this.#link;
    if (link?.up !== true || this.#byRequest.size >= RELAY_LIMITS.maxReleasePiecesInFlight)
      return undefined;
    const id = this.#nextRequest;
    this.#nextRequest = this.#nextRequest >= 0xffff_ffff ? 1 : this.#nextRequest + 1;
    const sent = link.sendText({ t: "release.get", id, file, offset, length });
    if (sent.isErr()) return undefined;
    this.#byRequest.set(id, fetch);
    return id;
  }

  ended(fetch: ReleaseFetch): void {
    this.#fetches.delete(fetch);
    for (const [id, owner] of this.#byRequest) if (owner === fetch) this.#byRequest.set(id, null);
  }

  /** Discards late answers and wakes jobs that can use the slot they free. */
  #answered(id: number): ReleaseFetch | undefined {
    const fetch = this.#byRequest.get(id);
    this.#byRequest.delete(id);
    if (fetch === null && this.#fetches.size > 0) this.#o.wake();
    return fetch ?? undefined;
  }
}

type Phase = "fetching" | "staging" | "over";

/** One release fetched, then staged: the loop's pieces. */
export class ReleaseFetch implements JobPieces {
  readonly #owner: RelayReleases;
  readonly #job: JobId;
  readonly #work: FetchRelease;
  readonly #upload: UploadRef;
  readonly #file: FetchedFile;
  #phase: Phase = "fetching";
  /** The first byte not yet asked for. */
  #nextOffset = 0;
  readonly #inFlight = new Map<number, { readonly offset: number; readonly length: number }>();
  /** Pieces in, by offset, not yet written. */
  readonly #received = new Map<number, Uint8Array>();
  #failure: FileOutcome | undefined;
  #waitTimer: (() => void) | undefined;
  #staging: JobPieces | undefined;

  constructor(
    owner: RelayReleases,
    job: JobId,
    work: FetchRelease,
    upload: UploadRef,
    file: FetchedFile,
  ) {
    this.#owner = owner;
    this.#job = job;
    this.#work = work;
    this.#upload = upload;
    this.#file = file;
  }

  /** Bytes written and hashed so far. */
  get written(): number {
    return this.#file.bytes();
  }

  /** Requests in flight. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /**
   * Nothing to do until a piece, a refusal or the link comes, or, once fetched, until the staging's
   * worker has ended (`shell/update/stage-job.ts`): the loop need not turn for it.
   */
  waiting(): boolean {
    if (this.#phase === "staging") return this.#staging?.waiting?.() === true;
    if (this.#phase !== "fetching" || this.#failure !== undefined || !this.#wanted()) return false;
    return !this.#received.has(this.written) && this.written < this.#work.bytes;
  }

  next(): { readonly done: false } | { readonly done: true; readonly outcome: FileOutcome } {
    if (this.#phase === "over") return { done: true, outcome: failed("io", "the fetch is over") };
    if (this.#phase === "staging") {
      // A cancel reaches the staging's worker without the loop waiting for it, and the staging
      // removes what it wrote (`shell/update/stage-job.ts`); the fetch, and the fetched file the
      // worker reads, end only with the staging.
      const staged = this.#staging?.next() ?? { done: true, outcome: failed("io", "no staging") };
      if (!staged.done) return staged;
      return this.#end(this.#wanted() ? staged.outcome : UNWANTED);
    }
    if (!this.#wanted()) {
      this.abort();
      return { done: true, outcome: UNWANTED };
    }
    if (this.#failure !== undefined) return this.#end(this.#failure);
    const at = this.written;
    const piece = this.#received.get(at);
    if (piece !== undefined) {
      this.#received.delete(at);
      const appended = this.#file.append(piece);
      if (appended.isErr()) return this.#end(failed("io", appended.error.message));
    }
    if (this.written >= this.#work.bytes) return this.#whole();
    this.#ask();
    return { done: false };
  }

  abort(): void {
    if (this.#phase === "over") return;
    this.#staging?.abort();
    this.#finish();
  }

  // ----- From the link -----

  linkUp(): void {
    this.#waitTimer?.();
    this.#waitTimer = undefined;
    this.#ask();
    this.#owner.options.wake();
  }

  /** The link is down: ask again later from the first byte not held, for up to 10 minutes ‡. */
  linkLost(): void {
    this.#inFlight.clear();
    let held = this.written;
    for (
      let piece = this.#received.get(held);
      piece !== undefined;
      piece = this.#received.get(held)
    )
      held += piece.length;
    for (const offset of [...this.#received.keys()])
      if (offset >= held) this.#received.delete(offset);
    this.#nextOffset = held;
    if (this.#waitTimer !== undefined || this.#phase !== "fetching") return;
    this.#waitTimer = this.#owner.options.timers.after(RELAY_LIMITS.fetchResumeWaitMs, () => {
      this.#waitTimer = undefined;
      this.#fail(failed("unreachable", "the relay link did not come back within 10 minutes"));
    });
  }

  piece(id: number, bytes: Uint8Array): void {
    const asked = this.#inFlight.get(id);
    if (asked === undefined || this.#phase !== "fetching") return;
    this.#inFlight.delete(id);
    if (bytes.length !== asked.length) {
      this.#fail(
        failed(
          "badFile",
          `the relay sent ${String(bytes.length)} bytes for a piece of ${String(asked.length)}`,
        ),
      );
      return;
    }
    this.#received.set(asked.offset, bytes);
    this.#owner.options.wake();
  }

  refused(reason: "notFound" | "range" | "limit" | "unavailable", retryAfterMs?: number): void {
    if (this.#phase !== "fetching") return;
    const retry = retryAfterMs === undefined ? "" : `, retry after ${String(retryAfterMs)} ms`;
    const why = {
      notFound: "the relay no longer offers the file",
      range: "the relay refused the range asked for",
      limit: "over the relay's release budget",
      unavailable: "the relay cannot serve releases now",
    }[reason];
    this.#fail(failed(reason === "range" ? "badFile" : "unreachable", `${why}${retry}`));
  }

  // ----- Inside -----

  /**
   * Asks for the next pieces: at most 4 ‡ asked for or held unwritten at once, so a fetch holds at
   * most 1 MiB in memory whatever order the pieces come in.
   */
  #ask(): void {
    if (this.#phase !== "fetching" || this.#failure !== undefined || !this.#wanted()) return;
    while (
      this.#inFlight.size + this.#received.size < RELAY_LIMITS.maxReleasePiecesInFlight &&
      this.#nextOffset < this.#work.bytes
    ) {
      const length = Math.min(this.#owner.pieceBytes, this.#work.bytes - this.#nextOffset);
      const id = this.#owner.request(this, this.#work.file, this.#nextOffset, length);
      if (id === undefined) return;
      this.#inFlight.set(id, { offset: this.#nextOffset, length });
      this.#nextOffset += length;
    }
  }

  /** Rechecks the job at each piece and before taking the staging turn. */
  #wanted(): boolean {
    return this.#owner.options.wanted(this.#job, this.#work.release);
  }

  /** Every byte is in: checked against the offer, then the staging an upload gets. */
  #whole(): { readonly done: false } | { readonly done: true; readonly outcome: FileOutcome } {
    this.#waitTimer?.();
    this.#waitTimer = undefined;
    if (!this.#file.finish(this.#work.bytes, this.#work.sha256))
      return this.#end(failed("badFile", "the fetched file is not the one offered"));
    this.#phase = "staging";
    const started = this.#owner.options.stage(
      this.#job,
      stagingOf(this.#work.release, this.#upload),
    );
    if (started.kind === "ready") return this.#end(started.outcome);
    if (started.kind !== "pieces") return this.#end(failed("io", "a staging that switches"));
    this.#staging = started.pieces;
    return { done: false };
  }

  #fail(outcome: FileOutcome): void {
    if (this.#failure !== undefined || this.#phase !== "fetching") return;
    this.#failure = outcome;
    this.#owner.options.wake();
  }

  #end(outcome: FileOutcome): { readonly done: true; readonly outcome: FileOutcome } {
    this.#finish();
    return { done: true, outcome };
  }

  /** Whatever the end: no timer, no request, and the fetched file freed. */
  #finish(): void {
    this.#phase = "over";
    this.#waitTimer?.();
    this.#waitTimer = undefined;
    this.#inFlight.clear();
    this.#received.clear();
    this.#owner.options.uploads.release(this.#upload);
    this.#owner.ended(this);
  }
}

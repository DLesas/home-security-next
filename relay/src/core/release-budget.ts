/**
 * The releases row of D142's layer 1 (docs/m4-design.md section 3; "bandwidth costs money"), with
 * `PROTECTION_LIMITS.releases`' values. Pure: time is an input. Every "day" is the UTC day; a
 * refusal says how long until midnight UTC, which `release.error {reason: "limit"}` carries.
 *
 * Pieces are counted, not requests, so a download resumed at any offset costs what it fetches:
 *
 * | Budget | Counted as | A piece passes while |
 * | --- | --- | --- |
 * | 3 downloads per file per identity per day | bytes of that file to that identity | bytes + length ≤ 3 × the file's length |
 * | 3 whole files per address per day, whatever the identity | millionths of a file, each piece ⌊length × 10⁶ ÷ file length⌋ | used + cost ≤ 3 × 10⁶ |
 * | 10 files per relay key per day (relay links only) | millionths of a file, as above | used + cost ≤ 10 × 10⁶ |
 * | The daily egress budget for the service | bytes | bytes + length ≤ 100 GB |
 *
 * A piece passes only if every budget it is counted in has room, and then is counted in all.
 * The operator's local socket (no address) is counted per identity and in all only.
 */
import { DayBudget, type Take } from "./rate.ts";
import { PROTECTION_LIMITS } from "./rules.ts";

const R = PROTECTION_LIMITS.releases;
/** A whole file, in the unit the per-address and per-relay-key budgets count. */
export const WHOLE_FILE = 1_000_000;
const ALL = "*";

/** Who asks: a hub on its link, or a relay on its relay link (D142). */
export interface ReleasePeer {
  readonly kind: "hub" | "relay";
  /** The identity its key proved. */
  readonly identity: string;
  /** Its address key; null on the operator's local socket. */
  readonly address: string | null;
}

/** What a piece of `length` bytes of a file of `fileBytes` costs in millionths of a file. */
export function pieceCost(length: number, fileBytes: number): number {
  return Math.floor((length * WHOLE_FILE) / fileBytes);
}

export class ReleaseBudget {
  private readonly perIdentityFile: DayBudget;
  private readonly perAddress: DayBudget;
  private readonly perRelayKey: DayBudget;
  private readonly egress = new DayBudget(1);

  constructor(
    maxKeys: number = PROTECTION_LIMITS.memory.rateTableAddresses,
    readonly dailyEgressBytes: number = R.dailyEgressBytes,
  ) {
    this.perIdentityFile = new DayBudget(maxKeys);
    this.perAddress = new DayBudget(maxKeys);
    this.perRelayKey = new DayBudget(maxKeys);
  }

  /** Whether `peer` may have `length` bytes of `file` (`fileBytes` long) at `nowMs`; counted if so. */
  admit(peer: ReleasePeer, file: string, fileBytes: number, length: number, nowMs: number): Take {
    const cost = pieceCost(length, fileBytes);
    const checks: (() => Take)[] = [
      () =>
        this.perIdentityFile.check(
          `${peer.identity}/${file}`,
          nowMs,
          length,
          R.downloadsPerFilePerIdentityPerDay * fileBytes,
        ),
      () =>
        peer.address === null
          ? { ok: true }
          : this.perAddress.check(
              peer.address,
              nowMs,
              cost,
              R.wholeFilesPerAddressPerDay * WHOLE_FILE,
            ),
      () =>
        peer.kind === "relay"
          ? this.perRelayKey.check(
              peer.identity,
              nowMs,
              cost,
              R.filesPerRelayKeyPerDay * WHOLE_FILE,
            )
          : { ok: true },
      () => this.egress.check(ALL, nowMs, length, this.dailyEgressBytes),
    ];
    for (const check of checks) {
      const answer = check();
      if (!answer.ok) return answer;
    }
    this.perIdentityFile.take(`${peer.identity}/${file}`, nowMs, length, Infinity);
    if (peer.address !== null) this.perAddress.take(peer.address, nowMs, cost, Infinity);
    if (peer.kind === "relay") this.perRelayKey.take(peer.identity, nowMs, cost, Infinity);
    this.egress.take(ALL, nowMs, length, Infinity);
    return { ok: true };
  }

  /** Bytes served today in all. */
  egressToday(nowMs: number): number {
    return this.egress.used(ALL, nowMs);
  }
}

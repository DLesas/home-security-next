/**
 * D142's layer 1 for the relay role's links (docs/m4-design.md section 3, "Protecting what the
 * operator runs"): who may open a hub link or a phone stream, counted by address before any state
 * is kept, and the caps after. Pure: time is an input, nothing here does input or output; the
 * shell asks, and answers as each row says. Every value is `PROTECTION_LIMITS`'.
 *
 * | Row | Value | Answer |
 * | --- | --- | --- |
 * | Hub link upgrades per address | 10 a minute | HTTP 429, before the upgrade: nothing kept |
 * | Link handshakes in all | 500 a second | HTTP 503, before the upgrade |
 * | Phone stream opens per address | 30 a minute | HTTP 429, before the upgrade |
 * | Unauthenticated hub links | 4 per address, 2,000 in all | closed with 4429 at once, before any Noise state |
 * | Authenticated hub links | 8 per address, 20,000 in all | 4429 after message 3; an established link is never closed to make room, and a link replacing its own identity's adds nothing |
 * | Phone streams | 16 per hub, 8 open per address, 40,000 in all | 4429 |
 * | New hub identities | 3 a day per address, 500 an hour in all, 200,000 stored | `limit {what: "newIdentity"}`, then 4429; at the stored cap the operator is alerted and the hub waits `RELAY_LIMITS.limitWaitMs` |
 * | Traffic | 500 MB of stream bytes per hub per UTC day | new streams 4429 until midnight UTC |
 *
 * The rate tables hold at most `memory.rateTableAddresses` keys each (`rate.ts`).
 */
import { RELAY_LIMITS } from "@hsn/protocol/relay";
import { DayBudget, OpenCounts, SlidingRate, type Take } from "./rate.ts";
import { PROTECTION_LIMITS } from "./rules.ts";
import { TIME } from "./time.ts";

const L = PROTECTION_LIMITS;
/** Every link handshake in all is counted under one key. */
const ALL = "*";

/** Before an upgrade: let it through, or HTTP 429 (`rate`) or 503 (`busy`). */
export type UpgradeAnswer = "ok" | "rate" | "busy";

/** After message 3: join, or why not. */
export type JoinAnswer =
  | { readonly kind: "ok" }
  | { readonly kind: "full" }
  | { readonly kind: "newIdentity"; readonly retryAfterMs: number; readonly stored: boolean };

/** A phone stream, after its upgrade: open, or why not. */
export type StreamAnswer = "ok" | "perHub" | "perAddress" | "inAll" | "traffic";

export class Admission {
  private readonly hubUpgrades = new SlidingRate(
    L.beforeState.hubAndRelayUpgradesPerMinutePerAddress,
    TIME.MINUTE,
    L.memory.rateTableAddresses,
  );
  private readonly phoneOpens = new SlidingRate(
    L.beforeState.phoneOpensPerMinutePerAddress,
    TIME.MINUTE,
    L.memory.rateTableAddresses,
  );
  private readonly handshakes = new SlidingRate(
    L.beforeState.handshakesPerSecondInAll,
    TIME.SECOND,
    1,
  );
  private readonly newPerAddress = new DayBudget(L.memory.rateTableAddresses);
  private readonly newInAll = new SlidingRate(L.newIdentities.perHourInAll, TIME.HOUR, 1);
  private readonly traffic = new DayBudget(L.memory.rateTableAddresses);
  private readonly unauthenticated = new OpenCounts();
  private readonly authenticated = new OpenCounts();
  private readonly streamsPerHub = new OpenCounts();
  private readonly streamsPerAddress = new OpenCounts();

  // ----- Hub links -----

  /** An HTTP upgrade to `/v1/hub` from `address`: counted before anything is kept. */
  hubUpgrade(address: string, nowMs: number): UpgradeAnswer {
    if (!this.hubUpgrades.take(address, nowMs).ok) return "rate";
    if (!this.handshakes.take(ALL, nowMs).ok) return "busy";
    return "ok";
  }

  /** The upgraded socket: may it start a handshake? False: close with 4429, keeping nothing. */
  handshakeStarts(address: string): boolean {
    if (
      !this.unauthenticated.fits(address, L.unauthenticated.perAddress, L.unauthenticated.inAll)
    ) {
      return false;
    }
    this.unauthenticated.add(address);
    return true;
  }

  /** A handshake ended without joining (closed, timed out, refused). */
  handshakeEnded(address: string): void {
    this.unauthenticated.remove(address);
  }

  /**
   * Message 3 proved `identity` from `address`. `replacing` is the address of the same
   * identity's link it would replace, if any: that link's place is reused, so a hub reconnecting
   * is never refused for its own old link. `known` is whether the identity is stored; `stored`
   * how many are.
   */
  join(
    address: string,
    nowMs: number,
    identity: { readonly known: boolean; readonly stored: number },
    replacing: string | undefined,
  ): JoinAnswer {
    const sameAddress = replacing === address;
    const inAllFits = replacing !== undefined || this.authenticated.total < L.hubLinks.inAll;
    const perAddressFits = sameAddress || this.authenticated.of(address) < L.hubLinks.perAddress;
    if (!inAllFits || !perAddressFits) return { kind: "full" };
    if (!identity.known) {
      if (identity.stored >= L.newIdentities.storedMax) {
        return { kind: "newIdentity", retryAfterMs: RELAY_LIMITS.limitWaitMs, stored: true };
      }
      const perAddress = this.newPerAddress.check(
        address,
        nowMs,
        1,
        L.newIdentities.perDayPerAddress,
      );
      if (!perAddress.ok) {
        return { kind: "newIdentity", retryAfterMs: perAddress.retryAfterMs, stored: false };
      }
      const inAll = this.newInAll.take(ALL, nowMs);
      if (!inAll.ok) {
        return { kind: "newIdentity", retryAfterMs: inAll.retryAfterMs, stored: false };
      }
      this.newPerAddress.take(address, nowMs, 1, L.newIdentities.perDayPerAddress);
    }
    this.unauthenticated.remove(address);
    this.authenticated.add(address);
    return { kind: "ok" };
  }

  /** A joined link closed (replaced, silent, or by either side). */
  linkClosed(address: string): void {
    this.authenticated.remove(address);
  }

  // ----- Phone streams -----

  /** An HTTP upgrade to `/v1/phone/…` from `address`. */
  phoneUpgrade(address: string, nowMs: number): UpgradeAnswer {
    return this.phoneOpens.take(address, nowMs).ok ? "ok" : "rate";
  }

  /** A phone stream to a connected hub `identity`: open it, or say which cap it meets. */
  streamOpens(identity: string, address: string, nowMs: number): StreamAnswer {
    if (!this.streamsPerHub.fits(identity, L.phoneStreams.perHub, L.phoneStreams.inAll)) {
      return this.streamsPerHub.total >= L.phoneStreams.inAll ? "inAll" : "perHub";
    }
    if (!this.streamsPerAddress.fits(address, L.phoneStreams.openPerAddress, Infinity)) {
      return "perAddress";
    }
    if (this.traffic.used(identity, nowMs) >= L.traffic.streamBytesPerHubPerDay) return "traffic";
    this.streamsPerHub.add(identity);
    this.streamsPerAddress.add(address);
    return "ok";
  }

  streamClosed(identity: string, address: string): void {
    this.streamsPerHub.remove(identity);
    this.streamsPerAddress.remove(address);
  }

  /**
   * Bytes carried for `identity`'s streams. Counted whole: a stream already open runs on past the
   * budget; only new ones are refused, until midnight UTC.
   */
  carried(identity: string, bytes: number, nowMs: number): void {
    this.traffic.take(identity, nowMs, bytes, Infinity);
  }

  /** How long until `identity`'s traffic budget is new again, when it is spent; else 0. */
  trafficRetryAfter(identity: string, nowMs: number): number {
    const spent = this.traffic.check(identity, nowMs, 1, L.traffic.streamBytesPerHubPerDay);
    return spent.ok ? 0 : spent.retryAfterMs;
  }

  /** Counts, for the tests and the log. */
  get counts(): {
    readonly unauthenticated: number;
    readonly authenticated: number;
    readonly streams: number;
    readonly rateTables: number;
  } {
    return {
      unauthenticated: this.unauthenticated.total,
      authenticated: this.authenticated.total,
      streams: this.streamsPerHub.total,
      rateTables:
        this.hubUpgrades.size + this.phoneOpens.size + this.newPerAddress.size + this.traffic.size,
    };
  }
}

export type { Take };

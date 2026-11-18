/**
 * Who may open a relay link to the push service (docs/m4-design.md section 3, D142, layer 1),
 * before any state is kept for them. Pure: time is an input.
 *
 * The push service is reached over the internet by self-hosted relays, so its listener applies
 * the layer 1 rows that concern relay links, with the relay's own values (`PROTECTION_LIMITS`):
 *
 * | Row | Value | At the limit |
 * | --- | --- | --- |
 * | Upgrades per address | 10 a minute | HTTP 429 before the upgrade: no WebSocket, no Noise state |
 * | Handshakes in all | 500 a second | HTTP 503 before the upgrade |
 * | Unauthenticated links | 4 per address, 2,000 in all | HTTP 429 or 503 before the upgrade |
 * | Authenticated links | 8 per address, 20,000 in all | closed with 4429 after message 3; a joined link is never closed to make room |
 * | The rate table | 200,000 addresses | the oldest idle ones dropped; when none is idle, unknown addresses share one bucket |
 *
 * An address is an IPv4 address or an IPv6 /64. The operator's relay comes over the local socket,
 * which has no address: it is counted in the totals only.
 */
import { PROTECTION_LIMITS } from "../core/rules.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export interface PushLinkRules {
  readonly upgradesPerMinutePerAddress: number;
  readonly handshakesPerSecondInAll: number;
  readonly unauthenticatedPerAddress: number;
  readonly unauthenticatedInAll: number;
  readonly authenticatedPerAddress: number;
  readonly authenticatedInAll: number;
  readonly rateTableAddresses: number;
}

export const PUSH_LINK_LIMITS: PushLinkRules = {
  upgradesPerMinutePerAddress: PROTECTION_LIMITS.beforeState.hubAndRelayUpgradesPerMinutePerAddress,
  handshakesPerSecondInAll: PROTECTION_LIMITS.beforeState.handshakesPerSecondInAll,
  unauthenticatedPerAddress: PROTECTION_LIMITS.unauthenticated.perAddress,
  unauthenticatedInAll: PROTECTION_LIMITS.unauthenticated.inAll,
  authenticatedPerAddress: PROTECTION_LIMITS.hubLinks.perAddress,
  authenticatedInAll: PROTECTION_LIMITS.hubLinks.inAll,
  rateTableAddresses: PROTECTION_LIMITS.memory.rateTableAddresses,
};

/** The bucket every unknown address shares while the rate table is full. */
export const SHARED_BUCKET = "*";

/** Eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function ipv6Groups(text: string): number[] | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === "" ? [] : s.split(":"));
  const head = part(halves[0] ?? "");
  const tail = halves.length === 2 ? part(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [
    ...head,
    ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"),
    ...tail,
  ];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/iu.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The key an address is counted under: an IPv4 address as it is (an IPv4-mapped IPv6 address as
 * its IPv4 one), an IPv6 address as its /64.
 */
export function addressKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(ip)?.[1];
  if (mapped !== undefined) return mapped;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(ip)) return ip;
  const groups = ipv6Groups(ip.replace(/%.*$/u, ""));
  if (groups === undefined) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

export type UpgradeAnswer = "ok" | "rate" | "busy";

export class LinkGuard {
  private readonly upgrades = new Map<string, number[]>();
  /** The bucket every unknown address shares while the table is full; not one of its entries. */
  private shared: number[] = [];
  private readonly unauthenticated = new Map<string, number>();
  private readonly authenticated = new Map<string, number>();
  private unauthenticatedAll = 0;
  private authenticatedAll = 0;
  private second = -1;
  private handshakes = 0;

  constructor(private readonly rules: PushLinkRules = PUSH_LINK_LIMITS) {}

  /** The rate table's bucket for an address: its own, or the shared one while the table is full. */
  private bucket(address: string, nowMs: number): string {
    if (this.upgrades.has(address) || this.upgrades.size < this.rules.rateTableAddresses) {
      return address;
    }
    // Full: drop the addresses idle for a minute, oldest first (insertion order), then decide.
    for (const [key, times] of this.upgrades) {
      if (this.upgrades.size < this.rules.rateTableAddresses) break;
      const newest = times[times.length - 1] ?? 0;
      if (newest <= nowMs - MINUTE) this.upgrades.delete(key);
    }
    return this.upgrades.size < this.rules.rateTableAddresses ? address : SHARED_BUCKET;
  }

  /**
   * An HTTP upgrade to `/v1/relay` from `address` (a key from `addressKey`; null for the local
   * socket): `ok` counts it as an unauthenticated link; `rate` is answered 429, `busy` 503.
   */
  upgrade(address: string | null, nowMs: number): UpgradeAnswer {
    const second = Math.floor(nowMs / SECOND);
    if (second !== this.second) {
      this.second = second;
      this.handshakes = 0;
    }
    if (this.handshakes >= this.rules.handshakesPerSecondInAll) return "busy";
    if (this.unauthenticatedAll >= this.rules.unauthenticatedInAll) return "busy";
    if (address !== null) {
      const bucket = this.bucket(address, nowMs);
      const held = bucket === SHARED_BUCKET ? this.shared : (this.upgrades.get(bucket) ?? []);
      const times = held.filter((t) => t > nowMs - MINUTE);
      const keep = (list: number[]) => {
        if (bucket === SHARED_BUCKET) {
          this.shared = list;
        } else {
          // Re-inserted, so the table's order is by last use and the idlest come first.
          this.upgrades.delete(bucket);
          this.upgrades.set(bucket, list);
        }
      };
      if (times.length >= this.rules.upgradesPerMinutePerAddress) {
        keep(times);
        return "rate";
      }
      if ((this.unauthenticated.get(address) ?? 0) >= this.rules.unauthenticatedPerAddress) {
        return "rate";
      }
      times.push(nowMs);
      keep(times);
      this.unauthenticated.set(address, (this.unauthenticated.get(address) ?? 0) + 1);
    }
    this.handshakes += 1;
    this.unauthenticatedAll += 1;
    return "ok";
  }

  /** A link finished its handshake: false when the authenticated caps are full (close with 4429). */
  joined(address: string | null): boolean {
    if (this.authenticatedAll >= this.rules.authenticatedInAll) return false;
    if (
      address !== null &&
      (this.authenticated.get(address) ?? 0) >= this.rules.authenticatedPerAddress
    ) {
      return false;
    }
    this.release(this.unauthenticated, address);
    this.unauthenticatedAll -= 1;
    if (address !== null)
      this.authenticated.set(address, (this.authenticated.get(address) ?? 0) + 1);
    this.authenticatedAll += 1;
    return true;
  }

  /** A link closed, joined or not. */
  closed(address: string | null, wasJoined: boolean): void {
    if (wasJoined) {
      this.release(this.authenticated, address);
      this.authenticatedAll -= 1;
    } else {
      this.release(this.unauthenticated, address);
      this.unauthenticatedAll -= 1;
    }
  }

  private release(counts: Map<string, number>, address: string | null): void {
    if (address === null) return;
    const left = (counts.get(address) ?? 1) - 1;
    if (left <= 0) counts.delete(address);
    else counts.set(address, left);
  }

  /** Counts, for the tests. */
  get counts(): {
    readonly unauthenticated: number;
    readonly authenticated: number;
    readonly rateTable: number;
  } {
    return {
      unauthenticated: this.unauthenticatedAll,
      authenticated: this.authenticatedAll,
      rateTable: this.upgrades.size,
    };
  }
}

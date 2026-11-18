/**
 * The push service's limits (docs/m4-design.md section 3, D142: the "Pushes" row of layer 1, and
 * "The push service accepts only hubs and relays that prove themselves"). Pure: time is an input,
 * nothing here does input or output.
 *
 * Four limits, each checked before an item goes to Apple or Google, and each answered `limited`:
 *
 * | Limit | Value | Counted by |
 * | --- | --- | --- |
 * | Per relay key and hub together | 60 per 10 minutes, and 1,000 a day | the relay's proved key and the hub identity the item names: a hostile relay naming a real hub spends only its own share of that hub's quota |
 * | Per relay key | 10,000 a day; more for the operator's own relay | the relay's proved key |
 * | Per address | `perAddressPerDay` ‡ | the relay link's address (an IPv4 address or an IPv6 /64); the operator's local socket has none |
 * | In total | `totalPerDay` ‡, the operator alerted at 80% | everything |
 *
 * The design gives values for the first two (`PROTECTION_LIMITS.pushes`); the operator's own share,
 * the per-address limit and the total are this role's provisional choices ‡, to be set from
 * Apple's and Google's quotas once known. "A day" is the UTC day, as the relay's traffic limit
 * has it ("until midnight UTC"); the 10 minutes are a sliding window. Only items let through are
 * counted: a refused item spends nothing, so a flood does not lengthen its own wait.
 */
import { PROTECTION_LIMITS } from "../core/rules.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface PushLimitRules {
  readonly perHubPerWindow: number;
  readonly windowMs: number;
  readonly perHubPerDay: number;
  readonly perRelayKeyPerDay: number;
  readonly operatorAlertFraction: number;
  readonly operatorRelayKeyPerDay: number;
  readonly perAddressPerDay: number;
  readonly totalPerDay: number;
  readonly framesInHand: number;
}

export const PUSH_SERVICE_LIMITS: PushLimitRules = {
  ...PROTECTION_LIMITS.pushes,
  /** The operator's own relay's daily share ("more for the operator's own relay") ‡. */
  operatorRelayKeyPerDay: 1_000_000,
  /** Per address a day ‡: two relay keys' worth, so one address cannot multiply keys for free. */
  perAddressPerDay: 2 * PROTECTION_LIMITS.pushes.perRelayKeyPerDay,
  /** The whole service a day ‡, below Apple's and Google's quotas once they are known. */
  totalPerDay: 2_000_000,
  /** Push frames one relay link may have in hand at once ‡; another is answered `limited`. */
  framesInHand: 4,
};

/** Which limit refused an item. */
export type LimitName = "pair" | "relayKey" | "address" | "total";

export interface LimitRefusal {
  readonly what: LimitName;
  /** When an item of the same kind would next be let through. */
  readonly retryAfterMs: number;
}

/** Who sends an item: the relay's proved key, the hub it names, the link's address. */
export interface PushSource {
  readonly relayKey: string;
  readonly hub: string;
  /** Null on the operator's local socket. */
  readonly address: string | null;
  /** The operator's own relay, on the local socket. */
  readonly operator: boolean;
}

interface PairCount {
  /** When each item of the last 10 minutes was let through, oldest first; at most `perHubPerWindow`. */
  readonly times: number[];
  day: number;
}

const dayOf = (ms: number) => Math.floor(ms / DAY);
const untilMidnight = (ms: number) => (dayOf(ms) + 1) * DAY - ms;

export class PushLimiter {
  private day = -1;
  private sweptMs = 0;
  private total = 0;
  private alerted = false;
  private readonly relayKeys = new Map<string, number>();
  private readonly addresses = new Map<string, number>();
  private readonly pairs = new Map<string, PairCount>();

  constructor(private readonly rules: PushLimitRules = PUSH_SERVICE_LIMITS) {}

  /** A new UTC day: every daily count starts again; windows still open are kept. */
  private roll(nowMs: number): void {
    const today = dayOf(nowMs);
    if (today === this.day) return;
    this.day = today;
    this.total = 0;
    this.alerted = false;
    this.relayKeys.clear();
    this.addresses.clear();
    for (const [key, pair] of this.pairs) {
      const fresh = pair.times.filter((t) => t > nowMs - this.rules.windowMs);
      if (fresh.length === 0) this.pairs.delete(key);
      else this.pairs.set(key, { times: fresh, day: 0 });
    }
  }

  /**
   * Once a window's length: drops the pairs carried over from yesterday whose window has closed,
   * so what is kept is bounded by what was let through today and in the last 10 minutes.
   */
  private sweep(nowMs: number): void {
    if (nowMs - this.sweptMs < this.rules.windowMs) return;
    this.sweptMs = nowMs;
    for (const [key, pair] of this.pairs) {
      if (pair.day === 0 && !pair.times.some((t) => t > nowMs - this.rules.windowMs)) {
        this.pairs.delete(key);
      }
    }
  }

  /**
   * Lets one item through, counting it, or says which limit refuses it and for how long. Checked
   * from the widest to the narrowest, so the refusal names the limit that matters most.
   */
  admit(source: PushSource, nowMs: number): LimitRefusal | undefined {
    this.roll(nowMs);
    this.sweep(nowMs);
    const rules = this.rules;
    if (this.total >= rules.totalPerDay)
      return { what: "total", retryAfterMs: untilMidnight(nowMs) };
    const address = source.address;
    const addressCount = address === null ? 0 : (this.addresses.get(address) ?? 0);
    if (address !== null && addressCount >= rules.perAddressPerDay) {
      return { what: "address", retryAfterMs: untilMidnight(nowMs) };
    }
    const keyCount = this.relayKeys.get(source.relayKey) ?? 0;
    const keyLimit = source.operator ? rules.operatorRelayKeyPerDay : rules.perRelayKeyPerDay;
    if (keyCount >= keyLimit) return { what: "relayKey", retryAfterMs: untilMidnight(nowMs) };
    const pairKey = `${source.relayKey} ${source.hub}`;
    const pair = this.pairs.get(pairKey);
    const times = pair?.times.filter((t) => t > nowMs - rules.windowMs) ?? [];
    const pairDay = pair?.day ?? 0;
    if (pairDay >= rules.perHubPerDay) return { what: "pair", retryAfterMs: untilMidnight(nowMs) };
    const oldest = times[0];
    if (times.length >= rules.perHubPerWindow && oldest !== undefined) {
      return { what: "pair", retryAfterMs: oldest + rules.windowMs - nowMs };
    }
    times.push(nowMs);
    this.pairs.set(pairKey, { times, day: pairDay + 1 });
    this.relayKeys.set(source.relayKey, keyCount + 1);
    if (address !== null) this.addresses.set(address, addressCount + 1);
    this.total += 1;
    return undefined;
  }

  /**
   * True once a day, the first time the total reaches `operatorAlertFraction` of its ceiling:
   * the operator is told before the service starts refusing everyone.
   */
  alertDue(nowMs: number): boolean {
    this.roll(nowMs);
    if (this.alerted || this.total < this.rules.totalPerDay * this.rules.operatorAlertFraction) {
      return false;
    }
    this.alerted = true;
    return true;
  }

  /** Items let through today, for the log. */
  get today(): number {
    return this.total;
  }

  /** Entries held, for the tests of its memory bound. */
  get entries(): number {
    return this.pairs.size + this.relayKeys.size + this.addresses.size;
  }
}

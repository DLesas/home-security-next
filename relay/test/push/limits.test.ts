/**
 * The push service's limits (D142, the "Pushes" row), each at its edge: one below, at, one above;
 * the sliding 10 minutes; the UTC day; one relay's flood not spending another's share of the same
 * hub; the operator's own share; the alert at 80%.
 */
import { describe, expect, test } from "bun:test";
import { PROTECTION_LIMITS } from "../../src/core/rules.ts";
import {
  PUSH_SERVICE_LIMITS,
  PushLimiter,
  type PushLimitRules,
  type PushSource,
} from "../../src/push/limits.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MIDNIGHT = Date.UTC(2026, 10, 18);
const NOON = MIDNIGHT + 12 * 60 * MINUTE;

const A: PushSource = { relayKey: "relaya", hub: "hub1", address: "203.0.113.1", operator: false };
const B: PushSource = { relayKey: "relayb", hub: "hub1", address: "203.0.113.2", operator: false };

/** Lets `n` items through, each a moment apart, and returns how many were refused. */
function sendMany(
  limiter: PushLimiter,
  source: PushSource,
  n: number,
  startMs: number,
  stepMs = 1,
): number {
  let refused = 0;
  for (let i = 0; i < n; i += 1)
    if (limiter.admit(source, startMs + i * stepMs) !== undefined) refused += 1;
  return refused;
}

describe("the values", () => {
  test("are the design's where it gives them", () => {
    expect(PUSH_SERVICE_LIMITS).toMatchObject({
      perHubPerWindow: 60,
      windowMs: 10 * MINUTE,
      perHubPerDay: 1000,
      perRelayKeyPerDay: 10_000,
      operatorAlertFraction: 0.8,
    });
    expect(PUSH_SERVICE_LIMITS.operatorRelayKeyPerDay).toBeGreaterThan(
      PROTECTION_LIMITS.pushes.perRelayKeyPerDay,
    );
  });
});

describe("per relay key and hub together: 60 per 10 minutes", () => {
  test("the 59th and 60th pass, the 61st is limited until the first leaves the window", () => {
    const limiter = new PushLimiter();
    expect(sendMany(limiter, A, 59, NOON)).toBe(0);
    expect(limiter.admit(A, NOON + 59)).toBeUndefined();
    const refusal = limiter.admit(A, NOON + 60);
    expect(refusal).toEqual({ what: "pair", retryAfterMs: 10 * MINUTE - 60 });
    // Still limited a millisecond before the first item is 10 minutes old; free at exactly 10.
    expect(limiter.admit(A, NOON + 10 * MINUTE - 1)?.what).toBe("pair");
    expect(limiter.admit(A, NOON + 10 * MINUTE)).toBeUndefined();
  });

  test("a refused item spends nothing", () => {
    const limiter = new PushLimiter();
    sendMany(limiter, A, 60, NOON);
    for (let i = 0; i < 100; i += 1) expect(limiter.admit(A, NOON + 100 + i)?.what).toBe("pair");
    expect(limiter.today).toBe(60);
    expect(limiter.admit(A, NOON + 10 * MINUTE)).toBeUndefined();
  });

  test("another relay naming the same hub has its own share: a flood from one spends none of the other's", () => {
    const limiter = new PushLimiter();
    expect(sendMany(limiter, B, 500, NOON)).toBe(440);
    expect(sendMany(limiter, A, 60, NOON + 1000)).toBe(0);
    expect(limiter.admit(A, NOON + 2000)?.what).toBe("pair");
  });

  test("another hub from the same relay has its own share", () => {
    const limiter = new PushLimiter();
    sendMany(limiter, A, 60, NOON);
    expect(limiter.admit({ ...A, hub: "hub2" }, NOON + 100)).toBeUndefined();
  });
});

describe("per relay key and hub together: 1,000 a day", () => {
  test("the 999th and 1,000th pass, the 1,001st waits for midnight UTC", () => {
    const limiter = new PushLimiter();
    // 60 every 10 minutes, so the window never refuses: 999 items over about 166 minutes.
    let refused = 0;
    for (let i = 0; i < 999; i += 1) {
      const at = NOON + Math.floor(i / 60) * 10 * MINUTE + (i % 60);
      if (limiter.admit(A, at) !== undefined) refused += 1;
    }
    expect(refused).toBe(0);
    const later = NOON + 17 * 10 * MINUTE;
    expect(limiter.admit(A, later)).toBeUndefined();
    expect(limiter.admit(A, later + 10 * MINUTE)).toEqual({
      what: "pair",
      retryAfterMs: MIDNIGHT + DAY - (later + 10 * MINUTE),
    });
    expect(limiter.admit(A, MIDNIGHT + DAY - 1)?.what).toBe("pair");
    expect(limiter.admit(A, MIDNIGHT + DAY)).toBeUndefined();
  });
});

const small: PushLimitRules = {
  ...PUSH_SERVICE_LIMITS,
  perHubPerWindow: 1_000_000,
  perHubPerDay: 1_000_000,
  perRelayKeyPerDay: 100,
  operatorRelayKeyPerDay: 300,
  perAddressPerDay: 150,
  totalPerDay: 400,
};

/** Items from one relay to many hubs, so the pair limit never applies. */
function spread(
  limiter: PushLimiter,
  source: PushSource,
  n: number,
  at: number,
): (string | undefined)[] {
  return Array.from(
    { length: n },
    (_, i) => limiter.admit({ ...source, hub: `h${i}` }, at + i)?.what,
  );
}

describe("per relay key: 10,000 a day, more for the operator's own relay", () => {
  test("at the design's value: the 10,000th passes, the 10,001st is limited until midnight", () => {
    const limiter = new PushLimiter();
    const outcomes = spread(limiter, A, 10_000, NOON);
    expect(outcomes).toHaveLength(10_000);
    expect(outcomes.filter((o) => o !== undefined)).toHaveLength(0);
    expect(limiter.admit({ ...A, hub: "another" }, NOON + DAY / 4)).toEqual({
      what: "relayKey",
      retryAfterMs: MIDNIGHT + DAY - (NOON + DAY / 4),
    });
    expect(limiter.admit({ ...A, hub: "another" }, MIDNIGHT + DAY)).toBeUndefined();
  });

  test("one below, at, one above, with a smaller value", () => {
    const limiter = new PushLimiter(small);
    expect(spread(limiter, A, 99, NOON)).toEqual(Array<undefined>(99).fill(undefined));
    expect(limiter.admit({ ...A, hub: "x" }, NOON + 500)).toBeUndefined();
    expect(limiter.admit({ ...A, hub: "y" }, NOON + 501)?.what).toBe("relayKey");
  });

  test("the operator's relay has its own, larger share", () => {
    const limiter = new PushLimiter(small);
    const operator: PushSource = { relayKey: "operator", hub: "h", address: null, operator: true };
    expect(spread(limiter, operator, 300, NOON)).toEqual(Array<undefined>(300).fill(undefined));
    expect(limiter.admit({ ...operator, hub: "z" }, NOON + 1000)?.what).toBe("relayKey");
  });
});

describe("per address", () => {
  test("two relay keys from one address share its 150: the 150th passes, the 151st is limited", () => {
    const limiter = new PushLimiter(small);
    const other: PushSource = { ...A, relayKey: "relayc" };
    expect(spread(limiter, A, 100, NOON)).toEqual(Array<undefined>(100).fill(undefined));
    expect(spread(limiter, other, 49, NOON + 200)).toEqual(Array<undefined>(49).fill(undefined));
    expect(limiter.admit({ ...other, hub: "x" }, NOON + 300)).toBeUndefined();
    expect(limiter.admit({ ...other, hub: "y" }, NOON + 301)?.what).toBe("address");
    // Another address is untouched.
    expect(limiter.admit({ ...B, hub: "y" }, NOON + 302)).toBeUndefined();
  });

  test("the local socket has no address, so no address limit", () => {
    const limiter = new PushLimiter(small);
    const operator: PushSource = { relayKey: "operator", hub: "h", address: null, operator: true };
    expect(spread(limiter, operator, 200, NOON)).toEqual(Array<undefined>(200).fill(undefined));
  });
});

describe("in total", () => {
  test("the 400th passes, the 401st is limited for everyone; the operator is alerted once at 80%", () => {
    const limiter = new PushLimiter(small);
    const sources: PushSource[] = [0, 1, 2, 3, 4].map((i) => ({
      relayKey: `r${i}`,
      hub: "h",
      address: `198.51.100.${i}`,
      operator: false,
    }));
    let admitted = 0;
    const alerts: number[] = [];
    for (const source of sources) {
      for (let i = 0; i < 80; i += 1) {
        if (limiter.admit({ ...source, hub: `h${i}` }, NOON + admitted) === undefined)
          admitted += 1;
        if (limiter.alertDue(NOON + admitted)) alerts.push(admitted);
      }
    }
    expect(admitted).toBe(400);
    expect(alerts).toEqual([320]);
    const operator: PushSource = { relayKey: "operator", hub: "h", address: null, operator: true };
    expect(limiter.admit(operator, NOON + 1000)?.what).toBe("total");
    expect(limiter.admit(operator, MIDNIGHT + DAY)).toBeUndefined();
  });

  test("a new day starts every daily count, keeps the 10 minutes, and keeps memory to what is live", () => {
    const limiter = new PushLimiter(small);
    spread(limiter, A, 100, MIDNIGHT + DAY - 5 * MINUTE);
    expect(limiter.entries).toBeGreaterThan(100);
    // Just after midnight the relay key's day is new; most pairs' windows are still open.
    expect(limiter.admit({ ...A, hub: "fresh" }, MIDNIGHT + DAY + 1)).toBeUndefined();
    limiter.admit({ ...A, hub: "fresh" }, MIDNIGHT + DAY + 11 * MINUTE);
    expect(limiter.entries).toBeLessThan(10);
  });
});

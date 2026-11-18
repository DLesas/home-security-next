/**
 * The pure pieces under layer 1 and storage: bounded rate tables (the oldest idle dropped, a
 * shared strict bucket when full), the address an IPv6 /64 counts as, the deadline heap, the
 * retention of identities, the release budgets, and the roster's push resolution.
 */
import { describe, expect, test } from "bun:test";
import { addressKey } from "../../src/core/address.ts";
import { Deadlines } from "../../src/core/deadlines.ts";
import {
  isEstablished,
  isExpired,
  linkClosed,
  newRecord,
  seenOn,
} from "../../src/core/identities.ts";
import { DayBudget, OpenCounts, SHARED_BUCKET, SlidingRate } from "../../src/core/rate.ts";
import { pieceCost, ReleaseBudget, WHOLE_FILE } from "../../src/core/release-budget.ts";
import { alertItems, resolvePush, targetsOf } from "../../src/core/roster.ts";
import { PROTECTION_LIMITS, RETENTION_RULES } from "../../src/core/rules.ts";
import { TIME, untilNextUtcDay, utcDay } from "../../src/core/time.ts";
import { sealedH, target } from "../helpers.ts";

const T0 = Date.UTC(2026, 10, 18, 12);

describe("the rate tables are bounded", () => {
  test("a full table drops the idlest keys, and with none idle unknown keys share one strict bucket", () => {
    const rate = new SlidingRate(2, TIME.MINUTE, 3);
    expect(rate.take("a", T0).ok).toBe(true);
    expect(rate.take("b", T0 + 1).ok).toBe(true);
    expect(rate.take("c", T0 + 2).ok).toBe(true);
    expect(rate.size).toBe(3);
    // Full, none idle: unknown keys share one bucket of the same strict limit.
    expect(rate.take("d", T0 + 3).ok).toBe(true);
    expect(rate.take("e", T0 + 4).ok).toBe(true);
    expect(rate.take("f", T0 + 5)).toEqual({ ok: false, retryAfterMs: TIME.MINUTE - 2 });
    expect(rate.size).toBe(3);
    // Known keys keep their own count.
    expect(rate.take("a", T0 + 6).ok).toBe(true);
    expect(rate.take("a", T0 + 7).ok).toBe(false);
    // A minute on, "b" is idle (its last take at T0 + 1) and goes; "g" takes its place.
    expect(rate.take("g", T0 + 1 + TIME.MINUTE).ok).toBe(true);
    expect(rate.size).toBe(3);
  });

  test(`the relay's tables hold at most ${PROTECTION_LIMITS.memory.rateTableAddresses} addresses`, () => {
    const rate = new SlidingRate(1, TIME.MINUTE, PROTECTION_LIMITS.memory.rateTableAddresses);
    for (let i = 0; i < PROTECTION_LIMITS.memory.rateTableAddresses + 1000; i++) {
      rate.take(`k${i}`, T0);
    }
    expect(rate.size).toBe(PROTECTION_LIMITS.memory.rateTableAddresses);
    expect(rate.take(SHARED_BUCKET, T0).ok).toBe(false);
  });

  test("a day budget refuses whole and resets at midnight UTC, bounded the same way", () => {
    const day = new DayBudget(2);
    expect(day.take("a", T0, 5, 10).ok).toBe(true);
    expect(day.take("a", T0, 5, 10).ok).toBe(true);
    expect(day.take("a", T0, 1, 10)).toEqual({ ok: false, retryAfterMs: untilNextUtcDay(T0) });
    expect(day.used("a", T0)).toBe(10);
    const midnight = T0 + untilNextUtcDay(T0);
    expect(day.take("a", midnight, 10, 10).ok).toBe(true);
    expect(day.take("b", T0, 1, 10).ok).toBe(true);
    expect(day.take("c", T0, 1, 1).ok).toBe(true); // shared bucket
    expect(day.take("d", T0, 1, 1).ok).toBe(false); // the same shared bucket, now spent
    expect(day.size).toBe(2);
    expect(utcDay(midnight)).toBe(utcDay(T0) + 1);
  });

  test("open counts keep only keys with something open", () => {
    const open = new OpenCounts();
    open.add("a");
    open.add("a");
    open.remove("a");
    expect(open.of("a")).toBe(1);
    open.remove("a");
    expect(open.size).toBe(0);
    expect(open.fits("a", 1, 1)).toBe(true);
    open.add(null);
    expect(open.fits("a", 1, 1)).toBe(false);
  });
});

describe("an address", () => {
  test("is an IPv4 address, or an IPv6 /64", () => {
    expect(addressKey("192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::9")).toBe("2001:db8:1:3::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("fe80::1%lo0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("256.1.1.1")).toBeUndefined();
    expect(addressKey("not an address")).toBeUndefined();
    expect(addressKey("1:2:3")).toBeUndefined();
  });
});

describe("the deadline heap", () => {
  test("gives keys in time order, one entry per key", () => {
    const d = new Deadlines();
    const times = new Map<string, number>();
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 500; i++) {
      const key = `k${next() % 100}`;
      const at = next() % 10_000;
      d.set(key, at);
      times.set(key, at);
      if (i % 7 === 0) {
        d.set(key, null);
        times.delete(key);
      }
    }
    expect(d.size).toBe(times.size);
    expect(d.next).toBe(Math.min(...times.values()));
    const due = d.takeDue(5000);
    const expected = [...times.entries()]
      .filter(([, at]) => at <= 5000)
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => times.get(k));
    expect(due.map((k) => times.get(k))).toEqual(expected);
    expect(d.size).toBe(times.size - due.length);
  });
});

describe("identities", () => {
  const ID = "abcdefghijklmnopqrstuvwxyz";

  test(`established after ${RETENTION_RULES.settledAfterDays} different UTC days`, () => {
    let record = newRecord(ID, T0);
    expect(isEstablished(record)).toBe(false);
    // The same day again counts nothing and stores nothing.
    expect(seenOn(record, T0 + TIME.HOUR).store).toBe(false);
    record = seenOn(record, T0 + TIME.DAY).record;
    expect(record.daysSeen).toBe(2);
    expect(isEstablished(record)).toBe(false);
    const third = seenOn(record, T0 + 2 * TIME.DAY);
    expect(third.store).toBe(true);
    expect(isEstablished(third.record)).toBe(true);
    expect(seenOn(third.record, T0 + 3 * TIME.DAY).record.daysSeen).toBe(
      RETENTION_RULES.settledAfterDays,
    );
  });

  test("an unsettled identity is deleted 7 days after its last contact, not a millisecond before", () => {
    const record = linkClosed(newRecord(ID, T0), T0 + TIME.HOUR);
    expect(record.seenMs).toBe(T0 + TIME.HOUR);
    const edge = T0 + TIME.HOUR + RETENTION_RULES.unsettledHubMs;
    expect(isExpired(record, edge - 1)).toBe(false);
    expect(isExpired(record, edge)).toBe(true);
  });

  test("an established identity is kept 90 days after its last contact", () => {
    let record = newRecord(ID, T0);
    record = seenOn(record, T0 + TIME.DAY).record;
    record = seenOn(record, T0 + 2 * TIME.DAY).record;
    const last = T0 + 2 * TIME.DAY;
    expect(isExpired(record, last + RETENTION_RULES.unsettledHubMs)).toBe(false);
    expect(isExpired(record, last + RETENTION_RULES.establishedHubMs - 1)).toBe(false);
    expect(isExpired(record, last + RETENTION_RULES.establishedHubMs)).toBe(true);
  });
});

describe("the release budgets", () => {
  const hub = { kind: "hub" as const, identity: "h1", address: "192.0.2.1" };

  test("3 downloads of a file per identity per day, counted in bytes, whatever the offsets", () => {
    const budget = new ReleaseBudget(100, 1e12);
    const bytes = 1000;
    for (let i = 0; i < 3 * 4 - 1; i++) {
      expect(budget.admit({ ...hub, address: `10.0.0.${i}` }, "f", bytes, 250, T0).ok).toBe(true);
    }
    expect(budget.admit({ ...hub, address: "10.0.1.0" }, "f", bytes, 250, T0).ok).toBe(true);
    expect(budget.admit({ ...hub, address: "10.0.1.1" }, "f", bytes, 1, T0)).toEqual({
      ok: false,
      retryAfterMs: untilNextUtcDay(T0),
    });
    // Another file, or another day, is its own.
    expect(budget.admit({ ...hub, address: "10.0.1.2" }, "g", bytes, 250, T0).ok).toBe(true);
    expect(budget.admit({ ...hub, address: "10.0.1.3" }, "f", bytes, 250, T0 + TIME.DAY).ok).toBe(
      true,
    );
  });

  test("3 whole files per address per day, whatever the identity", () => {
    const budget = new ReleaseBudget(100, 1e12);
    const peer = (n: number) => ({ kind: "hub" as const, identity: `h${n}`, address: "192.0.2.9" });
    expect(pieceCost(1000, 1000)).toBe(WHOLE_FILE);
    expect(budget.admit(peer(1), "a", 1000, 1000, T0).ok).toBe(true);
    expect(budget.admit(peer(2), "b", 2000, 2000, T0).ok).toBe(true);
    expect(budget.admit(peer(3), "c", 500, 499, T0).ok).toBe(true);
    expect(budget.admit(peer(4), "c", 500, 1, T0).ok).toBe(true); // exactly 3 whole files
    expect(budget.admit(peer(5), "c", 500, 1, T0).ok).toBe(false);
    // The operator's local socket has no address: counted per identity and in all only.
    expect(budget.admit({ ...peer(6), address: null }, "c", 500, 500, T0).ok).toBe(true);
  });

  test("10 files per relay key per day, on relay links only", () => {
    const budget = new ReleaseBudget(1000, 1e12);
    const relay = (n: number) => ({
      kind: "relay" as const,
      identity: "r1",
      address: `10.1.0.${n}`,
    });
    for (let i = 0; i < 10; i++)
      expect(budget.admit(relay(i), `f${i}`, 100, 100, T0).ok).toBe(true);
    expect(budget.admit(relay(20), "f10", 100, 1, T0).ok).toBe(false);
    // A hub with the same identity text is not a relay key.
    expect(
      budget.admit({ kind: "hub", identity: "r1", address: "10.2.0.1" }, "f10", 100, 100, T0).ok,
    ).toBe(true);
  });

  test("the daily egress budget for the service, then until midnight UTC", () => {
    const budget = new ReleaseBudget(1000, 1000);
    const peer = (n: number) => ({
      kind: "hub" as const,
      identity: `h${n}`,
      address: `10.3.0.${n}`,
    });
    expect(budget.admit(peer(1), "f", 10_000, 999, T0).ok).toBe(true);
    expect(budget.admit(peer(2), "f", 10_000, 1, T0).ok).toBe(true);
    expect(budget.admit(peer(3), "f", 10_000, 1, T0)).toEqual({
      ok: false,
      retryAfterMs: untilNextUtcDay(T0),
    });
    expect(budget.egressToday(T0)).toBe(1000);
    expect(budget.admit(peer(3), "f", 10_000, 1, T0 + untilNextUtcDay(T0)).ok).toBe(true);
  });

  test("a refused piece spends nothing", () => {
    const budget = new ReleaseBudget(1000, 1000);
    expect(budget.admit(hub, "f", 100, 100, T0).ok).toBe(true);
    expect(budget.admit(hub, "f", 100, 100, T0).ok).toBe(true);
    expect(budget.admit(hub, "f", 100, 100, T0).ok).toBe(true);
    expect(budget.admit(hub, "f", 100, 1, T0).ok).toBe(false);
    expect(budget.egressToday(T0)).toBe(300);
  });

  test("the default egress budget is the rule's", () => {
    expect(new ReleaseBudget().dailyEgressBytes).toBe(PROTECTION_LIMITS.releases.dailyEgressBytes);
  });
});

describe("the roster", () => {
  test("turns a hub's items into the push service's through its targets", () => {
    const targets = targetsOf([target(1), target(2)]);
    const h = sealedH(target(1).key);
    const resolved = resolvePush(
      "hubhubhubhubhubhubhubhubhu",
      [
        { id: 5, key: target(1).key, h },
        { id: 6, key: "ffffffffffffffff", h },
      ],
      targets,
    );
    expect(resolved.unknown).toEqual([6]);
    expect(resolved.send).toEqual([
      {
        hubId: 5,
        key: target(1).key,
        item: {
          hub: "hubhubhubhubhubhubhubhubhu",
          platform: "fcm",
          env: "production",
          token: "token-1",
          h,
        },
      },
    ]);
    const alerts = alertItems("hubhubhubhubhubhubhubhubhu", targets, "back");
    expect(alerts.map((a) => a.item.h)).toEqual([target(1).back, target(2).back]);
    expect(alertItems("x", targets, "unreachable").map((a) => a.item.h)).toEqual([
      target(1).unreachable,
      target(2).unreachable,
    ]);
  });
});

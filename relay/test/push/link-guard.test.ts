/**
 * Who may open a relay link (D142, layer 1, the rows for relay links), each at its edge, and the
 * address an IPv6 peer is counted under.
 */
import { describe, expect, test } from "bun:test";
import {
  addressKey,
  LinkGuard,
  PUSH_LINK_LIMITS,
  type PushLinkRules,
  SHARED_BUCKET,
} from "../../src/push/link-guard.ts";

const NOON = Date.UTC(2026, 10, 18, 12);
const MINUTE = 60_000;

describe("addresses", () => {
  test("IPv4 as it is, IPv4-mapped as IPv4, IPv6 as its /64", () => {
    expect(addressKey("203.0.113.9")).toBe("203.0.113.9");
    expect(addressKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("2001:db8:1:3::9")).not.toBe(addressKey("2001:db8:1:2::9"));
  });

  test("the design's values", () => {
    expect(PUSH_LINK_LIMITS).toEqual({
      upgradesPerMinutePerAddress: 10,
      handshakesPerSecondInAll: 500,
      unauthenticatedPerAddress: 4,
      unauthenticatedInAll: 2000,
      authenticatedPerAddress: 8,
      authenticatedInAll: 20_000,
      rateTableAddresses: 200_000,
    });
  });
});

/** Opens and joins a link at once, so the unauthenticated caps do not apply. */
function upgradeAndJoin(guard: LinkGuard, address: string | null, at: number): string {
  const answer = guard.upgrade(address, at);
  if (answer !== "ok") return answer;
  return guard.joined(address) ? "joined" : "full";
}

describe("upgrades per address: 10 a minute", () => {
  test("the 9th and 10th pass, the 11th is 429 until the first is a minute old", () => {
    const guard = new LinkGuard();
    // Each joins and closes, so only the rate counts.
    const once = (address: string, at: number) => {
      const answer = upgradeAndJoin(guard, address, at);
      if (answer === "joined") guard.closed(address, true);
      return answer;
    };
    for (let i = 0; i < 8; i += 1) expect(once("a", NOON + i)).toBe("joined");
    expect(once("a", NOON + 8)).toBe("joined");
    expect(once("b", NOON + 8)).toBe("joined");
    expect(guard.upgrade("a", NOON + 9)).toBe("ok");
    expect(guard.upgrade("a", NOON + 10)).toBe("rate");
    expect(guard.upgrade("a", NOON + MINUTE - 1)).toBe("rate");
    expect(guard.upgrade("a", NOON + MINUTE)).toBe("ok");
  });

  test("the local socket is not counted per address", () => {
    const guard = new LinkGuard();
    for (let i = 0; i < 50; i += 1) {
      expect(guard.upgrade(null, NOON + i)).toBe("ok");
      guard.closed(null, false);
    }
  });
});

const roomy: PushLinkRules = { ...PUSH_LINK_LIMITS, upgradesPerMinutePerAddress: 1_000_000 };

describe("unauthenticated links: 4 per address, 2,000 in all", () => {
  test("the 4th passes, the 5th from that address is 429; one closing makes room", () => {
    const guard = new LinkGuard(roomy);
    for (let i = 0; i < 3; i += 1) expect(guard.upgrade("a", NOON)).toBe("ok");
    expect(guard.upgrade("a", NOON)).toBe("ok");
    expect(guard.upgrade("a", NOON)).toBe("rate");
    expect(guard.upgrade("b", NOON)).toBe("ok");
    guard.closed("a", false);
    expect(guard.upgrade("a", NOON)).toBe("ok");
  });

  test("the 2,000th in all passes, the 2,001st is 503", () => {
    const guard = new LinkGuard({ ...roomy, handshakesPerSecondInAll: 1_000_000 });
    for (let i = 0; i < 1999; i += 1)
      expect(guard.upgrade(`10.0.${i >> 8}.${i & 255}`, NOON)).toBe("ok");
    expect(guard.upgrade("10.9.9.9", NOON)).toBe("ok");
    expect(guard.upgrade("10.9.9.10", NOON)).toBe("busy");
    expect(guard.counts.unauthenticated).toBe(2000);
  });
});

describe("handshakes in all: 500 a second", () => {
  test("the 500th in a second passes, the 501st is 503 until the next second", () => {
    const guard = new LinkGuard(roomy);
    const second = Math.floor(NOON / 1000) * 1000;
    for (let i = 0; i < 499; i += 1) {
      expect(guard.upgrade(`10.1.${i >> 8}.${i & 255}`, second)).toBe("ok");
      guard.closed(`10.1.${i >> 8}.${i & 255}`, false);
    }
    expect(guard.upgrade("10.2.0.1", second + 999)).toBe("ok");
    expect(guard.upgrade("10.2.0.2", second + 999)).toBe("busy");
    expect(guard.upgrade("10.2.0.2", second + 1000)).toBe("ok");
  });
});

describe("authenticated links: 8 per address, 20,000 in all", () => {
  test("the 8th joins, the 9th from that address is turned away; a close makes room", () => {
    const guard = new LinkGuard(roomy);
    for (let i = 0; i < 7; i += 1) expect(upgradeAndJoin(guard, "a", NOON)).toBe("joined");
    expect(upgradeAndJoin(guard, "a", NOON)).toBe("joined");
    expect(upgradeAndJoin(guard, "a", NOON)).toBe("full");
    // The refused one is still an unauthenticated link until it closes.
    guard.closed("a", false);
    guard.closed("a", true);
    expect(upgradeAndJoin(guard, "a", NOON)).toBe("joined");
    expect(guard.counts.authenticated).toBe(8);
  });

  test("the 20,000th in all joins, the 20,001st is turned away", () => {
    const guard = new LinkGuard({ ...roomy, handshakesPerSecondInAll: 1_000_000 });
    for (let i = 0; i < 20_000; i += 1)
      expect(upgradeAndJoin(guard, `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, NOON)).toBe(
        "joined",
      );
    expect(upgradeAndJoin(guard, "11.0.0.1", NOON)).toBe("full");
    expect(upgradeAndJoin(guard, null, NOON)).toBe("full");
  });
});

describe("the rate table: bounded", () => {
  test("when full, idle addresses are dropped; when none is idle, unknown ones share one bucket", () => {
    const guard = new LinkGuard({
      ...roomy,
      upgradesPerMinutePerAddress: 2,
      rateTableAddresses: 3,
      handshakesPerSecondInAll: 1_000_000,
    });
    for (const a of ["a", "b", "c"]) {
      expect(guard.upgrade(a, NOON)).toBe("ok");
      guard.closed(a, false);
    }
    expect(guard.counts.rateTable).toBe(3);
    // Full, nobody idle: d and e share one bucket of 2.
    expect(guard.upgrade("d", NOON + 1)).toBe("ok");
    guard.closed("d", false);
    expect(guard.upgrade("e", NOON + 2)).toBe("ok");
    guard.closed("e", false);
    expect(guard.upgrade("f", NOON + 3)).toBe("rate");
    expect(guard.counts.rateTable).toBe(3);
    // A minute on, a, b and c are idle: f gets its own bucket.
    expect(guard.upgrade("f", NOON + MINUTE + 10)).toBe("ok");
    expect(guard.counts.rateTable).toBeLessThanOrEqual(3);
    expect(SHARED_BUCKET).toBe("*");
  });
});

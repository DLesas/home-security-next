/**
 * Every row of D142's layer 1 that the relay role counts (docs/m4-design.md section 3), at its
 * edge: one below, at, one above, with the designed answer. Values from `PROTECTION_LIMITS`; time
 * is an input. The rows' answers through real sockets are `../protection.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { RELAY_LIMITS } from "@hsn/protocol/relay";
import { Admission } from "../../src/core/admission.ts";
import { PROTECTION_LIMITS as L } from "../../src/core/rules.ts";
import { TIME, untilNextUtcDay } from "../../src/core/time.ts";

const T0 = Date.UTC(2026, 10, 18, 12);
const A = "192.0.2.1";
const B = "192.0.2.2";
const id = (n: number) => `hub-${n}`;

/** `n` hub links joined from `address`, each a new identity unless `known`. */
function joinMany(a: Admission, address: string, n: number, nowMs = T0, known = true): void {
  for (let i = 0; i < n; i++) {
    expect(a.handshakeStarts(address)).toBe(true);
    expect(a.join(address, nowMs, { known, stored: 0 }, undefined).kind).toBe("ok");
  }
}

describe("before any state is kept", () => {
  test(`hub link upgrades: ${L.beforeState.hubAndRelayUpgradesPerMinutePerAddress} a minute per address, then 429`, () => {
    const a = new Admission();
    const limit = L.beforeState.hubAndRelayUpgradesPerMinutePerAddress;
    for (let i = 0; i < limit - 1; i++) expect(a.hubUpgrade(A, T0 + i)).toBe("ok");
    expect(a.hubUpgrade(A, T0 + limit)).toBe("ok"); // at the limit
    expect(a.hubUpgrade(A, T0 + limit + 1)).toBe("rate"); // one above
    expect(a.hubUpgrade(B, T0 + limit + 1)).toBe("ok"); // another address is its own
    // The window slides: the first upgrade leaves it a minute after it came.
    expect(a.hubUpgrade(A, T0 + TIME.MINUTE - 1)).toBe("rate");
    expect(a.hubUpgrade(A, T0 + TIME.MINUTE)).toBe("ok");
  });

  test(`link handshakes: ${L.beforeState.handshakesPerSecondInAll} a second in all, then 503`, () => {
    const a = new Admission();
    const limit = L.beforeState.handshakesPerSecondInAll;
    // Each from its own address, so only the global row counts.
    for (let i = 0; i < limit; i++)
      expect(a.hubUpgrade(`10.0.${i >> 8}.${i & 255}`, T0)).toBe("ok");
    expect(a.hubUpgrade("10.9.9.9", T0)).toBe("busy");
    expect(a.hubUpgrade("10.9.9.9", T0 + TIME.SECOND - 1)).toBe("busy");
    expect(a.hubUpgrade("10.9.9.9", T0 + TIME.SECOND)).toBe("ok");
  });

  test(`phone opens: ${L.beforeState.phoneOpensPerMinutePerAddress} a minute per address, then 429`, () => {
    const a = new Admission();
    const limit = L.beforeState.phoneOpensPerMinutePerAddress;
    for (let i = 0; i < limit; i++) expect(a.phoneUpgrade(A, T0)).toBe("ok");
    expect(a.phoneUpgrade(A, T0)).toBe("rate");
    expect(a.phoneUpgrade(B, T0)).toBe("ok");
  });
});

describe("unauthenticated hub links", () => {
  test(`${L.unauthenticated.perAddress} per address, then refused (4429)`, () => {
    const a = new Admission();
    for (let i = 0; i < L.unauthenticated.perAddress; i++) expect(a.handshakeStarts(A)).toBe(true);
    expect(a.handshakeStarts(A)).toBe(false);
    expect(a.handshakeStarts(B)).toBe(true);
    // One ends: room again.
    a.handshakeEnded(A);
    expect(a.handshakeStarts(A)).toBe(true);
    expect(a.counts.unauthenticated).toBe(L.unauthenticated.perAddress + 1);
  });

  test(`${L.unauthenticated.inAll} in all, then refused`, () => {
    const a = new Admission();
    for (let i = 0; i < L.unauthenticated.inAll; i++) {
      expect(a.handshakeStarts(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`)).toBe(true);
    }
    expect(a.handshakeStarts("172.16.0.1")).toBe(false);
    a.handshakeEnded("10.0.0.0");
    expect(a.handshakeStarts("172.16.0.1")).toBe(true);
  });

  test("a joined link frees its unauthenticated place", () => {
    const a = new Admission();
    joinMany(a, A, L.unauthenticated.perAddress);
    expect(a.counts.unauthenticated).toBe(0);
    expect(a.handshakeStarts(A)).toBe(true);
  });
});

describe("authenticated hub links", () => {
  test(`${L.hubLinks.perAddress} per address; the next is refused, the established kept`, () => {
    const a = new Admission();
    joinMany(a, A, L.hubLinks.perAddress - 1);
    joinMany(a, A, 1); // at the limit
    expect(a.handshakeStarts(A)).toBe(true);
    expect(a.join(A, T0, { known: true, stored: 0 }, undefined)).toEqual({ kind: "full" });
    expect(a.counts.authenticated).toBe(L.hubLinks.perAddress);
    // The refused one still holds an unauthenticated place until its socket closes.
    a.handshakeEnded(A);
    expect(a.counts.unauthenticated).toBe(0);
  });

  test("a link replacing its own identity's is never refused for that link's place", () => {
    const a = new Admission();
    joinMany(a, A, L.hubLinks.perAddress);
    expect(a.handshakeStarts(A)).toBe(true);
    // Same address: the old link's place is reused.
    expect(a.join(A, T0, { known: true, stored: 0 }, A).kind).toBe("ok");
    a.linkClosed(A);
    expect(a.counts.authenticated).toBe(L.hubLinks.perAddress);
    // From another address the per-address count of the new one decides.
    joinMany(a, B, L.hubLinks.perAddress);
    expect(a.handshakeStarts(B)).toBe(true);
    expect(a.join(B, T0, { known: true, stored: 0 }, A)).toEqual({ kind: "full" });
  });

  test(`${L.hubLinks.inAll} in all; the next is refused unless it replaces one`, () => {
    const a = new Admission();
    for (let i = 0; i < L.hubLinks.inAll; i++) {
      const address = `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`;
      a.handshakeStarts(address);
      expect(a.join(address, T0, { known: true, stored: 0 }, undefined).kind).toBe("ok");
    }
    a.handshakeStarts(B);
    expect(a.join(B, T0, { known: true, stored: 0 }, undefined)).toEqual({ kind: "full" });
    expect(a.join(B, T0, { known: true, stored: 0 }, "10.0.0.0").kind).toBe("ok");
  });
});

describe("new hub identities", () => {
  test(`${L.newIdentities.perDayPerAddress} a day per address, until midnight UTC`, () => {
    const a = new Admission();
    for (let i = 0; i < L.newIdentities.perDayPerAddress; i++) {
      a.handshakeStarts(A);
      expect(a.join(A, T0, { known: false, stored: i }, undefined).kind).toBe("ok");
    }
    a.handshakeStarts(A);
    expect(a.join(A, T0, { known: false, stored: 3 }, undefined)).toEqual({
      kind: "newIdentity",
      retryAfterMs: untilNextUtcDay(T0),
      stored: false,
    });
    // A known identity from the same address is not new.
    expect(a.join(A, T0, { known: true, stored: 3 }, undefined).kind).toBe("ok");
    // The next UTC day.
    a.handshakeStarts(A);
    expect(a.join(A, T0 + untilNextUtcDay(T0), { known: false, stored: 3 }, undefined).kind).toBe(
      "ok",
    );
  });

  test(`${L.newIdentities.perHourInAll} an hour in all`, () => {
    const a = new Admission();
    for (let i = 0; i < L.newIdentities.perHourInAll; i++) {
      const address = `10.0.${i >> 8}.${i & 255}`;
      a.handshakeStarts(address);
      expect(a.join(address, T0 + i, { known: false, stored: i }, undefined).kind).toBe("ok");
    }
    a.handshakeStarts(A);
    const refused = a.join(A, T0 + 600, { known: false, stored: 500 }, undefined);
    expect(refused).toEqual({ kind: "newIdentity", retryAfterMs: TIME.HOUR - 600, stored: false });
    // A refused new identity spends nothing of its address's day.
    expect(a.join(A, T0 + TIME.HOUR, { known: false, stored: 500 }, undefined).kind).toBe("ok");
  });

  test(`${L.newIdentities.storedMax} stored: the next is refused, existing hubs are not`, () => {
    const a = new Admission();
    a.handshakeStarts(A);
    expect(
      a.join(A, T0, { known: false, stored: L.newIdentities.storedMax - 1 }, undefined).kind,
    ).toBe("ok");
    a.handshakeStarts(B);
    expect(a.join(B, T0, { known: false, stored: L.newIdentities.storedMax }, undefined)).toEqual({
      kind: "newIdentity",
      retryAfterMs: RELAY_LIMITS.limitWaitMs,
      stored: true,
    });
    expect(
      a.join(B, T0, { known: true, stored: L.newIdentities.storedMax + 1 }, undefined).kind,
    ).toBe("ok");
  });
});

describe("phone streams", () => {
  test(`${L.phoneStreams.perHub} per hub`, () => {
    const a = new Admission();
    for (let i = 0; i < L.phoneStreams.perHub; i++) {
      expect(a.streamOpens(id(1), `10.0.0.${i}`, T0)).toBe("ok");
    }
    expect(a.streamOpens(id(1), "10.0.1.1", T0)).toBe("perHub");
    expect(a.streamOpens(id(2), "10.0.1.1", T0)).toBe("ok");
    a.streamClosed(id(1), "10.0.0.0");
    expect(a.streamOpens(id(1), "10.0.1.2", T0)).toBe("ok");
  });

  test(`${L.phoneStreams.openPerAddress} open per address`, () => {
    const a = new Admission();
    for (let i = 0; i < L.phoneStreams.openPerAddress; i++) {
      expect(a.streamOpens(id(i), A, T0)).toBe("ok");
    }
    expect(a.streamOpens(id(99), A, T0)).toBe("perAddress");
    expect(a.streamOpens(id(99), B, T0)).toBe("ok");
  });

  test(`${L.phoneStreams.inAll} in all`, () => {
    const a = new Admission();
    for (let i = 0; i < L.phoneStreams.inAll; i++) {
      expect(a.streamOpens(id(i >> 4), `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, T0)).toBe(
        "ok",
      );
    }
    expect(a.counts.streams).toBe(L.phoneStreams.inAll);
    expect(a.streamOpens(id(1_000_000), B, T0)).toBe("inAll");
  });

  test(`traffic: ${L.traffic.streamBytesPerHubPerDay} bytes per hub per UTC day, then new streams refused until midnight`, () => {
    const a = new Admission();
    a.carried(id(1), L.traffic.streamBytesPerHubPerDay - 1, T0);
    expect(a.streamOpens(id(1), A, T0)).toBe("ok");
    expect(a.trafficRetryAfter(id(1), T0)).toBe(0);
    a.carried(id(1), 1, T0); // at the budget
    expect(a.streamOpens(id(1), B, T0)).toBe("traffic");
    expect(a.trafficRetryAfter(id(1), T0)).toBe(untilNextUtcDay(T0));
    expect(a.streamOpens(id(2), B, T0)).toBe("ok");
    const midnight = T0 + untilNextUtcDay(T0);
    expect(a.streamOpens(id(1), B, midnight - 1)).toBe("traffic");
    expect(a.streamOpens(id(1), B, midnight)).toBe("ok");
  });
});

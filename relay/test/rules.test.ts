/**
 * The relay's rule values, pinned to docs/m4-design.md section 3: the presence clock and every
 * row of D142's layer 1. A change here is a change of the design, made through the step 0 owner.
 */
import { describe, expect, test } from "bun:test";
import {
  PRESENCE_RULES,
  PROTECTION_LIMITS,
  PSEUDONYM_RULES,
  RELEASES_RULES,
  RETENTION_RULES,
} from "../src/core/rules.ts";

describe("the presence clock", () => {
  test("closes at 75 s, alerts at 180 s, graces at most 10 minutes", () => {
    expect(PRESENCE_RULES).toEqual({
      silentCloseMs: 75_000,
      alertAfterMs: 180_000,
      graceMaxMs: 600_000,
    });
  });

  test("the hub's ping keeps a link well inside the silent close", () => {
    // Two pings fit in the silent close, so one lost ping does not close a live link.
    expect(2 * 30_000).toBeLessThan(PRESENCE_RULES.silentCloseMs);
    expect(PRESENCE_RULES.silentCloseMs).toBeLessThan(PRESENCE_RULES.alertAfterMs);
  });

  test("retention", () => {
    expect(RETENTION_RULES).toEqual({
      establishedHubMs: 7_776_000_000,
      unsettledHubMs: 604_800_000,
      settledAfterDays: 3,
    });
  });
});

describe("D142, layer 1", () => {
  test("every row", () => {
    expect(PROTECTION_LIMITS).toEqual({
      ipv6PrefixBits: 64,
      beforeState: {
        hubAndRelayUpgradesPerMinutePerAddress: 10,
        phoneOpensPerMinutePerAddress: 30,
        handshakesPerSecondInAll: 500,
      },
      unauthenticated: { perAddress: 4, inAll: 2000, message3WithinMs: 10_000, queuedMessages: 1 },
      hubLinks: { perAddress: 8, inAll: 20_000 },
      phoneStreams: { perHub: 16, openPerAddress: 8, inAll: 40_000 },
      newIdentities: { perDayPerAddress: 3, perHourInAll: 500, storedMax: 200_000 },
      memory: {
        phoneMessageBytes: 65_535,
        phoneMessagesInHand: 1,
        pendingToPhoneBytes: 262_144,
        pendingToHubLinkBytes: 4_194_304,
        rosterBytes: 131_072,
        rateTableAddresses: 200_000,
      },
      slowClients: {
        idlePhoneStreamMs: 90_000,
        silentHubLinkMs: 75_000,
        unfinishedHandshakeMs: 10_000,
      },
      traffic: { streamBytesPerHubPerDay: 500_000_000 },
      pushes: {
        perHubPerWindow: 60,
        windowMs: 600_000,
        perHubPerDay: 1000,
        perRelayKeyPerDay: 10_000,
        operatorAlertFraction: 0.8,
      },
      releases: {
        downloadsPerFilePerIdentityPerDay: 3,
        wholeFilesPerAddressPerDay: 3,
        filesPerRelayKeyPerDay: 10,
        dailyEgressBytes: 100_000_000_000,
      },
      names: { perEstablishedIdentity: 1, updatesPerDay: 20 },
    });
  });

  test("the pseudonym and the releases role", () => {
    expect(PSEUDONYM_RULES).toEqual({ bytes: 8, secretLifetimeMs: 86_400_000 });
    expect(RELEASES_RULES).toEqual({ refreshMs: 600_000 });
  });
});

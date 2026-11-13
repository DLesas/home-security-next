/**
 * The sensor rules of hub-design.md section 8 as pure functions, at their boundaries: the reply
 * rate at each margin (10 dB ‡, 3 dB ‡ hysteresis, at most 3 steps faster, 6 hours ‡, fewer than
 * 10 samples, flag bit 7), D107's n and its poor link, each silence threshold, the effective
 * interval's floors at SF11 and SF12, and the settings version: what bumps it, its wrap, and the
 * 16 kept with their reply rate and move.
 */
import { describe, expect, test } from "bun:test";
import { ArmState, NEXT_SETTING_STAYS } from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES as rules } from "../../../src/core/model/rules.ts";
import { deviceId } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import { effectiveIntervalMs } from "../../../src/core/sensors/radio.ts";
import {
  boundReplyRate,
  chooseReplyRate,
  demodulationLimitDb,
  fallBackReplyRate,
  percentile,
} from "../../../src/core/sensors/reply-rate.ts";
import {
  applyChange,
  carriedSettings,
  decodeHistory,
  keptVersion,
  nextVersion,
} from "../../../src/core/sensors/settings.ts";
import {
  isPoorLink,
  lossOverDays,
  missedHeartbeats,
  silentAt,
} from "../../../src/core/sensors/silence.ts";
import { sensorRow } from "../../scenarios/sensors/bench.ts";

const MINUTE = 60_000;

describe("the reply rate (section 8)", () => {
  // Reply power 22 dBm against the sensor's 14: the downlink estimate is s + 8 dB.
  const choose = (s: number, sendRate: number, current: number, fasterAllowed = true, count = 20) =>
    chooseReplyRate(rules, {
      snrDb: Array<number>(count).fill(s),
      sendRate,
      current,
      replyPowerDbm: 22,
      fasterAllowed,
    });

  test("the demodulation limit is −7.5 − 2.5 × (F − 7) dB", () => {
    expect([5, 4, 3, 2, 1, 0].map((r) => demodulationLimitDb(rules, r))).toEqual([
      -7.5, -10, -12.5, -15, -17.5, -20,
    ]);
  });

  test("the 10th percentile, by nearest rank", () => {
    expect(percentile([5, 1, 4, 2, 3, 9, 8, 7, 6, 10], 10)).toBe(1);
    expect(
      percentile(
        Array.from({ length: 20 }, (_, i) => i),
        10,
      ),
    ).toBe(1);
  });

  test("a rate holds with its limit 10 dB ‡ below the estimate, exactly at the margin", () => {
    // From DR2, a current DR5 holds when s + 8 − 10 ≥ −7.5: s ≥ −5.5.
    expect(choose(-5.5, 2, 5)).toBe(5);
    expect(choose(-5.51, 2, 5)).toBe(4);
    // DR4 holds down to s = −8, DR3 to −10.5; below that, the sending rate.
    expect(choose(-8, 2, 5)).toBe(4);
    expect(choose(-8.01, 2, 5)).toBe(3);
    expect(choose(-10.51, 2, 5)).toBe(2);
  });

  test("it goes faster only with 3 dB ‡ to spare, and only when allowed (6 hours ‡)", () => {
    // From DR2 with the setting at DR2: DR5 needs s ≥ −2.5 with the spare.
    expect(choose(-2.5, 2, 2)).toBe(5);
    expect(choose(-2.51, 2, 2)).toBe(4);
    expect(choose(-2.5, 2, 2, false)).toBe(2);
    // A setting that still holds without the spare is kept.
    expect(choose(-5.5, 2, 4)).toBe(4);
  });

  test("at most 3 steps faster than the sending rate, never slower than it", () => {
    expect(choose(30, 0, 0)).toBe(3);
    expect(choose(-40, 0, 3)).toBe(0);
    expect(boundReplyRate(rules, 2, 0)).toBe(2);
    expect(boundReplyRate(rules, 2, 5)).toBe(5);
    expect(boundReplyRate(rules, 1, 5)).toBe(4);
  });

  test("with fewer than 10 samples the setting stays as it is", () => {
    expect(choose(30, 2, 2, true, 9)).toBe(2);
    expect(choose(30, 2, 2, true, 10)).toBe(5);
  });

  test("with today's one rate at DR5 nothing is faster", () => {
    expect(choose(30, 5, 5)).toBe(5);
  });

  test("flag bit 7 steps one slower ‡, never below the sending rate", () => {
    expect(fallBackReplyRate(rules, 2, 5)).toBe(4);
    expect(fallBackReplyRate(rules, 2, 2)).toBe(2);
  });
});

describe("silence (D107)", () => {
  const I = 3 * MINUTE;
  test("home B: p = 1 % gives n = 4, p = 0.2 % gives n = 3 (H = 175,200, S = 30)", () => {
    expect(missedHeartbeats(rules, { received: 990, expected: 1000 }, I, 30)).toBe(4);
    expect(missedHeartbeats(rules, { received: 998, expected: 1000 }, I, 30)).toBe(3);
  });

  test("n is the smallest from 3 to 8 with H × pⁿ ≤ 1 ÷ S, else 8; 5 ‡ before a day of data", () => {
    expect(missedHeartbeats(rules, { received: 1000, expected: 1000 }, I, 30)).toBe(3);
    expect(missedHeartbeats(rules, { received: 600, expected: 1000 }, I, 30)).toBe(8);
    expect(missedHeartbeats(rules, undefined, I, 30)).toBe(5);
    // H × p⁵ at p = 5 % with one sensor: 175,200 × 3.1e-7 = 0.054 ≤ 1; p⁴ gives 1.095 > 1.
    expect(missedHeartbeats(rules, { received: 950, expected: 1000 }, I, 1)).toBe(5);
  });

  test("at the boundary: H × p³ just under 1 ÷ S gives 3, just over gives 4", () => {
    const H = 175_200;
    const expected = 10_000_000;
    // p just below and just above (1 ÷ H)^(1/3), for one sensor, as whole packet counts.
    const pAt = (1 / H) ** (1 / 3);
    const under = { received: expected - Math.floor(pAt * expected) + 1, expected };
    const over = { received: expected - Math.ceil(pAt * expected) - 1, expected };
    expect(H * (1 - under.received / expected) ** 3).toBeLessThan(1);
    expect(H * (1 - over.received / expected) ** 3).toBeGreaterThan(1);
    expect(missedHeartbeats(rules, under, I, 1)).toBe(3);
    expect(missedHeartbeats(rules, over, I, 1)).toBe(4);
  });

  test("a loss above 20 % is a poor link; 20 % is not", () => {
    expect(isPoorLink(rules, { received: 800, expected: 1000 })).toBe(false);
    expect(isPoorLink(rules, { received: 799, expected: 1000 })).toBe(true);
    expect(isPoorLink(rules, undefined)).toBe(false);
  });

  test("the last 7 whole days count, not today and not older", () => {
    const rows = [5, 6, 7, 8, 9, 10, 11, 12, 13].map((day) => ({
      deviceId: deviceId(3),
      day,
      received: day,
      expected: 20,
    }));
    expect(lossOverDays(rules, rows, 13)).toEqual({
      received: 6 + 7 + 8 + 9 + 10 + 11 + 12,
      expected: 140,
    });
    expect(
      lossOverDays(
        rules,
        rows.filter((r) => r.day === 13),
        13,
      ),
    ).toBeUndefined();
  });

  test("silent n × I + 30 s ‡ after it was last heard", () => {
    expect(silentAt(rules, mono(1_000_000), 4, I)).toBe(mono(1_000_000 + (4 * I + 30_000) * 1000));
  });

  test("the interval keeps its setting, at least 3 minutes at SF11 and 5 at SF12 (§7)", () => {
    expect(effectiveIntervalMs(12, 5)).toBe(3 * MINUTE);
    expect(effectiveIntervalMs(4, 2)).toBe(MINUTE);
    expect(effectiveIntervalMs(4, 1)).toBe(3 * MINUTE);
    expect(effectiveIntervalMs(12, 0)).toBe(5 * MINUTE);
    expect(effectiveIntervalMs(24, 0)).toBe(6 * MINUTE);
  });
});

describe("settings versions (D72, section 6)", () => {
  const row = sensorRow(deviceId(3), 5, { version: 7 });

  test("a change to a carried setting bumps the version and keeps it with its reply rate and move", () => {
    const changed = applyChange(row, { countdownS: 45, replyRate: 5 }, 2);
    expect(changed.bumped).toBe(true);
    expect(changed.config.version).toBe(8);
    expect(keptVersion(changed.config, 8)).toEqual({ version: 8, replyRate: 5, move: 2 });
    expect(keptVersion(changed.config, 7)).toEqual({ version: 7, replyRate: 5, move: 0 });
  });

  test("nothing carried changed: no bump (a waiting state sends 'not armed' like disarmed)", () => {
    expect(applyChange(row, { countdownS: row.countdownS }, 0).bumped).toBe(false);
    expect(applyChange(row, { arm: ArmState.WaitsForCloseAfterArming }, 0).bumped).toBe(false);
    expect(applyChange(row, { arm: ArmState.Armed }, 0).bumped).toBe(true);
    expect(applyChange(row, { replyRateFixed: true, moveConfirmed: 3 }, 0).bumped).toBe(false);
  });

  test("every carried setting bumps it", () => {
    const changes = [
      { countdownS: 0 },
      { heartbeatUnits: 20 },
      { linkCheckEvery: 3 },
      { sendRate: 2 },
      { replyRate: 4 },
      { correctionUnits: 12 },
      { nextChannel: 2 },
      { nextRate: 2 },
      { arm: ArmState.Armed },
    ] as const;
    for (const change of changes) expect(applyChange(row, change, 0).bumped).toBe(true);
    expect(carriedSettings({ ...row, nextChannel: NEXT_SETTING_STAYS, nextRate: 2 })).toMatchObject(
      { nextChannel: undefined, nextRate: 2 },
    );
  });

  test("versions run 1 to 255 and wrap to 1, never 0; the last 16 are kept", () => {
    expect(nextVersion(254)).toBe(255);
    expect(nextVersion(255)).toBe(1);
    let config = row;
    for (let i = 0; i < 20; i++) config = applyChange(config, { countdownS: i }, 0).config;
    const kept = decodeHistory(config.versionHistory);
    expect(kept).toHaveLength(16);
    expect(kept[0]?.version).toBe(27);
    expect(kept.at(-1)?.version).toBe(12);
    expect(keptVersion(config, 11)).toBeUndefined();
  });
});

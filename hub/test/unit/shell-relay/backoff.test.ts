/**
 * The relay link's waits (docs/m4-design.md section 4, "Back-off"): 1, 2, 4, 8, 16, 32 s, then
 * every 60 s ‡, each ±20% ‡, reset once a link lasted 60 s ‡; and the fixed waits after the
 * relay's "wait" closes. Every step and both ends of the jitter, exactly.
 */
import { describe, expect, test } from "bun:test";
import { RELAY_BACKOFF, RELAY_LIMITS } from "@hsn/protocol/relay";
import { Backoff, waitAfterClose } from "../../../src/shell/relay/backoff.ts";

describe("the back-off", () => {
  test("its steps, with a draw of 0.5: 1, 2, 4, 8, 16, 32 s, then every 60 s", () => {
    const backoff = new Backoff();
    const waits = Array.from({ length: 9 }, () => backoff.next(0.5));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(backoff.failures).toBe(9);
  });

  test("the jitter at its edges: 80% at a draw of 0, just under 120% just under 1", () => {
    const low = new Backoff();
    expect([low.next(0), low.next(0)]).toEqual([800, 1600]);
    const high = new Backoff();
    expect(high.next(0.999_999)).toBe(1200);
    expect(high.next(0.75)).toBe(2200);
    const capped = new Backoff();
    for (let i = 0; i < 6; i++) capped.next(0.5);
    expect(capped.next(0)).toBe(48000);
    expect(capped.next(0.999_999)).toBe(72000);
  });

  test("a draw outside [0, 1) is no jitter", () => {
    const backoff = new Backoff();
    expect([backoff.next(1), backoff.next(-0.1), backoff.next(Number.NaN)]).toEqual([
      1000, 2000, 4000,
    ]);
  });

  test("reset starts the steps again", () => {
    const backoff = new Backoff();
    backoff.next(0.5);
    backoff.next(0.5);
    backoff.reset();
    expect(backoff.failures).toBe(0);
    expect(backoff.next(0.5)).toBe(1000);
  });

  test("a link lasted long enough at 60 s, not a millisecond before", () => {
    const backoff = new Backoff();
    expect(backoff.lasted(RELAY_BACKOFF.resetAfterMs - 1)).toBe(false);
    expect(backoff.lasted(RELAY_BACKOFF.resetAfterMs)).toBe(true);
  });
});

describe("the waits after the relay's 'wait' closes", () => {
  test("replaced: 10 minutes, whatever a limit said", () => {
    expect(waitAfterClose(4001, undefined)).toBe(RELAY_LIMITS.identityInUseWaitMs);
    expect(waitAfterClose(4001, 5)).toBe(600_000);
  });

  test("over a limit: the limit's retryAfterMs, else 10 minutes", () => {
    expect(waitAfterClose(4429, 12_345)).toBe(12_345);
    expect(waitAfterClose(4429, 0)).toBe(0);
    expect(waitAfterClose(4429, undefined)).toBe(RELAY_LIMITS.limitWaitMs);
  });

  test("no shared version: 10 minutes, a limit's retry ignored", () => {
    expect(waitAfterClose(4426, 7)).toBe(600_000);
  });
});

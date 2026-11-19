/** Tests the hosted timing policy with measured times supplied by a stand-in scenario. */
import { expect, test } from "bun:test";
import { ResultAsync } from "neverthrow";
import { retryHostedTiming } from "./hosted-timing.ts";

/** A turn with a 20 ms limit, optionally followed by a clean attempt. */
function scenario(wallMs: number, cpuMs: number, passAt = Number.POSITIVE_INFINITY) {
  const attempts: number[] = [];
  const asserted: number[] = [];
  return {
    attempts,
    asserted,
    run: (attempt: number) => {
      attempts.push(attempt);
      return {
        misses: attempt >= passAt ? [] : [{ label: "turn", wallMs, cpuMs, limitMs: 20 }],
        assertTiming: () => {
          asserted.push(attempt);
          expect(attempt).toBeGreaterThanOrEqual(passAt);
        },
      };
    },
  };
}

/** Reads the assertion error from a failed timing scenario. */
async function failureOf(run: Promise<void>): Promise<string> {
  const result = await ResultAsync.fromPromise(run, (reason: unknown) => reason);
  return String(result._unsafeUnwrapErr());
}

test("thread CPU over the limit fails without retrying", async () => {
  const { run, attempts, asserted } = scenario(40, 21, 2);
  expect(await failureOf(retryHostedTiming(run, true))).toContain("21.0 ms thread CPU");
  expect(attempts).toEqual([1]);
  expect(asserted).toEqual([]);
});

test("a wall-only miss retries the whole scenario and asserts timing only on the clean attempt", async () => {
  const { run, attempts, asserted } = scenario(40, 20, 2);
  await retryHostedTiming(run, true);
  expect(attempts).toEqual([1, 2]);
  expect(asserted).toEqual([2]);
});

test("three paused attempts fail and report the wall and CPU times of each", async () => {
  const { run, attempts, asserted } = scenario(40, 5);
  expect(await failureOf(retryHostedTiming(run, true))).toMatch(
    /the runner paused the process in all three attempts\n(?:attempt [123]: turn: 40\.0 ms wall, 5\.0 ms thread CPU \(limit 20 ms\)\n?){3}/u,
  );
  expect(attempts).toEqual([1, 2, 3]);
  expect(asserted).toEqual([]);
});

test("a developer's machine asserts the first attempt's wall time", async () => {
  const { run, attempts, asserted } = scenario(40, 5, 2);
  expect(await failureOf(retryHostedTiming(run, false))).toContain("toBeGreaterThanOrEqual");
  expect(attempts).toEqual([1]);
  expect(asserted).toEqual([1]);
});

test("a failed scenario assertion is never retried", async () => {
  let attempts = 0;
  const failure = await failureOf(
    retryHostedTiming(() => {
      attempts += 1;
      expect.unreachable("fixture failed");
    }, true),
  );
  expect(failure).toContain("fixture failed");
  expect(attempts).toBe(1);
});

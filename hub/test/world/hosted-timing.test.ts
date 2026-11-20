/** Tests the hosted timing policy with measured times supplied by a stand-in scenario. */
import { expect, spyOn, test } from "bun:test";
import { ResultAsync } from "neverthrow";
import {
  CREATE_WAIT_LIMIT_MS,
  type FileCall,
  retryHostedTiming,
  type TimingMiss,
} from "./hosted-timing.ts";

/** A turn with a 20 ms limit, optionally followed by a clean attempt. */
function scenario(wallMs: number, cpuMs: number, passAt = Number.POSITIVE_INFINITY) {
  return scenarioOf([{ label: "turn", wallMs, cpuMs, limitMs: 20 }], passAt);
}

/** A piece of the staging test (limit 250 ms) whose longest file call, a create unless named, took `ms`. */
function staged(wallMs: number, cpuMs: number, ms: number, name = "openSync"): TimingMiss {
  const call: FileCall =
    name === "openSync"
      ? { name, path: "web/f104.js", create: true, ms }
      : { name, path: "web", create: false, ms };
  return { label: "copy", wallMs, cpuMs, limitMs: 250, call };
}

/** These misses each attempt, optionally followed by a clean attempt. */
function scenarioOf(misses: readonly TimingMiss[], passAt = Number.POSITIVE_INFINITY) {
  const attempts: number[] = [];
  const asserted: number[] = [];
  return {
    attempts,
    asserted,
    run: (attempt: number) => {
      attempts.push(attempt);
      return {
        misses: attempt >= passAt ? [] : misses,
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

/** Runs a scenario with the log captured: what the helper printed, and the failure if any. */
async function logged(run: Promise<void>): Promise<{ log: string; failure: string | undefined }> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const result = await ResultAsync.fromPromise(run, (reason: unknown) => reason);
  spy.mockRestore();
  return { log: lines.join("\n"), failure: result.isErr() ? String(result.error) : undefined };
}

test("a wait in one file create, the rest within the limit, passes on a hosted runner at once and says what it measured", async () => {
  // The failing run's first attempt: 568.2 ms, 505.4 of it in one create.
  const { run, attempts, asserted } = scenarioOf([staged(568.2, 0, 505.4)]);
  const { log, failure } = await logged(retryHostedTiming(run, true));
  expect(failure).toBeUndefined();
  expect(attempts).toEqual([1]);
  expect(asserted).toEqual([]);
  expect(log).toContain(
    "waited in one file create, the rest of it within the limit, in attempt 1: copy: 568.2 ms wall, 0.0 ms thread CPU (limit 250 ms); 505.4 ms of it in one file create (web/f104.js), 62.8 ms outside it",
  );
  expect(log).not.toContain("paused");
});

test("a create may wait exactly the tolerated time on a hosted runner, and not a millisecond more", async () => {
  const at = scenarioOf([staged(CREATE_WAIT_LIMIT_MS + 100, 0, CREATE_WAIT_LIMIT_MS)]);
  expect((await logged(retryHostedTiming(at.run, true))).failure).toBeUndefined();
  const over = scenarioOf([staged(CREATE_WAIT_LIMIT_MS + 101, 0, CREATE_WAIT_LIMIT_MS + 1)], 2);
  const { failure } = await logged(retryHostedTiming(over.run, true));
  expect(failure).toContain(
    `one file call waited, which a hosted runner allows only for a file create of at most ${CREATE_WAIT_LIMIT_MS} ms: copy: 851.0 ms wall, 0.0 ms thread CPU (limit 250 ms); 751.0 ms of it in one file create (web/f104.js), 100.0 ms outside it`,
  );
  expect(failure).not.toContain("paused");
  expect(over.attempts).toEqual([1]);
  expect(over.asserted).toEqual([]);
});

test("the rest of the piece must be under the limit: at the limit it is a pause, retried, and the create is still reported", async () => {
  const under = scenarioOf([staged(749.9, 0, 500)]);
  expect((await logged(retryHostedTiming(under.run, true))).failure).toBeUndefined();
  const { run, attempts, asserted } = scenarioOf([staged(750, 0, 500)]);
  const { log, failure } = await logged(retryHostedTiming(run, true));
  expect(attempts).toEqual([1, 2, 3]);
  expect(asserted).toEqual([]);
  expect(log).toContain(
    "Retrying hosted timing because the runner paused the process in attempt 1",
  );
  expect(failure).toMatch(
    /the runner paused the process in all three attempts\n(?:attempt [123]: copy: 750\.0 ms wall, 0\.0 ms thread CPU \(limit 250 ms\); 500\.0 ms of it in one file create \(web\/f104\.js\), 250\.0 ms outside it\n?){3}/u,
  );
});

test("thread CPU over the limit fails even when a create waited", async () => {
  const { run, attempts, asserted } = scenarioOf([staged(600, 251, 300)], 2);
  const { failure } = await logged(retryHostedTiming(run, true));
  expect(failure).toContain("251.0 ms thread CPU");
  expect(attempts).toEqual([1]);
  expect(asserted).toEqual([]);
});

test("a pause beside a create's wait in the same attempt is retried, and only the pause is called one", async () => {
  const { run, attempts, asserted } = scenarioOf(
    [staged(568.2, 0, 505.4), { label: "hash", wallMs: 400, cpuMs: 0, limitMs: 250 }],
    2,
  );
  const { log, failure } = await logged(retryHostedTiming(run, true));
  expect(failure).toBeUndefined();
  expect(attempts).toEqual([1, 2]);
  expect(asserted).toEqual([2]);
  expect(log).toContain(
    "the runner paused the process in attempt 1: hash: 400.0 ms wall, 0.0 ms thread CPU (limit 250 ms) (and waited in one file create: copy: 568.2 ms wall",
  );
});

test("a wait in one file call that is not a create fails at once on a hosted runner, naming the call, and is not called a pause", async () => {
  const { run, attempts, asserted } = scenarioOf([staged(568.2, 0, 505.4, "mkdirSync")], 2);
  const { log, failure } = await logged(retryHostedTiming(run, true));
  expect(failure).toContain(
    `one file call waited, which a hosted runner allows only for a file create of at most ${CREATE_WAIT_LIMIT_MS} ms: copy: 568.2 ms wall, 0.0 ms thread CPU (limit 250 ms); 505.4 ms of it in one mkdirSync (web), 62.8 ms outside it`,
  );
  expect(`${log}${failure}`).not.toContain("paused");
  expect(attempts).toEqual([1]);
  expect(asserted).toEqual([]);
});

test("a developer's machine asserts the wall time even when the time was in one create", async () => {
  const { run, attempts, asserted } = scenarioOf([staged(568.2, 0, 505.4)], 2);
  expect((await logged(retryHostedTiming(run, false))).failure).toContain("toBeGreaterThanOrEqual");
  expect(attempts).toEqual([1]);
  expect(asserted).toEqual([1]);
});

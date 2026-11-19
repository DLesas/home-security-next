/** Port collision decisions against real child processes and a held loopback port. */
import { afterEach, expect, test } from "bun:test";
import { ResultAsync } from "neverthrow";
import type { Server } from "bun";
import { endProcesses, spawnTracked } from "./processes.ts";
import { freePort, Output, startWithPortRetry } from "./test-ports.ts";

let held: Server<undefined> | undefined;

afterEach(async () => {
  await endProcesses();
  await held?.stop(true);
  held = undefined;
});

/** Occupies a port so a child trying to open it gets the same Bun error as the real hub. */
function occupyPort(): number {
  held = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  return held.port ?? 0;
}

/** Runs a child that either opens the given address or reports an unrelated startup error. */
function listenInChild(port: number, unrelatedError = false) {
  const script = unrelatedError
    ? 'process.stderr.write("configuration was invalid\\n"); process.exitCode = 1;'
    : `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response() });
       process.stderr.write("listener started\\n");`;
  const proc = spawnTracked([process.execPath, "-e", script], {
    stderr: "pipe",
    stdout: "ignore",
  });
  const out = new Output(proc.stderr);
  return { proc, out, port, ports: [port], ready: () => out.text.includes("listener started") };
}

const options = { label: "the test child started", timeoutMs: 2000 };

test("a busy first port is replaced and the child binds the new port", async () => {
  const occupied = occupyPort();
  const attempted: number[] = [];
  const started = await startWithPortRetry(
    async () => {
      const port = attempted.length === 0 ? occupied : await freePort();
      attempted.push(port);
      return listenInChild(port);
    },
    { ...options, pickAgain: true },
  );
  expect(attempted).toEqual([occupied, started.port]);
  expect(started.port).not.toBe(occupied);
  expect(await (await fetch(`http://127.0.0.1:${started.port}`)).text()).toBe("");
});

test("an occupied established port fails once", async () => {
  const port = occupyPort();
  let attempts = 0;
  const result = await ResultAsync.fromPromise(
    startWithPortRetry(
      () => {
        attempts += 1;
        return listenInChild(port);
      },
      { ...options, pickAgain: false },
    ),
    (error: unknown) => String(error),
  );
  expect(result._unsafeUnwrapErr()).toContain(`Is port ${port} in use?`);
  expect(attempts).toBe(1);
});

test("an unrelated startup failure fails once even when the port could be replaced", async () => {
  let attempts = 0;
  const result = await ResultAsync.fromPromise(
    startWithPortRetry(
      () => {
        attempts += 1;
        return listenInChild(0, true);
      },
      { ...options, pickAgain: true },
    ),
    (error: unknown) => String(error),
  );
  expect(result._unsafeUnwrapErr()).toContain("configuration was invalid");
  expect(attempts).toBe(1);
});

test("the initial bind is followed by at most five retries", async () => {
  const port = occupyPort();
  let attempts = 0;
  const result = await ResultAsync.fromPromise(
    startWithPortRetry(
      () => {
        attempts += 1;
        return listenInChild(port);
      },
      { ...options, pickAgain: true },
    ),
    (error: unknown) => String(error),
  );
  expect(result._unsafeUnwrapErr()).toContain(`Is port ${port} in use?`);
  expect(attempts).toBe(6);
});

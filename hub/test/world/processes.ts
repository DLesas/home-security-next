/**
 * Every hub process a test starts is ended, whatever happens to the test: a failed `expect`
 * before its own stop, a timeout, a throw. `spawnTracked` notes each process; `endProcesses`,
 * which every such test file calls in its `afterAll` before it removes its folders, kills what is
 * still running with SIGKILL and waits for it; the runner's own exit does the same for anything
 * left, so a process never outlives `bun test`.
 */
import type { Subprocess } from "bun";
import { join } from "node:path";

const live = new Set<Subprocess>();

/** Notes a process, so `endProcesses` or the runner's exit ends it if it is still running. */
function track<P extends Subprocess>(process: P): P {
  live.add(process);
  void process.exited.then(() => {
    live.delete(process);
  });
  return process;
}

/** `Bun.spawn`, with the process ended by `endProcesses` or the runner's exit if still running. */
export const spawnTracked: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
  track(Bun.spawn(...args))) as typeof Bun.spawn;

/** Starts a checkout hub with a private channel for the stop event WinSW normally delivers. */
export function spawnTestHub<Output extends "inherit" | "pipe" | "ignore">(
  args: readonly string[],
  stderr: Output,
  env = process.env,
) {
  const windows = process.platform === "win32";
  const preload = windows ? ["--preload", join(import.meta.dir, "console-stop.ts")] : [];
  return spawnTracked([process.execPath, ...preload, ...args], {
    stdout: "ignore",
    stderr,
    env,
    ...(windows ? { ipc: () => undefined } : {}),
  });
}

/** Windows has no process-directed SIGTERM. Deliver the console event to this test hub alone. */
export function stopTestHub(hub: Subprocess): void {
  if (hub.exitCode !== null) return;
  if (process.platform === "win32") hub.send("console-stop");
  else hub.kill("SIGTERM");
}

/** The checkout hub runs under the test account. The installed CLI expects the service account. */
export const testCli =
  process.platform === "win32"
    ? join(import.meta.dir, "checkout-cli.ts")
    : join(import.meta.dir, "..", "..", "cli", "hsn.ts");

/** Kills every tracked process still running, and waits until each has exited. */
export async function endProcesses(): Promise<void> {
  const running = [...live];
  for (const process of running) process.kill(9);
  await Promise.all(running.map((process) => process.exited));
}

process.on("exit", () => {
  for (const running of live) running.kill(9);
});

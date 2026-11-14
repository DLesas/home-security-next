/**
 * Every hub process a test starts is ended, whatever happens to the test: a failed `expect`
 * before its own stop, a timeout, a throw. `spawnTracked` notes each process; `endProcesses`,
 * which every such test file calls in its `afterAll` before it removes its folders, kills what is
 * still running with SIGKILL and waits for it; the runner's own exit does the same for anything
 * left, so a process never outlives `bun test`.
 */
import type { Subprocess } from "bun";

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

/** Kills every tracked process still running, and waits until each has exited. */
export async function endProcesses(): Promise<void> {
  const running = [...live];
  for (const process of running) process.kill(9);
  await Promise.all(running.map((process) => process.exited));
}

process.on("exit", () => {
  for (const running of live) running.kill(9);
});

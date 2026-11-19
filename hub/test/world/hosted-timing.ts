/** Retry a timing scenario when a shared runner leaves too little time on the test's thread. */
import { expect } from "bun:test";

export const HOSTED_TIMING = process.env.GITHUB_ACTIONS === "true";

export interface TimingMiss {
  readonly label: string;
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly limitMs: number;
}

interface TimingAttempt {
  readonly misses: readonly TimingMiss[];
  readonly assertTiming: () => void;
}

/** Records the wall and thread CPU time of one synchronous piece of work. */
export function timePiece<T>(run: () => T, measureCpu = HOSTED_TIMING) {
  const cpuStart = measureCpu ? process.threadCpuUsage() : undefined;
  const start = performance.now();
  const value = run();
  const wallMs = performance.now() - start;
  const cpu = cpuStart === undefined ? undefined : process.threadCpuUsage(cpuStart);
  return { value, wallMs, cpuMs: cpu === undefined ? Number.NaN : (cpu.user + cpu.system) / 1000 };
}

/** Runs all ordinary assertions each attempt and retries only verified wall-time misses on CI. */
export async function retryHostedTiming(
  run: (attempt: number) => TimingAttempt | Promise<TimingAttempt>,
  hosted = HOSTED_TIMING,
): Promise<void> {
  const paused: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { misses, assertTiming } = await run(attempt);
    if (!hosted || misses.length === 0) {
      assertTiming();
      return;
    }
    const measurements = misses.map(
      ({ label, wallMs, cpuMs, limitMs }) =>
        `${label}: ${wallMs.toFixed(1)} ms wall, ${cpuMs.toFixed(1)} ms thread CPU (limit ${limitMs} ms)`,
    );
    const slow = misses.findIndex(({ cpuMs, limitMs }) => cpuMs > limitMs);
    expect(slow, measurements[slow]).toBe(-1);
    if (
      misses.some(
        ({ wallMs, cpuMs, limitMs }) =>
          !(Number.isFinite(wallMs) && wallMs > limitMs && Number.isFinite(cpuMs)),
      )
    ) {
      assertTiming();
      return;
    }
    const report = `attempt ${attempt}: ${measurements.join("; ")}`;
    paused.push(report);
    if (attempt < 3)
      console.log(`Retrying hosted timing because the runner paused the process in ${report}`);
  }
  expect.unreachable(`the runner paused the process in all three attempts\n${paused.join("\n")}`);
}

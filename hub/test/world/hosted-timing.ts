/**
 * Retry a timing scenario when a shared runner leaves too little time on the test's thread, and
 * tell a piece that waited in one file call from one the runner paused.
 *
 * On a hosted runner a piece over its limit fails at once if its thread CPU time is over the limit
 * (the piece did too much work). A piece whose wall time is over the limit but whose thread CPU is
 * within it is retried, the whole scenario, up to three times: the runner paused the process.
 *
 * A caller that times its file calls may say which call took longest in the piece (`call`). When
 * that one call holds all of the time over the limit (the rest of the piece is within it), the
 * miss is not a pause and is reported as the wait in that call. On the hosted Windows runners a
 * create that gives its folder's index a new block (in a folder of short names, its 8th file, then
 * about every 21st from the 42nd) can wait, the thread doing nothing, for reasons not known: 311
 * to 541 ms in eight attempts across three runs of the Check workflow, at the same file, and in two
 * or three attempts of a run in a row, so a retry does not help. Such a miss passes on a hosted
 * runner, with what was measured in the log, only if the call is a file create, the rest of the
 * piece is within the limit, its thread CPU is within it, and the create waited at most
 * `CREATE_WAIT_LIMIT_MS`. A longer create, or a wait in one call of another kind, fails at once,
 * naming the call. Off a hosted runner every miss fails, as before.
 */
import { expect } from "bun:test";

export const HOSTED_TIMING = process.env.GITHUB_ACTIONS === "true";

/**
 * The longest a hosted runner's file create may wait and still pass: the 541 ms seen, and some
 * room. Section 3's 20 ms is the opt-in timing test's, which this never applies to.
 */
export const CREATE_WAIT_LIMIT_MS = 750;

/** One file call the caller timed: which, on what, whether it made a file, and how long it took. */
export interface FileCall {
  readonly name: string;
  readonly path: string;
  readonly create: boolean;
  readonly ms: number;
}

export interface TimingMiss {
  readonly label: string;
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly limitMs: number;
  /** The piece's longest file call, when the caller times its file calls. */
  readonly call?: FileCall;
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

/** What was measured for one miss, in the words of the log. */
function measured({ label, wallMs, cpuMs, limitMs, call }: TimingMiss): string {
  const times = `${label}: ${wallMs.toFixed(1)} ms wall, ${cpuMs.toFixed(1)} ms thread CPU (limit ${limitMs} ms)`;
  if (call === undefined) return times;
  const what = call.create ? "file create" : call.name;
  return `${times}; ${call.ms.toFixed(1)} ms of it in one ${what} (${call.path}), ${(wallMs - call.ms).toFixed(1)} ms outside it`;
}

/** Whether the time over the limit is all in one call: the rest of the piece within the limit. */
function inOneCall({ wallMs, limitMs, call }: TimingMiss): boolean {
  return call !== undefined && Number.isFinite(call.ms) && wallMs - call.ms < limitMs;
}

/** Whether a hosted runner lets a miss pass: all of it in one create of a tolerated length. */
function waitedInCreate(miss: TimingMiss): boolean {
  return inOneCall(miss) && miss.call?.create === true && miss.call.ms <= CREATE_WAIT_LIMIT_MS;
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
    const measurements = misses.map(measured);
    const slow = misses.findIndex(({ cpuMs, limitMs }) => cpuMs > limitMs);
    expect(slow, measurements[slow]).toBe(-1);
    const oneCall = misses.findIndex((miss) => inOneCall(miss) && !waitedInCreate(miss));
    if (oneCall !== -1)
      expect.unreachable(
        `one file call waited, which a hosted runner allows only for a file create of at most ${CREATE_WAIT_LIMIT_MS} ms: ${measurements[oneCall]}`,
      );
    if (
      misses.some(
        ({ wallMs, cpuMs, limitMs }) =>
          !(Number.isFinite(wallMs) && wallMs > limitMs && Number.isFinite(cpuMs)),
      )
    ) {
      assertTiming();
      return;
    }
    const waited = misses.filter(waitedInCreate).map(measured);
    const unexplained = misses.filter((miss) => !waitedInCreate(miss)).map(measured);
    if (unexplained.length === 0) {
      console.log(
        `Passing hosted timing because each piece over its limit waited in one file create, the rest of it within the limit, in attempt ${attempt}: ${waited.join("; ")}`,
      );
      return;
    }
    const report =
      `attempt ${attempt}: ${unexplained.join("; ")}` +
      (waited.length === 0 ? "" : ` (and waited in one file create: ${waited.join("; ")})`);
    paused.push(report);
    if (attempt < 3)
      console.log(`Retrying hosted timing because the runner paused the process in ${report}`);
  }
  expect.unreachable(`the runner paused the process in all three attempts\n${paused.join("\n")}`);
}

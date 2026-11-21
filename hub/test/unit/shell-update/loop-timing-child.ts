/**
 * A process that holds nothing but one staging job, driven as the loop drives it, for
 * `stage-job.test.ts`'s timing tests: their numbers are the job's, not a whole test run's heap
 * (whose own collections pause a thread 20 to 48 ms, and up to 186 ms, on the hosted runners).
 *
 * From before the job is made, a 10 ms timer's lateness on this thread; each turn calls the job's
 * `next()` and times it; the job's constructor is timed too, and counts in the first gap. When
 * asked, the core stops wanting the staging once `lastFile` is there (a cancel at the worker's
 * stuck point). The window ends at `windowMs`, or 50 ms after the outcome was taken when
 * `untilOutcome`; then a stop if the job is still open, one line of numbers, and the process
 * ends, ending any worker still stuck.
 *
 * bun loop-timing-child.ts '<json: ChildArgs>'
 */
import { existsSync } from "node:fs";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { startJobThread } from "../../../src/shell/safe/job-thread.ts";
import type { StartWorker } from "../../../src/shell/worker/job.ts";
import type { KindData } from "../../../src/shell/worker/kinds.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import type { ReleasePlatform } from "../../../src/shell/update/release.ts";
import { StagingJob } from "../../../src/shell/update/stage-job.ts";

export interface ChildArgs {
  readonly path: string;
  readonly prefix: string;
  readonly platform: ReleasePlatform;
  /** The worker: the real one, or a stand-in in `staging-workers/`. */
  readonly entry: "real" | "held.ts" | "holds.ts";
  readonly windowMs: number;
  readonly untilOutcome?: boolean;
  /** A file whose presence means the worker reached its stuck point. */
  readonly lastFile?: string;
  readonly cancelWhenStuck?: boolean;
  readonly cancelWaitMs?: number;
}

export interface ChildNumbers {
  readonly constructMs: number;
  readonly worstLateMs: number;
  readonly worstAtMs: number;
  readonly longestCallMs: number;
  readonly calls: number;
  readonly wakes: number;
  readonly outcome: FileOutcome | null;
  readonly outcomeAtMs: number | null;
  readonly stuckReached: boolean;
}

const args = JSON.parse(process.argv[2] ?? "{}") as ChildArgs;
let wanted = true;
let wakes = 0;
const options = {
  wake: () => {
    wakes += 1;
  },
  stopWaitMs: 300,
  ...(args.cancelWaitMs === undefined ? {} : { cancelWaitMs: args.cancelWaitMs }),
  ...(args.entry === "real"
    ? {}
    : {
        start: (...[data, events]: Parameters<StartWorker<KindData<"stageUpdate">>>) =>
          startJobThread(data, events, new URL(`./staging-workers/${args.entry}`, import.meta.url)),
      }),
};

const t0 = performance.now();
const job = new StagingJob(
  {
    path: args.path,
    prefix: args.prefix,
    runningVersion: "0.1.0",
    platform: args.platform,
    keys: [TEST_PUBLISHER_KEY],
    wanted: () => wanted,
  },
  options,
);
const constructMs = performance.now() - t0;

let last = t0;
let worstLateMs = 0;
let worstAtMs = 0;
let longestCallMs = 0;
let calls = 0;
let outcome: FileOutcome | undefined;
let outcomeAtMs: number | undefined;
let stuckReached = false;
while (performance.now() - t0 < args.windowMs) {
  await Bun.sleep(10);
  const now = performance.now();
  const late = now - last - 10;
  if (late > worstLateMs) {
    worstLateMs = late;
    worstAtMs = now - t0;
  }
  if (args.lastFile !== undefined && !stuckReached && existsSync(args.lastFile)) {
    stuckReached = true;
    if (args.cancelWhenStuck === true) wanted = false;
  }
  const start = performance.now();
  const taken = job.next();
  const callMs = performance.now() - start;
  calls += 1;
  if (callMs > longestCallMs) longestCallMs = callMs;
  if (taken !== undefined && outcome === undefined) {
    outcome = taken;
    outcomeAtMs = performance.now() - t0;
  }
  if (args.untilOutcome === true && outcomeAtMs !== undefined && now - t0 > outcomeAtMs + 50) break;
  last = performance.now();
}
if (outcome === undefined) job.abort("the window is over");

const numbers: ChildNumbers = {
  constructMs,
  worstLateMs,
  worstAtMs,
  longestCallMs,
  calls,
  wakes,
  outcome: outcome ?? null,
  outcomeAtMs: outcomeAtMs ?? null,
  stuckReached,
};
process.stdout.write(`TIMING ${JSON.stringify(numbers)}\n`);
process.exit(0);

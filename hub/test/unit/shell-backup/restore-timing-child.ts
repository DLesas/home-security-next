/**
 * A process that holds nothing but one restore job, driven as the loop drives it, for
 * `restore-job.test.ts`'s timing tests: their numbers are the job's, not a whole test run's heap
 * (whose own collections pause a thread 20 to 48 ms, and up to 186 ms, on the hosted runners).
 *
 * The backup to restore (of a home's configuration) is made by the test; the job's constructor
 * is timed, counting in the first gap. From before the job is made, a 10 ms timer's lateness on
 * this thread; each turn calls the job's `next()` and times it. The window ends at `windowMs`, or
 * 50 ms after the outcome was taken when `untilOutcome`; then a stop if the job is still open, one
 * line of numbers, and the process ends, ending any worker still stuck.
 *
 * bun restore-timing-child.ts '<json: RestoreChildArgs>'
 */
import { join } from "node:path";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { RestoreJob } from "../../../src/shell/backup/restore-job.ts";
import { startJobThread } from "../../../src/shell/safe/job-thread.ts";
import type { StartWorker } from "../../../src/shell/worker/job.ts";
import type { KindData } from "../../../src/shell/worker/kinds.ts";
import { KEY } from "./backup-rig.ts";

export interface RestoreChildArgs {
  readonly dataDir: string;
  readonly upload: string;
  /** The worker: the real one, or a stand-in in `restore-workers/`. */
  readonly entry: "real" | "held.ts" | "holds.ts";
  readonly windowMs: number;
  readonly untilOutcome?: boolean;
}

export interface RestoreChildNumbers {
  readonly constructMs: number;
  readonly worstLateMs: number;
  readonly worstAtMs: number;
  readonly longestCallMs: number;
  readonly calls: number;
  readonly wakes: number;
  readonly outcome: FileOutcome | null;
  readonly outcomeAtMs: number | null;
}

const args = JSON.parse(process.argv[2] ?? "{}") as RestoreChildArgs;

let wakes = 0;
const options = {
  wake: () => {
    wakes += 1;
  },
  stopWaitMs: 300,
  ...(args.entry === "real"
    ? {}
    : {
        start: (...[data, events]: Parameters<StartWorker<KindData<"applyRestore">>>) =>
          startJobThread(data, events, new URL(`./restore-workers/${args.entry}`, import.meta.url)),
      }),
};

const t0 = performance.now();
const job = new RestoreJob(
  {
    dataDir: args.dataDir,
    uploadPath: args.upload,
    key: KEY,
    migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle"),
    rules: DEFAULT_RULES,
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
while (performance.now() - t0 < args.windowMs) {
  await Bun.sleep(10);
  const now = performance.now();
  const late = now - last - 10;
  if (late > worstLateMs) {
    worstLateMs = late;
    worstAtMs = now - t0;
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

const numbers: RestoreChildNumbers = {
  constructMs,
  worstLateMs,
  worstAtMs,
  longestCallMs,
  calls,
  wakes,
  outcome: outcome ?? null,
  outcomeAtMs: outcomeAtMs ?? null,
};
process.stdout.write(`TIMING ${JSON.stringify(numbers)}\n`);
process.exit(0);

/**
 * A process that holds nothing but one backup job, driven as the loop drives it, for
 * `write-job.test.ts`'s timing tests: their numbers are the job's, not a whole test run's heap
 * (whose own collections pause a thread 20 to 48 ms, and up to 186 ms, on the hosted runners).
 *
 * The hub's database is made before anything is timed, with a home's configuration (`peopleKb`
 * people of 1 KB). The job's constructor reads the backup's header facts and configuration from it
 * on this thread, as `startJob` does, and is timed, counting in the first gap. From before the job
 * is made, a 10 ms timer's lateness on this thread; each turn calls the job's `next()` and times
 * it. The window ends at `windowMs`, or 50 ms after the outcome was taken when `untilOutcome`;
 * then a stop if the job is still open, one line of numbers, and the process ends, ending any
 * worker still stuck.
 *
 * bun backup-timing-child.ts '<json: BackupChildArgs>'
 */
import { existsSync, readdirSync } from "node:fs";

import { ok } from "neverthrow";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { BackupJob } from "../../../src/shell/backup/write-job.ts";
import { startJobThread } from "../../../src/shell/safe/job-thread.ts";
import type { StartWorker } from "../../../src/shell/worker/job.ts";
import type { KindData } from "../../../src/shell/worker/kinds.ts";
import { backupHub, KEY, WALL } from "./backup-rig.ts";

export interface BackupChildArgs {
  readonly dataDir: string;
  readonly folder: string;
  readonly peopleKb: number;
  /** The worker: the real one, or a stand-in in `backup-workers/`. */
  readonly entry: "real" | "held.ts" | "holds.ts";
  readonly windowMs: number;
  readonly untilOutcome?: boolean;
}

export interface BackupChildNumbers {
  readonly constructMs: number;
  readonly worstLateMs: number;
  readonly worstAtMs: number;
  readonly longestCallMs: number;
  readonly calls: number;
  readonly wakes: number;
  readonly outcome: FileOutcome | null;
  readonly outcomeAtMs: number | null;
  /** Whether the temporary file was ever seen: the worker reached its writes. */
  readonly temporarySeen: boolean;
}

const args = JSON.parse(process.argv[2] ?? "{}") as BackupChildArgs;
const store = backupHub(args.dataDir, args.peopleKb);

let wakes = 0;
const options = {
  wake: () => {
    wakes += 1;
  },
  stopWaitMs: 300,
  ...(args.entry === "real"
    ? {}
    : {
        start: (...[data, events]: Parameters<StartWorker<KindData<"writeBackup">>>) =>
          startJobThread(data, events, new URL(`./backup-workers/${args.entry}`, import.meta.url)),
      }),
};

const t0 = performance.now();
const job = new BackupJob(
  store.db,
  { folder: args.folder, keep: 20, key: KEY, epoch: 1 },
  { nowMs: () => WALL, salt: () => ok(new Uint8Array(8).fill(9)) },
  args.dataDir,
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
let temporarySeen = false;
while (performance.now() - t0 < args.windowMs) {
  await Bun.sleep(10);
  const now = performance.now();
  const late = now - last - 10;
  if (late > worstLateMs) {
    worstLateMs = late;
    worstAtMs = now - t0;
  }
  if (!temporarySeen && existsSync(args.folder))
    temporarySeen = readdirSync(args.folder).some((name) => name.endsWith(".tmp"));
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

const numbers: BackupChildNumbers = {
  constructMs,
  worstLateMs,
  worstAtMs,
  longestCallMs,
  calls,
  wakes,
  outcome: outcome ?? null,
  outcomeAtMs: outcomeAtMs ?? null,
  temporarySeen,
};
process.stdout.write(`TIMING ${JSON.stringify(numbers)}\n`);
process.exit(0);

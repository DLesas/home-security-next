/**
 * A process that holds nothing but one firmware staging job, driven as the loop drives it, for
 * `stage-job.test.ts`'s timing tests: their numbers are the job's, not a whole test run's heap
 * (whose own collections pause a thread 20 to 48 ms, and up to 186 ms, on the hosted runners).
 *
 * The hub's database is opened and its signing key written before anything is timed; the job's
 * constructor reads the key's columns from it as `firmwareJob` does, and is timed, counting in the
 * first gap. The process has never made a signer, as at a hub's first firmware staging, whose
 * key's first derivation (on the worker now) cost the loop 20 to 60 ms of CPU when it ran there.
 * From before the job is made, a 10 ms timer's lateness on this thread; each turn calls the job's
 * `next()` and times it. The window ends at `windowMs`, or 50 ms after the outcome was taken
 * when `untilOutcome`; then a stop if the job is still open, one line of numbers, and the process
 * ends, ending any worker still stuck.
 *
 * bun firmware-timing-child.ts '<json: FirmwareChildArgs>'
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { FileOutcome } from "../../../src/core/model/events.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { mono } from "../../../src/core/model/time.ts";
import { hubSigningKeys } from "../../../src/shell/firmware/sign.ts";
import { FirmwareStagingJob } from "../../../src/shell/firmware/stage-job.ts";
import { startJobThread } from "../../../src/shell/safe/job-thread.ts";
import { openStore } from "../../../src/shell/storage/store.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";
import type { StartWorker } from "../../../src/shell/worker/job.ts";
import type { KindData } from "../../../src/shell/worker/kinds.ts";

export interface FirmwareChildArgs {
  readonly upload: string;
  readonly dataDir: string;
  readonly job: number;
  /** The worker: the real one, or a stand-in in `firmware-workers/`. */
  readonly entry: "real" | "held.ts" | "holds.ts";
  readonly windowMs: number;
  readonly untilOutcome?: boolean;
  /** A file whose presence means the worker reached its stuck point. */
  readonly stuckFile?: string;
  /** The hub's signing key's columns, as hex: made by the test, so this process never derives one. */
  readonly keys: {
    readonly signingPrivate: string;
    readonly signingPublic: string;
    readonly identity: string;
  };
}

export interface FirmwareChildNumbers {
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

const args = JSON.parse(process.argv[2] ?? "{}") as FirmwareChildArgs;
const hex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const store = openStore({
  dataDir: args.dataDir,
  migrationsFolder: join(import.meta.dir, "..", "..", "..", "drizzle"),
  clock: { now: () => ({ mono: mono(1), wall: Date.UTC(2026, 10, 21), wallTrusted: true }) },
  rules: DEFAULT_RULES,
  platform: process.platform,
})._unsafeUnwrap();
store.writer.stage([
  {
    kind: "write",
    durability: "now",
    op: {
      table: "hub_keys",
      op: "upsert",
      row: {
        signingPrivate: hex(args.keys.signingPrivate),
        signingPublic: hex(args.keys.signingPublic),
        identity: hex(args.keys.identity),
        appStaticPrivate: null,
        appStaticPublic: null,
        tlsPrivate: null,
        tlsCertificate: null,
      },
    },
  },
]);
store.writer.flush("now")._unsafeUnwrap();

let wakes = 0;
const options = {
  wake: () => {
    wakes += 1;
  },
  stopWaitMs: 300,
  ...(args.entry === "real"
    ? {}
    : {
        start: (...[data, events]: Parameters<StartWorker<KindData<"stageFirmware">>>) =>
          startJobThread(
            data,
            events,
            new URL(`./firmware-workers/${args.entry}`, import.meta.url),
          ),
      }),
};

const t0 = performance.now();
const job = new FirmwareStagingJob(
  {
    job: args.job,
    path: args.upload,
    own: null,
    dataDir: args.dataDir,
    keys: [TEST_PUBLISHER_KEY],
    rules: DEFAULT_RULES.firmware,
    signingKeys: () => hubSigningKeys(store.db),
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
  if (args.stuckFile !== undefined && !stuckReached && existsSync(args.stuckFile))
    stuckReached = true;
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

const numbers: FirmwareChildNumbers = {
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

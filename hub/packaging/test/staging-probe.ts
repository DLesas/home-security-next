/**
 * Compiled by `compiled-staging.test.ts` exactly as the hub's program is (`build-program.ts`'s
 * flags and `hubWorkers`): stages `<upload>` into the program tree `<prefix>` through the staging
 * worker, as the installed hub does, with the tests' key, and prints the outcome as JSON.
 */
import { platformOf } from "../../src/shell/update/release.ts";
import { TEST_PUBLISHER_KEY } from "../../src/shell/update/publisher-keys.ts";
import { StagingJob } from "../../src/shell/update/stage-job.ts";

const [upload = "", prefix = ""] = process.argv.slice(2);
const job: StagingJob = new StagingJob(
  {
    path: upload,
    prefix,
    runningVersion: "0.1.0",
    platform: platformOf(process.platform, process.arch),
    keys: [TEST_PUBLISHER_KEY],
  },
  {
    wake: () => {
      const outcome = job.next();
      if (outcome === undefined) return;
      process.stdout.write(`${JSON.stringify({ main: Bun.main, outcome })}\n`);
      process.exit(0);
    },
  },
);
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ main: Bun.main, outcome: "no outcome in 20 s" })}\n`);
  process.exit(1);
}, 20_000);

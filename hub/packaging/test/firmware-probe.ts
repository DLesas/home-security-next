/**
 * Compiled by `compiled-staging.test.ts` exactly as the hub's program is (`build-program.ts`'s
 * flags and `hubWorkers`): stages the firmware file `<upload>` into the store of the data folder
 * `<dataDir>` through the one worker entry, as the installed hub does, signed with the tests' hub
 * key, and prints the outcome as JSON (the image's bytes as base64).
 */
import { ok } from "neverthrow";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import type { FileOutcome } from "../../src/core/model/events.ts";
import { FirmwareStagingJob } from "../../src/shell/firmware/stage-job.ts";
import { TEST_PUBLISHER_KEY } from "../../src/shell/update/publisher-keys.ts";
import { testHubKeys } from "../../test/unit/shell-firmware/support.ts";

const [upload = "", dataDir = ""] = process.argv.slice(2);
const keys = await testHubKeys();

function printable(outcome: FileOutcome): unknown {
  return JSON.parse(
    JSON.stringify(outcome, (_key, value: unknown) =>
      value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
    ),
  );
}

const job: FirmwareStagingJob = new FirmwareStagingJob(
  {
    job: 2 ** 31 + 1,
    path: upload,
    own: null,
    dataDir,
    keys: [TEST_PUBLISHER_KEY],
    rules: DEFAULT_RULES.firmware,
    signingKeys: () =>
      ok({ signingPrivate: keys.pkcs8, signingPublic: keys.publicKey, identity: keys.identity }),
  },
  {
    wake: () => {
      const outcome = job.next();
      if (outcome === undefined) return;
      process.stdout.write(`${JSON.stringify({ main: Bun.main, outcome: printable(outcome) })}\n`);
      process.exit(0);
    },
  },
);
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ main: Bun.main, outcome: "no outcome in 20 s" })}\n`);
  process.exit(1);
}, 20_000);

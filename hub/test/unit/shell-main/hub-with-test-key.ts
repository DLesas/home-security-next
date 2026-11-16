/**
 * A test's own entry to the hub (m2-design.md section 9, "Hub updates"): the product's `runHub`,
 * started with the tests' publisher key instead of the compiled-in ones, so a test can stage a
 * release it signed. The product's own entry (`src/shell/main.ts`, `hub/packaging`) passes
 * `PUBLISHER_KEYS` and reads no key from its command line or environment; only a file like this
 * one, in a test's folder, can start the hub trusting `TEST_PUBLISHER_KEY`.
 */
import { parseMainArgs, runHub } from "../../../src/shell/main.ts";
import { TEST_PUBLISHER_KEY } from "../../../src/shell/update/publisher-keys.ts";

const options = parseMainArgs(process.argv.slice(2), process.env);
if (typeof options === "string") {
  process.stderr.write(`hub (test key): ${options}\n`);
  process.exit(2);
}
process.exit(await runHub(options, { publisherKeys: [TEST_PUBLISHER_KEY] }));

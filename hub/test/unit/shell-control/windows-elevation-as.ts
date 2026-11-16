/**
 * `hsn.exe`'s elevation answer, and the two facts it decides from, as the account and token this
 * process runs with (`windows-hub.test.ts`), written to a file.
 *
 *   bun windows-elevation-as.ts <result file>
 */
import { writeFileSync } from "node:fs";
import {
  processElevation,
  processElevationFacts,
} from "../../../src/shell/safe/control-socket-hsn.ts";

const [resultFile = ""] = process.argv.slice(2);
const elevation = processElevation();
const facts = processElevationFacts();
const fact = (read: typeof facts.tokenElevated): boolean | string =>
  read.isOk() ? read.value : read.error.message;
writeFileSync(
  resultFile,
  JSON.stringify({
    kind: elevation.kind,
    administratorsEnabled: fact(facts.administratorsEnabled),
    tokenElevated: fact(facts.tokenElevated),
  }),
);

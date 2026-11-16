/**
 * The real hub (`hub/src/shell/main.ts`), run as the account this process runs as, standing in
 * for the hub's service account (`windows-hub.test.ts`, run as the second account: the hosted
 * runner cannot run it as `NT SERVICE\HSNHub`). Before the hub starts, the Windows steps are told
 * that this account is the service, and every warning they raise is also appended, as a JSON
 * line, to `<warnings file>`. Then the hub runs as `bun main.ts <hub's arguments>` would.
 *
 *   bun windows-hub-as.ts <warnings file> <hub's arguments>…
 */
import { appendFileSync } from "node:fs";
import { parseSid } from "../../../src/shell/control/windows-acl.ts";
import { standInForServiceInTests } from "../../../src/shell/control/socket-steps.ts";
import { parseMainArgs, runHub } from "../../../src/shell/main.ts";
import { WINDOWS_CALLS } from "../../../src/shell/safe/control-socket-windows.ts";
import { PUBLISHER_KEYS } from "../../../src/shell/update/publisher-keys.ts";

const [warningsFile = "", ...hubArgs] = process.argv.slice(2);
const own = WINDOWS_CALLS.processSid()._unsafeUnwrap();
standInForServiceInTests(parseSid(own, 0)._unsafeUnwrap().sid, (warning) => {
  appendFileSync(warningsFile, `${JSON.stringify(warning)}\n`);
});
const options = parseMainArgs(hubArgs, process.env);
process.exit(
  typeof options === "string" ? 2 : await runHub(options, { publisherKeys: PUBLISHER_KEYS }),
);

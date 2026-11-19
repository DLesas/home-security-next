/**
 * The hub as the tests start it as a process: `src/shell/main.ts`'s own entry (the umask, the
 * compiled-in publisher keys), but with the wall clock taken as synchronised (`HubTrust`'s
 * `clockSynchronised`), so a test runs the same on a Linux machine without systemd-timesyncd as
 * on macOS, whose clock is trusted without asking. A test of the clock's trust itself starts
 * `main.ts`.
 */
import { hubUmask, parseMainArgs, runHub } from "../../src/shell/main.ts";
import { PUBLISHER_KEYS } from "../../src/shell/update/publisher-keys.ts";
import { serialSocketFixture } from "./serial-socket.ts";

const options = parseMainArgs(process.argv.slice(2), process.env);
if (typeof options === "string") {
  process.stderr.write(`hub (test entry): ${options}\n`);
  process.exit(2);
}
hubUmask();
const serial =
  process.env.HSN_E2E_SOCKET_BOARDS === "1" ? serialSocketFixture(options.serial) : undefined;
process.exit(
  await runHub(options, { publisherKeys: PUBLISHER_KEYS, clockSynchronised: true }, serial),
);

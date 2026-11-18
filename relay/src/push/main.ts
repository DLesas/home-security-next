/**
 * The push role's process (docs/m4-design.md section 3): `bun relay/src/push/main.ts <options>`,
 * run under its own account, the options as `config.ts` lists them. It logs one JSON line per
 * event to standard error (counts and errors only), reads the refused relay keys again on SIGHUP,
 * and stops on SIGTERM or SIGINT.
 *
 * Exit codes: 0 stopped; 78 a configuration or credential problem (EX_CONFIG); 70 anything else
 * (EX_SOFTWARE), including an uncaught exception, whose code alone is logged.
 */
import { dirname, resolve } from "node:path";
import { readConfig } from "./config.ts";
import { jsonLineLog } from "./log.ts";
import { startPushRole } from "./role.ts";
import { errorFrom } from "./safe/thrown.ts";

const log = jsonLineLog(
  (line) => {
    process.stderr.write(line);
  },
  () => Date.now(),
);

const fatal = (thrown: unknown) => {
  log.write("error", "fatal", {}, errorFrom("link", "push/main", "uncaught", thrown, "codeOnly"));
  process.exit(70);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

/** The program's own folder, which no key may be read from: the repository, or a compiled program's. */
function programFolder(): string {
  return import.meta.dir.startsWith("/$bunfs")
    ? dirname(process.execPath)
    : resolve(import.meta.dir, "..", "..", "..");
}

const config = readConfig(process.argv.slice(2), {
  programFolder: programFolder(),
  uid: process.getuid?.(),
});
if (config.isErr()) {
  log.write("error", "fatal", {}, config.error);
  process.exit(78);
}

const role = startPushRole(config.value, { log });
if (role.isErr()) {
  log.write("error", "fatal", {}, role.error);
  process.exit(role.error.kind === "credentials" || role.error.kind === "config" ? 78 : 70);
}
log.write("info", "started", {});

process.on("SIGHUP", () => {
  const reloaded = role.value.reloadRefused();
  if (reloaded.isErr()) log.write("error", "refusedRelays", {}, reloaded.error);
});
const stop = () => {
  void role.value.stop().then(() => {
    log.write("info", "stopped", {});
    process.exit(0);
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

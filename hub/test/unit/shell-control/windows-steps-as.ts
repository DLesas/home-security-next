/**
 * The Windows steps as the account this process runs as, standing in for the hub's service
 * account (`windows-hub.test.ts`, run as the second account: the hosted runner cannot run code as
 * `NT SERVICE\HSNHub`). Prepares the socket at `<folder>\control.sock` as the service would, and
 * writes what happened, the warnings, and how each entry inside is judged now. Paths, SIDs and
 * messages only.
 *
 *   bun windows-steps-as.ts <result file> <data folder>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkContent, checkTopFolder, parseSid } from "../../../src/shell/control/windows-acl.ts";
import { type ControlWarning, windowsSocketSteps } from "../../../src/shell/control/windows.ts";
import { WINDOWS_CALLS } from "../../../src/shell/safe/control-socket-windows.ts";

const [resultFile = "", folder = ""] = process.argv.slice(2);
const own = WINDOWS_CALLS.processSid().andThen((bytes) =>
  parseSid(bytes, 0).mapErr((why) => ({ kind: "control" as const, origin: "test", message: why })),
);
const service = own.isOk() ? own.value.sid : "(unknown)";
const warnings: ControlWarning[] = [];
const prepared = await windowsSocketSteps(WINDOWS_CALLS, {
  service,
  warn: (warning) => warnings.push(warning),
}).prepare(join(folder, "control.sock"));
const verdict = (path: string, top: boolean): string => {
  const bytes = WINDOWS_CALLS.securityDescriptor(path);
  if (bytes.isErr()) return bytes.error.message;
  const checked = top
    ? checkTopFolder(bytes.value, service, "service")
    : checkContent(bytes.value, service);
  return checked.isOk() ? "closed" : checked.error.join("; ");
};
const names = WINDOWS_CALLS.list(folder);
writeFileSync(
  resultFile,
  JSON.stringify({
    service,
    prepared: prepared.isOk() ? "ok" : prepared.error.message,
    warnings: warnings.map((w) => ({ code: w.code, closed: w.detail.closed, message: w.message })),
    top: verdict(folder, true),
    inside: (names.isOk() ? names.value : []).map((name) => ({
      name,
      list: verdict(join(folder, name), false),
    })),
  }),
);

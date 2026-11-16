#!/usr/bin/env bun
/**
 * The `hsn` command (hub-design.md section 9), its own executable (m2-design.md section 9, "The
 * privilege boundary": compiled from this file with Bun's automatic `.env` and `bunfig.toml`
 * loading off, `hub/packaging/shared/compile.ts`). Everything it does is in `main.ts`; this file
 * wires it to the process, and, run as root on macOS and Linux, first:
 *
 * 1. takes the fixed data folder and an ignored environment, and works from `/` (`elevated.ts`);
 * 2. for a command that names a file (`update install`, `restore`, `backup export`), starts the
 *    helper that opens it as the invoking user (`file-helper.ts`), or, run as root without
 *    `sudo`, keeps to root's own folders (`named-files.ts`);
 * 3. drops to the hub's account, proved (`elevated.ts`), and only then talks to the hub, holding
 *    the helper's pipe and nothing else of the person's.
 *
 * `hsn open`'s page goes the same way: a helper started as the person writes it in their folder
 * and opens their browser, given the address by the pipe once `hsn`, dropped, has the token. No
 * command keeps root (`root-plan.ts`). On Windows, where an administrator cannot become the
 * service's account, `hsn.exe` elevated (or unable to tell) keeps to fixed paths and an ignored
 * environment, opens a named file by its handle outside the hub's trees (`windows-files.ts`, A11's
 * calls), and checks who serves the socket (`main.ts`).
 * The drop is proved irreversible by the root test (`hub/test/root/`), which passed as root on
 * the hosted ubuntu-24.04 and macos-15 machines.
 */
import {
  dropTo,
  elevatedEnv,
  FIXED_DATA_FOLDERS,
  FIXED_PROGRAM_TREES,
  HUB_ACCOUNTS,
  invokingUser,
  isRoot,
  lookupAccount,
  unixPlatform,
} from "./elevated.ts";
import { HELPER_ARGUMENT, helperFiles, pageHelper, runHelper } from "./file-helper.ts";
import { type CliIo, runCli } from "./main.ts";
import { type NamedFiles, rootFiles } from "./named-files.ts";
import { rootPlan } from "./root-plan.ts";
import { HUB_SERVICE_SID } from "../src/shell/safe/control-socket-peer.ts";
import {
  beginExport,
  openNamedFileForReading,
  processElevation,
} from "../src/shell/safe/control-socket-hsn.ts";
import { isStrict, windowsElevatedEnv, windowsFiles } from "./windows-files.ts";

/** Exit code when `hsn` cannot give up root: it stops rather than talk to the hub as root. */
const EXIT_NO_DROP = 77;

const fail = (line: string, code: number): number => {
  process.stderr.write(`${line}\n`);
  return code;
};

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === HELPER_ARGUMENT) return runHelper(argv.slice(1));
  const platform = unixPlatform(process.platform);
  let env: Readonly<Record<string, string | undefined>> = process.env;
  let files: NamedFiles | undefined;
  let openConsole: CliIo["openConsole"];
  const windowsStrict = process.platform === "win32" && isStrict(processElevation());
  if (windowsStrict) {
    env = windowsElevatedEnv(process.env);
    process.chdir("C:\\");
    if (rootPlan(argv, Date.now()).helper.kind === "file")
      files = windowsFiles({ open: openNamedFileForReading, begin: beginExport });
  }
  if (platform !== undefined && isRoot(process.geteuid?.())) {
    const person = invokingUser(process.geteuid?.(), process.env);
    env = elevatedEnv(platform, process.env);
    process.chdir("/");
    const plan = rootPlan(argv, Date.now());
    const need = plan.helper;
    if (need.kind === "file")
      files =
        person === undefined
          ? rootFiles({
              data: FIXED_DATA_FOLDERS[platform],
              program: FIXED_PROGRAM_TREES[platform],
            })
          : helperFiles(person, need.mode, need.path);
    // Run as root without `sudo` there is no person to open a browser for: `console-page.ts`
    // refuses, as it always has.
    if (need.kind === "page" && person !== undefined) openConsole = pageHelper(person, process.env);
    const account = lookupAccount(HUB_ACCOUNTS[platform]);
    if (account.isErr()) return fail(`hsn: ${account.error}: is the hub installed?`, EXIT_NO_DROP);
    const dropped = dropTo(account.value, platform);
    if (dropped.isErr()) return fail(`hsn: ${dropped.error}`, EXIT_NO_DROP);
  }
  return runCli(argv, {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    env,
    stdin: () => Bun.stdin.text(),
    nowMs: () => Date.now(),
    onInterrupt: (end) => {
      process.once("SIGINT", end);
    },
    ask: (question) => {
      process.stdout.write(question);
      return new Promise((resolve) => {
        process.stdin.once("data", (data) => {
          process.stdin.pause();
          resolve(data.toString());
        });
      });
    },
    ...(files === undefined ? {} : { files }),
    ...(openConsole === undefined ? {} : { openConsole }),
    // Windows: the socket must be served by the hub's service account (section 9).
    hubAccount: HUB_SERVICE_SID,
    windowsStrict,
  });
}

process.exitCode = await main(process.argv.slice(2));

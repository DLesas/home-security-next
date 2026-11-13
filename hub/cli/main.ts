/**
 * `hsn` (hub-design.md section 9): parses the command line, sends one request over the control
 * socket, prints the answer readably (or as JSON lines with `--json`), and exits with a code a
 * script can use (`exit-codes.ts`). When the hub is not running it says so, and what to do.
 */
import type { ControlCommand, ReplyLine } from "../src/control-protocol/index.ts";
import { parseArgs, PASSWORD_FROM_STDIN } from "./args.ts";
import { exchange } from "./client.ts";
import { EXIT_CODE_HELP, ExitCode } from "./exit-codes.ts";
import { formatError, formatRecord, formatResult, printable } from "./format.ts";
import { dataFolder, socketPath } from "./paths.ts";

/** What `hsn` reads and writes, so tests can run it in the process. */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: () => Promise<string>;
  readonly nowMs: () => number;
  /** Called with a function that ends a `--follow` stream (on Ctrl-C). */
  readonly onInterrupt: (end: () => void) => void;
}

/** How long a command waits for its answer: 15 s ‡, covering a USB add's 5 s and its Set role. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** A survey listens on each of the three channels for about 2.5 minutes (section 8). */
export const SURVEY_TIMEOUT_MS = 10 * 60_000;

export const HELP = `hsn: the home security hub's command-line tool

usage: hsn [--data <folder>] [--socket <path>] [--json] [--timeout <s>] <command>

  status                                  armed state, doors, countdowns, the alarm, sirens, gateways
  arm [--all | <sensor>…] [--continue]    arm; an open door stops it unless --continue
  disarm [--all | <sensor>…]              disarm; cancels countdowns, ends the alarm when all its triggers are
  devices                                 the registry
  device show <name>
  device rename <old> <new>
  device remove <name>                    the key is deleted, the history kept
  usb list                                USB boards and their latest Identity
  usb add <port> --name <name> [--role sensor|siren|gateway]
  usb erase <port>                        development builds only
  sensor set <name> countdown=<s> heartbeat=<units> link-check=<n> reply-rate=<DRn|learn> correction=<units|learn>
  siren set <name> max=<s>
  siren test <name> [<s>]
  site show | site survey
  site set channel=<868.1|868.3|868.5> rate=<DRn> countdown=<s> auto-stop=<s>
  site wifi --name <name> --password <password|->   (- reads the password from standard input)
  site change channel=<…> rate=<DRn> | site change status | site change cancel | site change force [--yes]
  log [--device <name>] [--since <time|10m|2h|1d>] [--kind rx|tx|decision|log|event|reject] [--follow]

The hub's data folder is --data, else $HSN_DATA_DIR, else ~/.hsn; its socket is control.sock there.

${EXIT_CODE_HELP}`;

/** The user name the request reports (section 9; the socket's permissions are the real check). */
function actorOf(env: CliIo["env"]): string {
  const name = env.USER ?? env.LOGNAME ?? env.USERNAME;
  return name === undefined || name === "" ? "unknown" : name;
}

function exitFor(reply: ReplyLine["reply"]): ExitCode {
  if (reply.ok) return ExitCode.Ok;
  switch (reply.error.code) {
    case "doorsOpen":
      return ExitCode.DoorsOpen;
    case "noAnswer":
      return ExitCode.NoAnswer;
    case "badRequest":
      return ExitCode.Usage;
    default:
      return ExitCode.Refused;
  }
}

function timeoutFor(command: ControlCommand, seconds: number | undefined): number {
  if (seconds !== undefined) return seconds * 1000;
  return command.kind === "siteSurvey" ? SURVEY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** Runs `hsn` with these words; resolves to the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv, io.nowMs());
  if (parsed.isErr()) {
    io.err(`hsn: ${printable(parsed.error)}`);
    io.err("see hsn --help");
    return ExitCode.Usage;
  }
  if (parsed.value.kind === "help") {
    for (const line of HELP.split("\n")) io.out(line);
    return ExitCode.Ok;
  }
  const { globals, passwordFromStdin } = parsed.value;
  let command = parsed.value.command;
  if (passwordFromStdin && command.kind === "siteWifi") {
    const password = (await io.stdin()).replace(/\r?\n$/u, "");
    command = { ...command, password: password === PASSWORD_FROM_STDIN ? "" : password };
  }
  const folder = dataFolder(globals.data, io.env);
  const path = globals.socket ?? (folder === undefined ? undefined : socketPath(folder));
  if (path === undefined) {
    io.err("hsn: no data folder is known: pass --data <folder> or set HSN_DATA_DIR");
    return ExitCode.Usage;
  }
  const follow = command.kind === "log" && command.follow;
  const result = await exchange(
    path,
    { id: 1, actor: actorOf(io.env), command },
    timeoutFor(command, globals.timeoutS),
    follow
      ? (record) => {
          io.out(globals.json ? JSON.stringify(record) : formatRecord(record));
        }
      : undefined,
    follow ? io.onInterrupt : undefined,
  );
  if (result.isErr()) {
    const error = result.error;
    switch (error.kind) {
      case "notRunning":
        io.err(`hsn: the hub is not running: ${error.message}.`);
        io.err("Start the hub, or pass --data <folder> if it runs with another data folder.");
        return ExitCode.HubNotRunning;
      case "permission":
        io.err(`hsn: ${error.message}: run hsn as the account the hub runs as.`);
        return ExitCode.NoPermission;
      case "timeout":
        io.err(
          `hsn: ${error.message}; it may still act on the command: check with hsn status or hsn log.`,
        );
        return ExitCode.NoAnswer;
      case "closed":
      case "badReply":
        io.err(`hsn: ${error.message}.`);
        return ExitCode.BadReply;
    }
  }
  const { reply } = result.value;
  if (globals.json) {
    io.out(JSON.stringify(reply));
  } else if (reply.reply.ok) {
    for (const line of formatResult(reply.reply.result)) io.out(line);
  } else {
    for (const line of formatError(reply.reply.error)) io.err(line);
  }
  return exitFor(reply.reply);
}

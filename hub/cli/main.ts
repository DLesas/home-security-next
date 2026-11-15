/**
 * `hsn` (hub-design.md section 9): parses the command line, sends one request over the control
 * socket, prints the answer readably (or as JSON lines with `--json`), and exits with a code a
 * script can use (`exit-codes.ts`). When the hub is not running it says so, and what to do.
 */
import type {
  ControlError,
  ParsedControlCommand,
  ReplyLine,
} from "../src/control-protocol/index.ts";
import { type Globals, opCommand, parseArgs, PASSWORD_FROM_STDIN } from "./args.ts";
import { openConsoleAddress, type PageOutcome } from "./console-page.ts";
import type { Result } from "neverthrow";
import { type ClientError, exchange, Session } from "./client.ts";
import { type FileCommand, runFileCommand } from "./files.ts";
import { qrLines } from "./qr.ts";
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
  /** Asks the user a question on the terminal and gives the line answered (`hsn restore`). */
  readonly ask: (question: string) => Promise<string>;
  /** The system, for its own wording of a refused socket; `process.platform` when not given. */
  readonly platform?: NodeJS.Platform;
  /**
   * Opens the console's address in the ordinary user's browser through a page only they can read
   * (`hsn open`, `console-page.ts`); the address is a secret. The real computer when not given.
   */
  readonly openConsole?: (url: string, expiresInMs: number) => Promise<Result<PageOutcome, string>>;
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
  gateway set <name> status=<s> interference=<dB>/<s> power=<dBm> siren-power=<dBm>
  site show | site survey
  site set channel=<868.1|868.3|868.5> rate=<DRn> countdown=<s> auto-stop=<s> retention-routine=<days> retention-event=<days>
  site wifi --name <name> --password <password|->   (- reads the password from standard input)
  site change channel=<…> rate=<DRn> | site change status | site change cancel | site change force [--yes]
  log [--device <name>] [--since <time|10m|2h|1d>] [--kind rx|tx|decision|log|event|reject|notification] [--follow]
  op <operation> [<json> | -]             an app operation of M2 (m2-design.md section 6), as the hub computer;
                                          - reads the body from standard input; the reply's body is printed as JSON
  open                                    a one-time console token for this computer's browser
  update install <file>                   upload a release and stage it (D54)
  restore <file>                          restore this new hub from a backup file, with a phone's key (D53)
  backup export <file> [--history]        write a backup, with history if asked, to <file> (HB22)

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

function timeoutFor(command: ParsedControlCommand, seconds: number | undefined): number {
  if (seconds !== undefined) return seconds * 1000;
  return command.kind === "siteSurvey" ? SURVEY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** What a failed connection prints, and its exit code. */
export function clientFailure(error: ClientError, io: CliIo): ExitCode {
  switch (error.kind) {
    case "notRunning":
      io.err(`hsn: the hub is not running: ${error.message}.`);
      io.err("Start the hub, or pass --data <folder> if it runs with another data folder.");
      return ExitCode.HubNotRunning;
    case "permission":
      // Windows lets only administrators and the hub's own account in (m2-design.md section 9).
      io.err(
        (io.platform ?? process.platform) === "win32"
          ? `hsn: ${error.message}: run hsn from an administrator prompt (Run as administrator).`
          : `hsn: ${error.message}: run hsn as the account the hub runs as.`,
      );
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

/** An operation's refusal as `hsn op` prints it (section 6): `{code, detail}` as JSON. */
function opError(error: ControlError): string {
  return JSON.stringify(error.app ?? { code: error.code, detail: {} });
}

function socketOf(globals: Globals, io: CliIo): string | undefined {
  const folder = dataFolder(globals.data, io.env);
  return globals.socket ?? (folder === undefined ? undefined : socketPath(folder));
}

/** A command that carries a file, on its own connection (`files.ts`). */
async function runFile(file: FileCommand, globals: Globals, io: CliIo): Promise<number> {
  const path = socketOf(globals, io);
  if (path === undefined) {
    io.err("hsn: no data folder is known: pass --data <folder> or set HSN_DATA_DIR");
    return ExitCode.Usage;
  }
  const opened = await Session.open(path);
  if (opened.isErr()) return clientFailure(opened.error, io);
  const session = opened.value;
  const done = await runFileCommand(
    file,
    session,
    actorOf(io.env),
    { out: io.out, ask: io.ask, nowMs: io.nowMs },
    globals.timeoutS === undefined ? DEFAULT_TIMEOUT_MS : globals.timeoutS * 1000,
    qrLines,
  );
  session.close();
  if (done.isOk()) {
    for (const line of done.value) io.out(line);
    return ExitCode.Ok;
  }
  const failure = done.error;
  switch (failure.kind) {
    case "client":
      return clientFailure(failure.error, io);
    case "refused":
      io.err(opError(failure.error));
      return exitFor({ ok: false, error: failure.error });
    case "file":
      io.err(`hsn: ${printable(failure.message)}`);
      return ExitCode.Refused;
    case "declined":
      io.err("hsn: not restored");
      return ExitCode.Refused;
  }
}

/**
 * `hsn open` (m2-design.md section 5, "The console"): the one-time console token's address is
 * opened in the ordinary user's browser through a page only that user can read, never on a command
 * line and never printed, with `--json` or without: it would link whoever used it first as the
 * console. It works once, for 2 minutes ‡; `hsn` says whether the browser read the page in time.
 */
async function openConsole(
  token: { readonly url: string; readonly expiresInMs: number },
  json: boolean,
  io: CliIo,
): Promise<ExitCode> {
  const seconds = Math.round(token.expiresInMs / 1000);
  const opened = await (io.openConsole ?? ((url, ms) => openConsoleAddress(url, ms)))(
    token.url,
    token.expiresInMs,
  );
  if (opened.isErr()) {
    io.err(`hsn: the console could not be opened: ${printable(opened.error)}`);
    io.err("The link was not used and expires by itself; nothing was put on a command line.");
    return ExitCode.Refused;
  }
  const read = opened.value === "read";
  if (json) io.out(JSON.stringify({ opened: read, expiresInMs: token.expiresInMs }));
  else if (read) io.out("the console opened in the browser; its link works once");
  else io.err(`hsn: the browser did not open the console within ${seconds} s; run hsn open again`);
  return read ? ExitCode.Ok : ExitCode.NoAnswer;
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
  if (parsed.value.kind === "file") return runFile(parsed.value.file, parsed.value.globals, io);
  const { globals } = parsed.value;
  let command: ParsedControlCommand;
  if (parsed.value.kind === "opFromStdin") {
    const read = opCommand(parsed.value.op, await io.stdin());
    if (read.isErr()) {
      io.err(`hsn: ${printable(read.error)}`);
      return ExitCode.Usage;
    }
    command = read.value;
  } else {
    command = parsed.value.command;
    if (parsed.value.passwordFromStdin && command.kind === "siteWifi") {
      const password = (await io.stdin()).replace(/\r?\n$/u, "");
      command = { ...command, password: password === PASSWORD_FROM_STDIN ? "" : password };
    }
  }
  const path = socketOf(globals, io);
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
  if (result.isErr()) return clientFailure(result.error, io);
  const { reply } = result.value;
  if (reply.reply.ok && reply.reply.result.kind === "consoleToken") {
    return openConsole(reply.reply.result, globals.json, io);
  }
  // `hsn op` always prints JSON: the reply's body on success, `{code, detail}` on a refusal.
  if (command.kind === "op") {
    if (reply.reply.ok) for (const line of formatResult(reply.reply.result)) io.out(line);
    else io.err(opError(reply.reply.error));
  } else if (globals.json) {
    io.out(JSON.stringify(reply));
  } else if (reply.reply.ok) {
    for (const line of formatResult(reply.reply.result)) io.out(line);
  } else {
    for (const line of formatError(reply.reply.error)) io.err(line);
  }
  return exitFor(reply.reply);
}

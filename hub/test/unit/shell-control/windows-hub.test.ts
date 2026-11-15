/**
 * The real hub's command socket on Windows, reached by the real `hsn`, as its own account, as a
 * second local account, and as an administrator from a normal and an elevated prompt (spike W2's
 * test, against the hub rather than a stand-in; m2-design.md section 9, "To try on the hosted
 * runner"). Run only by `.github/workflows/windows-control-socket.yml` on a hosted runner, which
 * sets HSN_WINDOWS_SECOND_ACCOUNT=1: it makes a local account. Skipped everywhere else.
 *
 * What a person sees is what `hsn` prints and its exit code (hub/cli/exit-codes.ts): 69 when the
 * hub is not running, 77 when the account may not use the socket, 0 when answered, the same
 * codes as on macOS and Linux. Also shown: an ordinary account cannot read `hub.db`, and a data
 * folder made open before the hub's first start is closed by the hub, with its warning.
 *
 * What the runner cannot show: a real UAC prompt (its logons are always elevated, so a normal
 * prompt is made as a restricted token, Administrators deny-only), a real restart, another
 * Windows version.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  ensureOtherUser,
  newPassword,
  OTHER_USER,
  removeOtherUser,
  runAsOther,
  runUnelevated,
} from "./windows-accounts.ts";
import {
  icacls,
  isWindows,
  lockFolder,
  lockFolderTo,
  listVerdict,
  ordinaryFolder,
  removeTree,
} from "./windows-folders.ts";

const enabled = isWindows && process.env.HSN_WINDOWS_SECOND_ACCOUNT === "1";
const REPO = join(import.meta.dir, "..", "..", "..", "..");
const BASE = join(process.env.SystemDrive ?? "C:", "\\", "hsn-a11-hub");
const BIN = join(BASE, "bin");
const OUT = join(BASE, "out");
const LOCKED = join(BASE, "locked");
const OPEN = join(BASE, "open", "data");
const ADMINS_ONLY = join(BASE, "admins");
/** A listable folder with no hub: what "not running" looks like to each account. */
const EMPTY = join(BASE, "empty");
const ADMINISTRATORS = "S-1-5-32-544";
const SYSTEM = "S-1-5-18";
const password = newPassword();
const hubs: Subprocess[] = [];

/** A row of the job summary's table. */
function row(what: string, expected: string, observed: string): void {
  const file = process.env.HSN_RESULTS;
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  if (file !== undefined && file !== "")
    appendFileSync(file, `| ${cell(what)} | ${cell(expected)} | ${cell(observed)} |\n`);
}

interface Hub {
  readonly process: Subprocess<"ignore", "ignore", "pipe">;
  readonly said: () => string;
}

/** The hub as the service runs it (spike W3): its own entry point, its data folder, no USB. */
function startHub(folder: string): Hub {
  const hub = Bun.spawn(
    [
      process.execPath,
      join(REPO, "hub", "src", "shell", "main.ts"),
      "--data",
      folder,
      "--port",
      "0",
      "--no-usb-watch",
      "--app-ports",
      "0,0",
    ],
    { cwd: REPO, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  hubs.push(hub);
  let said = "";
  void (async () => {
    for await (const chunk of hub.stderr) said += new TextDecoder().decode(chunk);
  })();
  return { process: hub, said: () => said };
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(100);
  return check();
}

async function stop(hub: Hub): Promise<void> {
  hub.process.kill();
  await hub.process.exited;
}

/**
 * What the hub said about its socket and the folder: only its lines naming the control socket
 * or the warning, never the rest (which could hold a linking code).
 */
function socketLines(hub: Hub): string {
  const lines = hub
    .said()
    .split("\n")
    .filter((line) => /control socket|data_folder_was_open/u.test(line));
  return lines.length === 0 ? "(nothing about the socket)" : lines.join(" / ");
}

interface Hsn {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** `hsn --data <folder> <args>` as this account, elevated: the real `hub/cli/hsn.ts`. */
async function hsnAsSelf(folder: string, args: readonly string[] = ["status"]): Promise<Hsn> {
  const env: Record<string, string | undefined> = { ...process.env, HSN_DATA_DIR: undefined };
  const ran = Bun.spawn(
    [process.execPath, join(REPO, "hub", "cli", "hsn.ts"), "--data", folder, ...args],
    { cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(ran.stdout).text(),
    new Response(ran.stderr).text(),
  ]);
  return { code: await ran.exited, out: out.trim(), err: err.trim() };
}

/** `hsn status` until answered: a hub that has just opened its socket may still say "starting". */
async function hsnUntilAnswered(folder: string): Promise<Hsn> {
  let last = await hsnAsSelf(folder);
  for (let i = 0; i < 60 && last.code !== 0; i++) {
    await Bun.sleep(1000);
    last = await hsnAsSelf(folder);
  }
  return last;
}

/**
 * The hub's own record of the warning (m2-design.md section 9): `main.ts` gives it to the core as
 * `shellWarning`, recorded as a hub event, so it is read back with `hsn log --kind event`, not
 * from what the hub prints. Only the lines naming it are kept.
 */
async function recordedWarning(folder: string): Promise<string> {
  const log = await hsnAsSelf(folder, ["log", "--kind", "event"]);
  const lines = log.out.split("\n").filter((line) => line.includes("data_folder_was_open"));
  return lines.length > 0
    ? lines.join(" / ")
    : `(none recorded; hsn log ${log.code}${log.code === 0 ? "" : `: ${log.err}`})`;
}

interface Ran {
  readonly code: number;
  readonly err: string;
  readonly user: string;
}

/** Reads what a helper run as another account wrote, or says why there is nothing. */
function resultOf(file: string, why: unknown): Ran {
  if (!existsSync(file))
    return { code: -1, err: `no result: ${JSON.stringify(why)}`, user: "(did not run)" };
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const value = typeof parsed === "object" && parsed !== null ? parsed : {};
  const code = "code" in value && typeof value.code === "number" ? value.code : -1;
  const user = "user" in value && typeof value.user === "string" ? value.user : "?";
  const err = "err" in value && Array.isArray(value.err) ? value.err.join(" ") : "";
  return { code, err, user };
}

type Who = "self" | "unelevated" | "other";

/** Runs one of this folder's helper scripts as `who`; the result file is its first argument. */
async function runHelper(
  who: Who,
  script: string,
  label: string,
  args: readonly string[],
): Promise<string> {
  const result = join(OUT, `${label}.json`);
  rmSync(result, { force: true });
  const full = [join(import.meta.dir, script), result, ...args];
  const ran =
    who === "other"
      ? await runAsOther(password, join(BIN, "bun.exe"), full, BIN)
      : who === "unelevated"
        ? await runUnelevated(process.execPath, full, BIN)
        : Bun.spawnSync([process.execPath, ...full], { cwd: BIN }).exitCode;
  return existsSync(result) ? readFileSync(result, "utf8") : `(no result: ${JSON.stringify(ran)})`;
}

const hsnAs = async (who: Who, label: string, args: readonly string[]): Promise<Ran> => {
  const text = await runHelper(who, "windows-hsn-as.ts", label, args);
  const file = join(OUT, `${label}.json`);
  return existsSync(file) ? resultOf(file, "") : { code: -1, err: text, user: "(did not run)" };
};

/** The raw connect error and folder listing as `who` sees them, for the job summary. */
async function probe(who: Who, label: string, folder: string): Promise<void> {
  const text = await runHelper(who, "windows-connect-probe.ts", `probe-${label}`, [folder]);
  row(`probe: ${label} (${who})`, "the raw error behind hsn's answer", text);
}

/** Starts the hub on `folder` and waits for its socket file, or its refusal. */
async function startAndWait(folder: string): Promise<Hub> {
  const hub = startHub(folder);
  await until(
    () => existsSync(join(folder, "control.sock")) || hub.said().includes("could not open"),
    90_000,
  );
  return hub;
}

beforeAll(() => {
  if (!enabled) return;
  removeTree(BASE);
  mkdirSync(BIN, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  // Bun, and a folder for results, that the second account can use (as spike W2's).
  copyFileSync(process.execPath, join(BIN, "bun.exe"));
  expect(icacls(BIN, "/grant", "*S-1-5-32-545:(OI)(CI)RX").code).toBe(0);
  expect(icacls(OUT, "/grant", "*S-1-5-32-545:(OI)(CI)M").code).toBe(0);
  const made = ensureOtherUser(password);
  expect(made.code).toBe(0);
  expect(lockFolder(LOCKED).code).toBe(0);
  expect(lockFolderTo(ADMINS_ONLY, [ADMINISTRATORS, SYSTEM]).code).toBe(0);
  ordinaryFolder(OPEN);
  ordinaryFolder(EMPTY);
});

afterAll(async () => {
  if (!enabled) return;
  for (const hub of hubs.splice(0)) {
    hub.kill();
    await hub.exited;
  }
  removeOtherUser();
  row("cleanup: the test's folders", "removed", removeTree(BASE));
});

describe.skipIf(!enabled)("Windows: the real hub's command socket, reached by hsn", () => {
  test("no hub yet: hsn says the hub is not running (69)", async () => {
    const self = await hsnAsSelf(LOCKED);
    row("no hub: hsn as the hub's account", "69, not running", `${self.code}: ${self.err}`);
    await probe("self", "no hub, locked folder", LOCKED);
    await probe("other", "no hub, locked folder", LOCKED);
    await probe("self", "no hub, ordinary folder", EMPTY);
    await probe("other", "no hub, ordinary folder", EMPTY);
    expect(self.code).toBe(69);
    expect(self.err).toContain("the hub is not running");
  }, 300_000);

  test("the second account can run hsn at all (else the tests below prove nothing)", async () => {
    const other = await hsnAs("other", "first", ["--data", LOCKED, "status"]);
    row(
      "second account: hsn runs as it",
      `runs as ${OTHER_USER}`,
      `${other.user}, ${other.code}: ${other.err}`,
    );
    expect(other.user.toLowerCase()).toBe(OTHER_USER);
  }, 300_000);

  test("the hub in a locked folder: its account answered (0); an old socket left by a kill is replaced", async () => {
    const socket = join(LOCKED, "control.sock");
    const hub = await startAndWait(LOCKED);
    const opened = existsSync(socket);
    row("hub in a locked folder: its socket", "opens", opened ? "opens" : socketLines(hub));
    const self = await hsnUntilAnswered(LOCKED);
    row(
      "hsn status as the hub's account",
      "0",
      `${self.code}${self.code === 0 ? "" : `: ${self.err}`}`,
    );
    await probe("self", "hub running, locked folder", LOCKED);
    await probe("other", "hub running, locked folder", LOCKED);
    const read = await hsnAs("other", "read-locked", ["--read", join(LOCKED, "hub.db")]);
    row(
      "the second account reads hub.db",
      "cannot",
      read.code === 0 ? "can" : `cannot (${read.err})`,
    );
    await stop(hub);
    const left = existsSync(socket);
    row("hub killed: its socket file", "left behind", left ? "left behind" : "gone");
    const stale = await hsnAsSelf(LOCKED);
    row("hub killed: hsn as the hub's account", "69, not running", `${stale.code}: ${stale.err}`);
    await probe("self", "old socket file, no hub", LOCKED);
    await probe("other", "old socket file, no hub", LOCKED);
    const again = startHub(LOCKED);
    const after = await hsnUntilAnswered(LOCKED);
    row(
      "hub started again over the old socket file: hsn",
      "0",
      `${after.code}${after.code === 0 ? "" : `: ${after.err} / ${socketLines(again)}`}`,
    );
    await stop(again);
    expect(opened).toBe(true);
    expect(self.code).toBe(0);
    expect(read.code).toBe(1);
    expect(stale.code).toBe(69);
    expect(after.code).toBe(0);
  }, 300_000);

  test("the second account may not use the hub (77), told to use an administrator prompt (needs hub/cli's change)", async () => {
    const hub = await startAndWait(LOCKED);
    await hsnUntilAnswered(LOCKED);
    const other = await hsnAs("other", "locked", ["--data", LOCKED, "status"]);
    row(
      "hsn status as the second account",
      "77, run hsn from an administrator prompt",
      `${other.code}: ${other.err}`,
    );
    await stop(hub);
    expect(other.code).toBe(77);
    expect(other.err).toContain("administrator prompt");
  }, 300_000);

  test("a data folder made open before the hub's first start is closed by it, and the warning recorded", async () => {
    const socket = join(OPEN, "control.sock");
    const before = listVerdict(OPEN, true);
    row("open folder before the hub's first start: the hub's rule on its list", "open", before);
    const hub = await startAndWait(OPEN);
    const opened = existsSync(socket);
    row("open folder at first start: the socket", "opens", opened ? "opens" : socketLines(hub));
    row("open folder at first start: what the hub said of it", "(any)", socketLines(hub));
    const list = icacls(OPEN);
    row(
      "open folder at first start: its list after (icacls)",
      "the three accounts, protected",
      list.out,
    );
    const folderVerdict = listVerdict(OPEN, true);
    row("open folder at first start: the hub's rule on its list after", "closed", folderVerdict);
    const dbVerdict = listVerdict(join(OPEN, "hub.db"), false);
    row("open folder at first start: the hub's rule on hub.db's list after", "closed", dbVerdict);
    const self = await hsnUntilAnswered(OPEN);
    row(
      "open folder closed: hsn as the hub's account",
      "0",
      `${self.code}${self.code === 0 ? "" : `: ${self.err}`}`,
    );
    const warned = await recordedWarning(OPEN);
    row(
      "open folder at first start: the warning, in the hub's record",
      "data_folder_was_open, the hub set its list",
      warned,
    );
    const read = await hsnAs("other", "read-open", ["--read", join(OPEN, "hub.db")]);
    row(
      "open folder closed: the second account reads hub.db (made before it was closed)",
      "cannot",
      read.code === 0 ? "can" : `cannot (${read.err})`,
    );
    await probe("other", "hub running, folder the hub closed", OPEN);
    await stop(hub);
    expect(read.code).toBe(1);
    expect(opened).toBe(true);
    expect(folderVerdict).toBe("closed");
    expect(dbVerdict).toBe("closed");
    expect(self.code).toBe(0);
    expect(warned).toContain("the hub set its list");
  }, 300_000);

  test("an administrator: answered from an elevated prompt; refused from a normal one", async () => {
    const hub = await startAndWait(ADMINS_ONLY);
    const opened = existsSync(join(ADMINS_ONLY, "control.sock"));
    const elevated = await hsnUntilAnswered(ADMINS_ONLY);
    row(
      "folder for Administrators and SYSTEM: hsn, elevated",
      "0",
      `${elevated.code}${elevated.code === 0 ? "" : `: ${elevated.err}`}`,
    );
    const normal = await hsnAs("unelevated", "unelevated", ["--data", ADMINS_ONLY, "status"]);
    row("the same administrator from a normal prompt", "not 0", `${normal.code}: ${normal.err}`);
    await probe("unelevated", "hub running, Administrators-only folder", ADMINS_ONLY);
    await probe("self", "hub running, Administrators-only folder", ADMINS_ONLY);
    await stop(hub);
    await probe("unelevated", "no hub, Administrators-only folder", ADMINS_ONLY);
    expect(opened).toBe(true);
    expect(elevated.code).toBe(0);
    expect(normal.code).not.toBe(0);
  }, 300_000);

  test("from a normal prompt, hsn answers 77 and says to use an administrator prompt (needs hub/cli's change)", async () => {
    const hub = await startAndWait(ADMINS_ONLY);
    await hsnUntilAnswered(ADMINS_ONLY);
    const normal = await hsnAs("unelevated", "unelevated-message", [
      "--data",
      ADMINS_ONLY,
      "status",
    ]);
    row(
      "hsn from a normal prompt",
      "77, run hsn from an administrator prompt",
      `${normal.code}: ${normal.err}`,
    );
    await stop(hub);
    const quiet = await hsnAsSelf(ADMINS_ONLY);
    row(
      "no hub: hsn elevated, Administrators-only folder",
      "69, never 77",
      `${quiet.code}: ${quiet.err}`,
    );
    expect(normal.code).toBe(77);
    expect(normal.err).toContain("administrator prompt");
    expect(quiet.code).toBe(69);
  }, 300_000);
});

/**
 * The real hub's command socket on Windows, reached by the real `hsn`, as its own account, as a
 * second local account, and as an administrator from a normal and an elevated prompt (spike W2's
 * test, against the hub rather than a stand-in; m2-design.md section 9, "To try on the hosted
 * runner"). Run only by `.github/workflows/windows-control-socket.yml` on a hosted runner, which
 * sets HSN_WINDOWS_SECOND_ACCOUNT=1: it makes a local account. Skipped everywhere else.
 *
 * What a person sees is what `hsn` prints and its exit code (hub/cli/exit-codes.ts): 69 when the
 * hub is not running, 77 when the account may not use the socket, 0 when answered, the same
 * codes as on macOS and Linux. Also shown (m2-design.md section 9, "The top folders"): an
 * ordinary account cannot read `hub.db`; an administrator's run on a data folder made open before
 * closes its top alone, with `data_folder_was_open`; and, with the second account standing in for
 * `NT SERVICE\HSNHub` (the runner cannot run code as the service), the service's steps and the
 * real hub refuse an open top folder with `data_folder_open`, leave it as it was, make what is
 * inside inherit, and serve a socket that `hsn.exe`'s peer check finds run by that account.
 *
 * What the runner cannot show: the real service account (only the installer's job, A8), a real UAC prompt (its logons are always elevated, so a normal
 * prompt is made as a restricted token, Administrators deny-only), a real restart, another
 * Windows version.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { HUB_SERVICE_SID, parseSid } from "../../../src/shell/control/windows-acl.ts";
import { checkHubPeer } from "../../../src/shell/safe/control-socket-peer.ts";
import { WINDOWS_CALLS } from "../../../src/shell/safe/control-socket-windows.ts";
import {
  ensureOtherUser,
  newPassword,
  OTHER_USER,
  removeOtherUser,
  runAsOther,
  runUnelevated,
  sidOfAccount,
  startAsOther,
} from "./windows-accounts.ts";
import {
  icacls,
  isWindows,
  shapeFolder,
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
/** A data folder that does not exist (a wrong --data): "not running", never "kept out". */
const MISSING = join(BASE, "missing");
/** Top folders shaped for the second account standing in for the service. */
const STAND_IN_SHAPED = join(BASE, "standin-shaped");
const STAND_IN_OPEN = join(BASE, "standin-open");
const STAND_IN_HUB = join(BASE, "standin-hub");
const STAND_IN_HUB_OPEN = join(BASE, "standin-hub-open");
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

/** The account the hub under test runs as, which `hsn` is to find serving the socket. */
const hubAccount = { sid: "" };

/**
 * `hsn --data <folder> <args>` as this account, elevated: the CLI's own `runCli` through
 * `windows-hsn-as.ts`, told the account the hub under test runs as (the runner's, or the
 * stand-in's), which `hsn.exe`'s peer check compares with `NT SERVICE\HSNHub` (A2).
 */
async function hsnAsSelf(folder: string, args: readonly string[] = ["status"]): Promise<Hsn> {
  const result = join(OUT, `self-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const ran = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "windows-hsn-as.ts"),
      result,
      "--hub-account",
      hubAccount.sid,
      "--data",
      folder,
      ...args,
    ],
    {
      cwd: BIN,
      env: { ...process.env, HSN_DATA_DIR: undefined },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(ran.stderr).text();
  await ran.exited;
  if (!existsSync(result)) return { code: -1, out: "", err: `no result: ${stderr.slice(0, 300)}` };
  const parsed: unknown = JSON.parse(readFileSync(result, "utf8"));
  const value = typeof parsed === "object" && parsed !== null ? parsed : {};
  const lines = (key: string): string =>
    key in value && Array.isArray((value as Record<string, unknown>)[key])
      ? ((value as Record<string, unknown>)[key] as unknown[]).map(String).join("\n")
      : "";
  const code = "code" in value && typeof value.code === "number" ? value.code : -1;
  return { code, out: lines("out"), err: lines("err").replaceAll("\n", " ") };
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
  const told = args[0] === "--read" ? args : ["--hub-account", hubAccount.sid, ...args];
  const text = await runHelper(who, "windows-hsn-as.ts", label, told);
  const file = join(OUT, `${label}.json`);
  return existsSync(file) ? resultOf(file, "") : { code: -1, err: text, user: "(did not run)" };
};

/** The raw connect error and folder listing as `who` sees them, for the job summary. */
async function probe(who: Who, label: string, folder: string): Promise<void> {
  // The result file's name: a label may hold a path (`C:\…`), whose colon and separators are not
  // a file name, and the probe would exit 1 without writing (run 43693478238).
  const file = `probe-${who}-${label}`.replaceAll(/[^A-Za-z0-9-]+/gu, "-");
  const text = await runHelper(who, "windows-connect-probe.ts", file, [folder]);
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
  hubAccount.sid = parseSid(WINDOWS_CALLS.processSid()._unsafeUnwrap(), 0)._unsafeUnwrap().sid;
  expect(shapeFolder(LOCKED).code).toBe(0);
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

  test("an administrator's run on a data folder made open before: its top closed, data_folder_was_open recorded; hub.db left for the service", async () => {
    const socket = join(OPEN, "control.sock");
    const before = listVerdict(OPEN, { top: true, mode: "service" });
    row("open folder before the hub's first start: the hub's rule on its list", "open", before);
    const hub = await startAndWait(OPEN);
    const opened = existsSync(socket);
    row(
      "open folder, an administrator's run: the socket",
      "opens",
      opened ? "opens" : socketLines(hub),
    );
    row("open folder, an administrator's run: what the hub said of it", "(any)", socketLines(hub));
    const list = icacls(OPEN);
    row(
      "open folder, an administrator's run: its list after (icacls)",
      "the installer's shape",
      list.out,
    );
    const folderVerdict = listVerdict(OPEN, { top: true, mode: "service" });
    row(
      "open folder, an administrator's run: the hub's rule on its list after",
      "closed",
      folderVerdict,
    );
    const dbVerdict = listVerdict(join(OPEN, "hub.db"), { top: false });
    row(
      "open folder, an administrator's run: hub.db's list after",
      "as it was: closed only at the service's next start (section 9)",
      dbVerdict,
    );
    const self = await hsnUntilAnswered(OPEN);
    row(
      "open folder closed: hsn, elevated",
      "0",
      `${self.code}${self.code === 0 ? "" : `: ${self.err}`}`,
    );
    const warned = await recordedWarning(OPEN);
    row(
      "open folder: the warning, in the hub's record",
      "data_folder_was_open: the folder's own owner and list set; what is inside left",
      warned,
    );
    const other = await hsnAs("other", "open-other", ["--data", OPEN, "status"]);
    row("open folder closed: hsn as the second account", "77", `${other.code}: ${other.err}`);
    const read = await hsnAs("other", "read-open", ["--read", join(OPEN, "hub.db")]);
    row(
      "open folder closed by hand: the second account reads hub.db (made before it was closed)",
      "can, until the service's next start (SPEC-QUESTION in A11's report)",
      read.code === 0 ? "can" : `cannot (${read.err})`,
    );
    await stop(hub);
    // The folder was open before the hub started: else this test proves nothing.
    expect(before).not.toBe("closed");
    expect(before).toContain("inheritance is on");
    expect(opened).toBe(true);
    expect(folderVerdict).toBe("closed");
    expect(self.code).toBe(0);
    expect(other.code).toBe(77);
    expect(warned).toContain("The hub set the folder's own owner and list to the installer's");
    expect(warned).toContain("hub.db may be readable by other accounts");
  }, 300_000);

  test("as the service (a stand-in account): a top folder of its shape opens; what is inside is made to inherit", async () => {
    const standIn = sidOfAccount(OTHER_USER);
    row("the second account's SID (the stand-in service account)", "a SID", standIn);
    expect(shapeFolder(STAND_IN_SHAPED, standIn).code).toBe(0);
    const planted = join(STAND_IN_SHAPED, "planted.txt");
    writeFileSync(planted, "made by an administrator, with an entry for Everyone of its own");
    expect(icacls(planted, "/grant", "*S-1-1-0:(R)").code).toBe(0);
    const result = await runHelper("other", "windows-steps-as.ts", "steps-shaped", [
      STAND_IN_SHAPED,
    ]);
    row(
      "stand-in service, a top folder of its shape: the steps",
      "ok, nothing warned, planted.txt closed",
      result,
    );
    const parsed: unknown = JSON.parse(result.startsWith("{") ? result : "{}");
    expect(parsed).toMatchObject({
      service: standIn,
      prepared: "ok",
      warnings: [],
      top: "closed",
      inside: [{ name: "planted.txt", list: "closed" }],
    });
  }, 300_000);

  test("as the service (a stand-in account): an open top folder is refused with data_folder_open and left as it was; what is inside is made to inherit", async () => {
    const standIn = sidOfAccount(OTHER_USER);
    expect(shapeFolder(STAND_IN_OPEN, standIn, ["*S-1-5-32-545:(OI)(CI)(RX)"]).code).toBe(0);
    const planted = join(STAND_IN_OPEN, "planted.txt");
    writeFileSync(planted, "x");
    expect(icacls(planted, "/grant", "*S-1-1-0:(R)").code).toBe(0);
    const topBefore = listVerdict(STAND_IN_OPEN, { top: true, mode: "service" }, standIn);
    const result = await runHelper("other", "windows-steps-as.ts", "steps-open", [STAND_IN_OPEN]);
    row(
      "stand-in service, an open top folder: the steps",
      "refused, data_folder_open, the top unchanged",
      result,
    );
    const topAfter = listVerdict(STAND_IN_OPEN, { top: true, mode: "service" }, standIn);
    const plantedAfter = icacls(planted);
    row(
      "stand-in service, an open top folder: planted.txt's list after (icacls)",
      "no entry of its own for Everyone",
      plantedAfter.out,
    );
    const parsed: unknown = JSON.parse(result.startsWith("{") ? result : "{}");
    expect(topBefore).toContain("it lets in Users");
    expect(topAfter).toBe(topBefore);
    expect(parsed).toMatchObject({ warnings: [{ code: "data_folder_open", closed: false }] });
    expect(JSON.stringify(parsed)).toContain("the service cannot change it");
    expect(plantedAfter.out).not.toContain("Everyone:(R)");
  }, 300_000);

  test("the real hub as the service (a stand-in account): refuses an open top folder with data_folder_open; opens its shape, and hsn's peer check finds it", async () => {
    const standIn = sidOfAccount(OTHER_USER);
    expect(shapeFolder(STAND_IN_HUB_OPEN, standIn, ["*S-1-5-32-545:(OI)(CI)(RX)"]).code).toBe(0);
    expect(shapeFolder(STAND_IN_HUB, standIn).code).toBe(0);
    const hubArgs = (folder: string) => [
      "--data",
      folder,
      "--port",
      "0",
      "--no-usb-watch",
      "--app-ports",
      "0,0",
    ];
    const heardOpen = join(OUT, "standin-open-warnings.jsonl");
    rmSync(heardOpen, { force: true });
    const refusing = startAsOther(
      password,
      join(BIN, "bun.exe"),
      [join(import.meta.dir, "windows-hub-as.ts"), heardOpen, ...hubArgs(STAND_IN_HUB_OPEN)],
      BIN,
    );
    const warned = await until(() => existsSync(heardOpen), 90_000);
    await Bun.sleep(2000);
    const openSocket = existsSync(join(STAND_IN_HUB_OPEN, "control.sock"));
    refusing.stop();
    const heard = existsSync(heardOpen) ? readFileSync(heardOpen, "utf8") : "(nothing heard)";
    row(
      "the real hub as the stand-in service, an open top folder: what it warned",
      "data_folder_open",
      heard,
    );
    row(
      "the real hub as the stand-in service, an open top folder: its socket",
      "none",
      openSocket ? "opened" : "none",
    );
    const heardShaped = join(OUT, "standin-shaped-warnings.jsonl");
    rmSync(heardShaped, { force: true });
    const serving = startAsOther(
      password,
      join(BIN, "bun.exe"),
      [join(import.meta.dir, "windows-hub-as.ts"), heardShaped, ...hubArgs(STAND_IN_HUB)],
      BIN,
    );
    const socket = join(STAND_IN_HUB, "control.sock");
    const opened = await until(() => existsSync(socket), 90_000);
    const previous = hubAccount.sid;
    hubAccount.sid = standIn;
    const self = await hsnUntilAnswered(STAND_IN_HUB);
    hubAccount.sid = previous;
    row(
      "the real hub as the stand-in service, its shape: hsn, elevated",
      "0",
      `${self.code}${self.code === 0 ? "" : `: ${self.err}`}`,
    );
    const peer = checkHubPeer(socket, standIn);
    row(
      "hsn.exe's peer check on the stand-in's socket, expecting the stand-in",
      "accepted",
      peer.isOk() ? `accepted: ${JSON.stringify(peer.value)}` : JSON.stringify(peer.error),
    );
    const notTheHub = checkHubPeer(socket, HUB_SERVICE_SID);
    row(
      "hsn.exe's peer check on the stand-in's socket, expecting NT SERVICE\\HSNHub",
      "notTheHub",
      notTheHub.isErr() ? notTheHub.error.kind : "accepted",
    );
    const owner = listVerdict(socket, { top: false }, standIn);
    row("the stand-in service's socket file, by the rule", "closed", owner);
    serving.stop();
    expect(refusing.started && serving.started).toBe(true);
    expect(warned).toBe(true);
    expect(heard).toContain("data_folder_open");
    expect(openSocket).toBe(false);
    expect(opened).toBe(true);
    expect(self.code).toBe(0);
    expect(peer.isOk()).toBe(true);
    expect(notTheHub.isErr() ? notTheHub.error.kind : "accepted").toBe("notTheHub");
    expect(owner).toBe("closed");
  }, 600_000);

  test("hsn.exe's elevation: elevated from an elevated prompt, not elevated from a normal one", async () => {
    const elevated = await runHelper("self", "windows-elevation-as.ts", "elevation-self", []);
    const normal = await runHelper("unelevated", "windows-elevation-as.ts", "elevation-normal", []);
    const other = await runHelper("other", "windows-elevation-as.ts", "elevation-other", []);
    row("hsn.exe's elevation, elevated", "elevated", elevated);
    row(
      "hsn.exe's elevation, a normal prompt (restricted copy)",
      "Administrators not enabled",
      normal,
    );
    row("hsn.exe's elevation, an ordinary account", "notElevated", other);
    const parse = (text: string): unknown => JSON.parse(text.startsWith("{") ? text : "{}");
    expect(parse(elevated)).toEqual({
      kind: "elevated",
      administratorsEnabled: true,
      tokenElevated: true,
    });
    // The runner's normal prompt is a restricted copy of an elevated token (windows-accounts.ts):
    // Administrators deny-only, as UAC's filtered token holds it; whether that copy still says
    // "elevated" is recorded, not asserted (a real UAC token does not, and the answer is then
    // "elevated", the stricter rules, which is safe).
    expect(parse(normal)).toMatchObject({ administratorsEnabled: false });
    expect(parse(other)).toEqual({
      kind: "notElevated",
      administratorsEnabled: false,
      tokenElevated: false,
    });
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

  /**
   * Every account against every state, for hub/cli's rule (A2): an account that cannot list the
   * data folder is kept out (77); one that can, or a folder that does not exist, is "not running"
   * (69). Each row has hsn's answer and the probe's raw facts (the listing, the connect error), so
   * a wrong answer shows which fact the rule misread.
   */
  test("who is told what: each account, with the hub running, not running, and the folder missing (hub/cli's change)", async () => {
    const seen: string[] = [];
    const check = async (
      who: Who,
      state: string,
      folder: string,
      expected: number,
    ): Promise<void> => {
      const label = `${who}-${state}-${folder.split("\\").at(-1) ?? ""}`.replaceAll(" ", "-");
      const answer = await hsnAs(who, `who-${label}`, ["--data", folder, "status"]);
      row(`hsn as ${who}, ${state}, ${folder}`, String(expected), `${answer.code}: ${answer.err}`);
      await probe(who, `${state}, ${folder}`, folder);
      if (answer.code !== expected)
        seen.push(`${who}, ${state}, ${folder}: ${answer.code}, expected ${expected}`);
    };
    for (const hub of hubs.splice(0)) {
      hub.kill();
      await hub.exited;
    }
    for (const who of ["self", "unelevated", "other"] as const) {
      await check(who, "no hub", MISSING, 69);
      await check(who, "no hub", EMPTY, 69);
    }
    await check("self", "no hub", ADMINS_ONLY, 69);
    await check("unelevated", "no hub", ADMINS_ONLY, 77);
    await check("other", "no hub", ADMINS_ONLY, 77);
    await check("other", "no hub", LOCKED, 77);
    const hub = await startAndWait(ADMINS_ONLY);
    await hsnUntilAnswered(ADMINS_ONLY);
    await check("self", "hub running", ADMINS_ONLY, 0);
    await check("unelevated", "hub running", ADMINS_ONLY, 77);
    await check("other", "hub running", ADMINS_ONLY, 77);
    await stop(hub);
    expect(seen).toEqual([]);
  }, 600_000);
});

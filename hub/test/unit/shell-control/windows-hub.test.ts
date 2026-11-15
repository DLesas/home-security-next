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
import { icacls, isWindows, lockFolder, lockFolderTo, ordinaryFolder } from "./windows-folders.ts";

const enabled = isWindows && process.env.HSN_WINDOWS_SECOND_ACCOUNT === "1";
const REPO = join(import.meta.dir, "..", "..", "..", "..");
const BASE = join(process.env.SystemDrive ?? "C:", "\\", "hsn-a11-hub");
const BIN = join(BASE, "bin");
const OUT = join(BASE, "out");
const LOCKED = join(BASE, "locked");
const OPEN = join(BASE, "open", "data");
const ADMINS_ONLY = join(BASE, "admins");
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

interface Hsn {
  readonly code: number;
  readonly err: string;
}

/** `hsn --data <folder> status` as this account: the real `hub/cli/hsn.ts`. */
async function hsnAsSelf(folder: string): Promise<Hsn> {
  const env: Record<string, string | undefined> = { ...process.env, HSN_DATA_DIR: undefined };
  const ran = Bun.spawn(
    [process.execPath, join(REPO, "hub", "cli", "hsn.ts"), "--data", folder, "status"],
    {
      cwd: REPO,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const err = await new Response(ran.stderr).text();
  return { code: await ran.exited, err: err.trim() };
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

interface Ran extends Hsn {
  readonly user: string;
}

/** Reads what `windows-hsn-as.ts` wrote, or says why there is nothing. */
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

/** `windows-hsn-as.ts` with `args`, as the second account. */
async function asOther(label: string, args: readonly string[]): Promise<Ran> {
  const result = join(OUT, `${label}.json`);
  rmSync(result, { force: true });
  const logon = await runAsOther(
    password,
    join(BIN, "bun.exe"),
    [join(import.meta.dir, "windows-hsn-as.ts"), result, ...args],
    BIN,
  );
  return resultOf(result, logon);
}

/** The same as this account from a normal prompt: Administrators deny-only. */
async function asUnelevated(label: string, args: readonly string[]): Promise<Ran> {
  const result = join(OUT, `${label}.json`);
  rmSync(result, { force: true });
  const logon = await runUnelevated(
    process.execPath,
    [join(import.meta.dir, "windows-hsn-as.ts"), result, ...args],
    BIN,
  );
  return resultOf(result, logon);
}

const hsnAsOther = (folder: string, label: string) => asOther(label, ["--data", folder, "status"]);

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
  rmSync(BASE, { recursive: true, force: true });
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
});

afterAll(async () => {
  if (!enabled) return;
  for (const hub of hubs.splice(0)) {
    hub.kill();
    await hub.exited;
  }
  removeOtherUser();
  rmSync(BASE, { recursive: true, force: true });
});

describe.skipIf(!enabled)("Windows: the real hub's command socket, reached by hsn", () => {
  test("no hub yet: hsn says the hub is not running (69)", async () => {
    const self = await hsnAsSelf(LOCKED);
    row("no hub: hsn as the hub's account", "69, not running", `${self.code}: ${self.err}`);
    expect(self.code).toBe(69);
    expect(self.err).toContain("the hub is not running");
  });

  test("the second account can run hsn at all (else the tests below prove nothing)", async () => {
    const other = await hsnAsOther(LOCKED, "first");
    row(
      "second account: hsn runs as it",
      `runs as ${OTHER_USER}`,
      `${other.user}, ${other.code}: ${other.err}`,
    );
    expect(other.user.toLowerCase()).toBe(OTHER_USER);
  });

  test("the hub in a locked folder: hsn as its account is answered (0); the second account may not (77)", async () => {
    const hub = startHub(LOCKED);
    const socket = join(LOCKED, "control.sock");
    const opened = await until(
      () => existsSync(socket) || hub.said().includes("could not open"),
      90_000,
    );
    row(
      "hub in a locked folder: its socket",
      "opens",
      opened && existsSync(socket) ? "opens" : hub.said(),
    );
    expect(existsSync(socket)).toBe(true);
    const self = await hsnUntilAnswered(LOCKED);
    row(
      "hsn status as the hub's account",
      "0",
      `${self.code}${self.code === 0 ? "" : `: ${self.err}`}`,
    );
    expect(self.code).toBe(0);
    const other = await hsnAsOther(LOCKED, "locked");
    row("hsn status as the second account", "77, may not open", `${other.code}: ${other.err}`);
    expect(other.code).toBe(77);
    expect(other.err).toContain("this account may not open");
    const read = await asOther("read-locked", ["--read", join(LOCKED, "hub.db")]);
    row(
      "the second account reads hub.db",
      "cannot",
      read.code === 0 ? "can" : `cannot (${read.err})`,
    );
    expect(read.code).toBe(1);
    await stop(hub);
    row("hub killed: its socket file", "left behind", existsSync(socket) ? "left behind" : "gone");
    const stale = await hsnAsSelf(LOCKED);
    row("hub killed: hsn as the hub's account", "69, not running", `${stale.code}: ${stale.err}`);
    expect(stale.code).toBe(69);
    const again = startHub(LOCKED);
    const after = await hsnUntilAnswered(LOCKED);
    row(
      "hub started again over the old socket file: hsn",
      "0",
      `${after.code}${after.code === 0 ? "" : `: ${after.err} / hub: ${again.said()}`}`,
    );
    expect(after.code).toBe(0);
    await stop(again);
  }, 300_000);

  test("a data folder made open before the hub's first start is closed by it, with the warning", async () => {
    const hub = await startAndWait(OPEN);
    const warned =
      hub
        .said()
        .split("\n")
        .find((line) => line.includes("data_folder_was_open")) ?? "(no warning)";
    row("open folder at first start: the hub warns", "data_folder_was_open, closed", warned);
    expect(warned).toContain("the hub set its list");
    expect(existsSync(join(OPEN, "control.sock"))).toBe(true);
    const list = icacls(OPEN);
    row("open folder at first start: its list after", "the three accounts, protected", list.out);
    const self = await hsnUntilAnswered(OPEN);
    row(
      "open folder closed: hsn as the hub's account",
      "0",
      `${self.code}${self.code === 0 ? "" : `: ${self.err}`}`,
    );
    expect(self.code).toBe(0);
    const other = await hsnAsOther(OPEN, "open");
    row(
      "open folder closed: hsn as the second account",
      "77, may not open",
      `${other.code}: ${other.err}`,
    );
    expect(other.code).toBe(77);
    const read = await asOther("read-open", ["--read", join(OPEN, "hub.db")]);
    row(
      "open folder closed: the second account reads hub.db (made before it was closed)",
      "cannot",
      read.code === 0 ? "can" : `cannot (${read.err})`,
    );
    expect(read.code).toBe(1);
    await stop(hub);
  }, 300_000);

  test("an administrator: answered from an elevated prompt, refused (77) from a normal one", async () => {
    const hub = await startAndWait(ADMINS_ONLY);
    expect(existsSync(join(ADMINS_ONLY, "control.sock"))).toBe(true);
    const elevated = await hsnUntilAnswered(ADMINS_ONLY);
    row(
      "folder for Administrators and SYSTEM: hsn, elevated",
      "0",
      `${elevated.code}${elevated.code === 0 ? "" : `: ${elevated.err}`}`,
    );
    expect(elevated.code).toBe(0);
    const normal = await asUnelevated("unelevated", ["--data", ADMINS_ONLY, "status"]);
    row(
      "the same administrator from a normal prompt",
      "77, says to use an administrator prompt",
      `${normal.code}: ${normal.err}`,
    );
    expect(normal.code).toBe(77);
    await stop(hub);
  }, 300_000);

  test("from a normal prompt, hsn says to run it from an administrator prompt (hub/cli's message)", async () => {
    const hub = await startAndWait(ADMINS_ONLY);
    const normal = await asUnelevated("unelevated-message", ["--data", ADMINS_ONLY, "status"]);
    expect(normal.err).toContain("administrator prompt");
    await stop(hub);
  }, 300_000);
});

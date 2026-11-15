/**
 * Opening the console's one-time address in the ordinary user's browser without putting it on any
 * command line (m2-design.md section 5, "The console"; section 11, "Step 1, wave 2"). `hsn` runs
 * as an administrator (section 9: `sudo hsn` on macOS and Linux, an elevated prompt on Windows),
 * the browser as the ordinary user, so:
 *
 * 1. **The user.** macOS and Linux: under `sudo`, the account that ran it (`SUDO_UID`,
 *    `SUDO_USER`), never root; run by an ordinary account (a development hub), that account. Its
 *    home folder from the system's directory (`dscl` on macOS, `getent passwd` on Linux), checked
 *    against the uid. On macOS it must also be the user at the screen (the owner of
 *    `/dev/console`), whose session the browser opens in. Windows: the elevated prompt's own user
 *    (`USERNAME`, `%LOCALAPPDATA%`, its SID from `whoami /user`), since UAC elevates the same
 *    account.
 * 2. **The page**, a random name in the user's own folder: macOS `~/Library/Caches/HSN Hub/`,
 *    Linux `$XDG_RUNTIME_DIR/hsn-hub/` (`/run/user/<uid>`, when it is the user's) or
 *    `~/.cache/hsn-hub/`, Windows `%LOCALAPPDATA%\HSN Hub\`. On macOS and Linux it is written by a
 *    shell running *as the user* (`sudo -u`), the address on its standard input, with `umask 077`,
 *    the folder `chmod 700` and the file refused if anything is there, so root never writes into a
 *    folder the user controls; then checked, without following links: a folder and a file of the
 *    user's, readable by no one else. On Windows the folder's access list is set to the user's SID,
 *    SYSTEM and Administrators only, inheritance removed, before the file is written. The page
 *    holds a script that replaces itself with the address (`location.replace`, so it stays out of
 *    the history).
 * 3. **The browser**, opened at the page's path, which is no secret, as the user: `launchctl asuser
 *    <uid> sudo -u <user> open` on macOS; `sudo -u <user> env XDG_RUNTIME_DIR=… DBUS_SESSION_BUS_ADDRESS=…
 *    xdg-open` on Linux, in the user's session; `explorer.exe`, which hands the path to the user's
 *    unelevated shell, on Windows.
 * 4. **The wait**: until the page has been read (its access time passes its write), or until the
 *    token expires (2 minutes ‡); then the page is deleted, as the user, and `hsn` says which.
 *
 * When any step cannot be done, `hsn open` refuses and says why; it never falls back to a command
 * line, and never prints the address. The installers' first opening (A8) calls
 * `openConsoleAddress` with the same system.
 */
import { err, ok, Result } from "neverthrow";
import { PAGE_FS, type PageFs } from "./files.ts";

/** What a program run came to; a spawn that throws is code -1. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
}

/** What `hsn open`'s page needs of the computer; tests give their own. */
export interface PageSystem {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The effective user id; undefined on Windows. */
  readonly euid: number | undefined;
  /** Runs a program; `stdin` is the only way anything secret reaches one. */
  readonly run: (argv: readonly string[], stdin?: string) => Promise<Ran>;
  readonly fs: PageFs;
  /** 16 random bytes, as hex, for the page's name. */
  readonly random: () => string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The ordinary user whose browser opens. */
export interface PageUser {
  readonly name: string;
  /** Undefined on Windows. */
  readonly uid: number | undefined;
  readonly home: string;
  /** Windows: the user's SID, for the folder's access list. */
  readonly sid: string | undefined;
  /** What runs a program as the user: `sudo -u <user> --` under sudo, nothing otherwise. */
  readonly asUser: readonly string[];
  /** Whether `hsn` runs as root for this user (under sudo). */
  readonly elevated: boolean;
}

/** How opening the page ended: it was read, or the token expired first. */
export type PageOutcome = "read" | "unread";

/** How often the page's access time is looked at while waiting. */
export const PAGE_POLL_MS = 200;

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const SID = /^S-1-5(?:-\d+)+$/u;

/**
 * The shell that writes the page as the user, the page on its standard input (its paths are
 * absolute, so never read as options). Its folder is made and kept only theirs, and nothing is
 * written through a link: a folder that is one is refused after `mkdir -p` (which leaves an
 * existing one as it is) and before `chmod`; anything at the page's path (a file, a link, a pipe)
 * refuses the write; and `set -C` closes the moment between that test and the write, since a file
 * that appears then fails its exclusive creation.
 */
export const WRITE_SCRIPT =
  'umask 077 && mkdir -p -- "$1" && [ -d "$1" ] && [ ! -L "$1" ] && chmod 700 "$1" && ' +
  '[ ! -e "$2" ] && [ ! -L "$2" ] && set -C && cat > "$2"';

/**
 * The shell that deletes the page as the user: never through a folder that has become a link, and
 * `rm` removes a link at the page's path itself, never what it points at.
 */
export const DELETE_SCRIPT = '[ ! -L "$1" ] && [ -d "$1" ] && rm -f -- "$2"';

/** The page: a script that puts the address in place of the page, out of the history. */
export function pageHtml(url: string): string {
  const quoted = JSON.stringify(url).replaceAll("<", "\\u003c");
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    "<title>HSN hub</title>",
    `<script>location.replace(${quoted});</script>`,
    "",
  ].join("\n");
}

/** The real computer. */
export function realPageSystem(): PageSystem {
  return {
    platform: process.platform,
    env: process.env,
    euid: process.geteuid?.(),
    run: async (argv, stdin) => {
      const spawned = spawnSafely(argv, stdin);
      if (spawned === undefined) return { code: -1, stdout: "" };
      const [code, stdout] = await Promise.all([
        spawned.exited,
        new Response(spawned.stdout).text(),
      ]);
      return { code, stdout };
    },
    fs: PAGE_FS,
    random: () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

function spawnSafely(argv: readonly string[], stdin: string | undefined) {
  // Bun.spawn throws when the program does not exist: caught without `try` (hub-design.md 10).
  const started = Result.fromThrowable(
    () =>
      Bun.spawn([...argv], {
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "ignore",
      }),
    () => undefined,
  )();
  return started.unwrapOr(undefined);
}

/** The home folder of a user, from the system's directory, checked against the uid. */
async function homeOf(sys: PageSystem, name: string, uid: number): Promise<Result<string, string>> {
  if (sys.platform === "darwin") {
    const read = await sys.run([
      "dscl",
      ".",
      "-read",
      `/Users/${name}`,
      "NFSHomeDirectory",
      "UniqueID",
    ]);
    const home = /^NFSHomeDirectory:\s*(\/.*)$/mu.exec(read.stdout)?.[1]?.trim();
    const id = /^UniqueID:\s*(\d+)$/mu.exec(read.stdout)?.[1];
    if (read.code !== 0 || home === undefined || Number(id) !== uid) {
      return err(`the home folder of ${name} could not be found`);
    }
    return ok(home);
  }
  const read = await sys.run(["getent", "passwd", name]);
  const fields = read.stdout.trim().split(":");
  if (
    read.code !== 0 ||
    fields.length < 7 ||
    Number(fields[2]) !== uid ||
    !(fields[5] ?? "").startsWith("/")
  ) {
    return err(`the home folder of ${name} could not be found`);
  }
  return ok(fields[5] ?? "");
}

/** The ordinary user whose browser `hsn open` opens (the module's comment, step 1). */
export async function findPageUser(sys: PageSystem): Promise<Result<PageUser, string>> {
  if (sys.platform === "win32") {
    const name = sys.env.USERNAME ?? "";
    const home = sys.env.LOCALAPPDATA ?? "";
    if (name === "" || home === "") return err("no user folder (%LOCALAPPDATA%) is known");
    const who = await sys.run(["whoami", "/user", "/fo", "csv", "/nh"]);
    const sid = /"(S-1-5(?:-\d+)+)"/u.exec(who.stdout)?.[1];
    if (who.code !== 0 || sid === undefined || !SID.test(sid))
      return err("the user's SID could not be found");
    return ok({ name, uid: undefined, home, sid, asUser: [], elevated: false });
  }
  if (sys.platform !== "darwin" && sys.platform !== "linux") {
    return err(`hsn open does not know how to open a browser on ${sys.platform}`);
  }
  const elevated = sys.euid === 0;
  const name = elevated ? sys.env.SUDO_USER : (sys.env.USER ?? sys.env.LOGNAME);
  const uid = elevated ? Number(sys.env.SUDO_UID) : sys.euid;
  if (elevated && (sys.env.SUDO_UID === undefined || !Number.isInteger(uid) || uid === 0)) {
    return err(
      "run it as sudo hsn open from the account whose browser should open; it never opens one as root",
    );
  }
  if (name === undefined || !NAME.test(name) || uid === undefined || !Number.isInteger(uid)) {
    return err("the user whose browser should open is not known");
  }
  const home = await homeOf(sys, name, uid);
  if (home.isErr()) return err(home.error);
  if (sys.platform === "darwin" && sys.fs.lstat("/dev/console")?.uid !== uid) {
    return err(`${name} is not the user at this computer's screen, where the browser would open`);
  }
  return ok({
    name,
    uid,
    home: home.value,
    sid: undefined,
    asUser: elevated ? ["sudo", "-u", name, "--"] : [],
    elevated,
  });
}

/** The user's own folder for the page (the module's comment, step 2). */
export function pageFolder(sys: PageSystem, user: PageUser): string {
  if (sys.platform === "win32") return `${user.home}\\HSN Hub`;
  if (sys.platform === "darwin") return `${user.home}/Library/Caches/HSN Hub`;
  const runtime = user.elevated
    ? `/run/user/${String(user.uid)}`
    : (sys.env.XDG_RUNTIME_DIR ?? `/run/user/${String(user.uid)}`);
  const st = sys.fs.lstat(runtime);
  return st?.isDirectory === true && !st.isLink && st.uid === user.uid
    ? `${runtime}/hsn-hub`
    : `${user.home}/.cache/hsn-hub`;
}

/** The command that opens `path` in the user's browser (the module's comment, step 3). */
export function openCommand(sys: PageSystem, user: PageUser, path: string): readonly string[] {
  if (sys.platform === "win32") return ["explorer.exe", path];
  if (sys.platform === "darwin") {
    return user.elevated
      ? ["launchctl", "asuser", String(user.uid), ...user.asUser, "open", path]
      : ["open", path];
  }
  if (!user.elevated) return ["xdg-open", path];
  const uid = String(user.uid);
  const display = ["DISPLAY", "WAYLAND_DISPLAY"].flatMap((v) => {
    const value = sys.env[v];
    return value === undefined || !/^[A-Za-z0-9:._-]+$/u.test(value) ? [] : [`${v}=${value}`];
  });
  return [
    ...user.asUser,
    "env",
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
    ...display,
    "xdg-open",
    path,
  ];
}

/** Only the user's, readable by no one else, and no link. */
function onlyTheirs(sys: PageSystem, user: PageUser, path: string, folder: boolean): boolean {
  const st = sys.fs.lstat(path);
  if (st === undefined || st.isLink || (folder ? !st.isDirectory : !st.isFile)) return false;
  if (sys.platform === "win32") return true;
  return st.uid === user.uid && (st.mode & 0o077) === 0;
}

/** Whether a path is absent, or a folder that is not a link (a junction, on Windows). */
function noLink(sys: PageSystem, path: string): boolean {
  const st = sys.fs.lstat(path);
  return st === undefined || (st.isDirectory && !st.isLink);
}

async function removePage(
  sys: PageSystem,
  user: PageUser,
  folder: string,
  path: string,
): Promise<boolean> {
  if (sys.platform === "win32") {
    if (!noLink(sys, folder) || sys.fs.lstat(folder) === undefined) return false;
    sys.fs.remove(path).match(
      () => undefined,
      () => undefined,
    );
  } else {
    await sys.run([...user.asUser, "/bin/sh", "-c", DELETE_SCRIPT, "sh", folder, path]);
  }
  return sys.fs.lstat(path) === undefined;
}

/** Writes the page (the module's comment, step 2); its path. */
async function writePage(
  sys: PageSystem,
  user: PageUser,
  url: string,
): Promise<Result<{ readonly folder: string; readonly path: string }, string>> {
  const folder = pageFolder(sys, user);
  const separator = sys.platform === "win32" ? "\\" : "/";
  const path = `${folder}${separator}console-${sys.random()}.html`;
  if (sys.platform === "win32") {
    // Elevated, and in a folder the user controls: nothing done through a link or junction, neither
    // the user's folder nor the page's, before the folder is made and its access list set.
    if (!noLink(sys, user.home) || sys.fs.lstat(user.home) === undefined || !noLink(sys, folder)) {
      return err(`the page's folder ${folder} is a link`);
    }
    const made = sys.fs.makeFolder(folder);
    if (made.isErr()) return err(made.error);
    const acl = await sys.run([
      "icacls",
      folder,
      "/inheritance:r",
      "/grant:r",
      `*${user.sid ?? ""}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ]);
    if (acl.code !== 0) return err("the page's folder could not be made the user's alone");
    if (!noLink(sys, folder)) return err(`the page's folder ${folder} is a link`);
    const written = sys.fs.writeNew(path, pageHtml(url));
    if (written.isErr()) return err(written.error);
  } else {
    const written = await sys.run(
      [...user.asUser, "/bin/sh", "-c", WRITE_SCRIPT, "sh", folder, path],
      pageHtml(url),
    );
    if (written.code !== 0) return err(`the page could not be written in ${folder}`);
  }
  if (!onlyTheirs(sys, user, folder, true) || !onlyTheirs(sys, user, path, false)) {
    await removePage(sys, user, folder, path);
    return err(`the page's folder ${folder} is not ${user.name}'s alone`);
  }
  return ok({ folder, path });
}

/**
 * Opens the console's address in the ordinary user's browser (the module's comment): writes the
 * page, opens it as the user, waits until it is read or the token expires, and deletes it.
 */
export async function openConsoleAddress(
  url: string,
  expiresInMs: number,
  sys: PageSystem = realPageSystem(),
): Promise<Result<PageOutcome, string>> {
  const user = await findPageUser(sys);
  if (user.isErr()) return err(user.error);
  const written = await writePage(sys, user.value, url);
  if (written.isErr()) return err(written.error);
  const { folder, path } = written.value;
  const opened = await sys.run(openCommand(sys, user.value, path));
  // `explorer.exe` answers 1 when it has handed the path on, so its code says nothing.
  if (sys.platform !== "win32" && opened.code !== 0) {
    await removePage(sys, user.value, folder, path);
    return err(`the browser could not be opened for ${user.value.name}`);
  }
  const deadline = sys.now() + expiresInMs;
  let outcome: PageOutcome = "unread";
  for (;;) {
    const st = sys.fs.lstat(path);
    if (st !== undefined && st.atimeMs > st.mtimeMs) {
      outcome = "read";
      break;
    }
    if (st === undefined || sys.now() >= deadline) break;
    await sys.sleep(PAGE_POLL_MS);
  }
  if (!(await removePage(sys, user.value, folder, path)))
    return err(`the page ${path} could not be deleted`);
  return ok(outcome);
}

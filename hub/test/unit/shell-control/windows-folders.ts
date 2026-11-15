/**
 * Folders with real access lists, for the tests that run on Windows (the hosted runner of
 * `.github/workflows/windows-control-socket.yml`): set with the system's own `icacls`, by
 * well-known SIDs so nothing depends on the system's language, as spike W2 set them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ADMINISTRATORS_SID,
  checkDescriptor,
  parseSid,
  SYSTEM_SID,
} from "../../../src/shell/control/windows-acl.ts";
import { WINDOWS_CALLS } from "../../../src/shell/safe/control-socket-windows.ts";

export const isWindows = process.platform === "win32";

const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

/** A program of System32 by its full path, never found through PATH. */
export function system32(program: string): string {
  return join(SYSTEM32, program);
}

export interface Ran {
  readonly code: number | null;
  readonly out: string;
}

export function runProgram(program: string, args: readonly string[]): Ran {
  const ran = spawnSync(program, [...args], { encoding: "utf8", windowsHide: true });
  return { code: ran.status, out: `${ran.stdout}${ran.stderr}`.trim() };
}

export function icacls(path: string, ...args: string[]): Ran {
  return runProgram(system32("icacls.exe"), [path, ...args]);
}

/** This process's account, as the hub reads it. */
export function ownSid(): string {
  return parseSid(WINDOWS_CALLS.processSid()._unsafeUnwrap(), 0)._unsafeUnwrap().sid;
}

/**
 * Makes `path` and locks it as the installer does: inheritance off, full control for this
 * process's account, Administrators and SYSTEM (and `extra`), passed on to what is made inside.
 */
export function lockFolder(path: string, extra: readonly string[] = []): Ran {
  mkdirSync(path, { recursive: true });
  return icacls(
    path,
    "/inheritance:r",
    "/grant:r",
    ...[ownSid(), ADMINISTRATORS_SID, SYSTEM_SID, ...extra].map((sid) => `*${sid}:(OI)(CI)F`),
  );
}

/** A folder as Windows makes it: its list inherited from the folder above. */
export function ordinaryFolder(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** A junction (a directory link) at `link`, pointing at `target`. */
export function junction(link: string, target: string): Ran {
  return runProgram(system32("cmd.exe"), ["/d", "/c", "mklink", "/J", link, target]);
}

/** Makes `path` and locks it to exactly `sids` (this process's account not added). */
export function lockFolderTo(path: string, sids: readonly string[]): Ran {
  mkdirSync(path, { recursive: true });
  return icacls(path, "/inheritance:r", "/grant:r", ...sids.map((sid) => `*${sid}:(OI)(CI)F`));
}

/**
 * Removes a test's folder tree without throwing, and says what is left: the lists reset to
 * inherited first, since a test may have added a deny entry that names the runner's own account
 * (it is in Users), which makes `rmSync` fail with EPERM; then `rmdir /s /q`, which removes a
 * junction as a link and never what it points at. Remove junctions before calling this.
 */
export function removeTree(path: string): string {
  if (!existsSync(path)) return "removed";
  const reset = icacls(path, "/reset", "/T", "/C", "/Q");
  const removed = runProgram(system32("cmd.exe"), ["/d", "/c", "rmdir", "/s", "/q", path]);
  return existsSync(path)
    ? `left behind (icacls /reset ${reset.code}: ${reset.out.slice(0, 300)}; rmdir ${removed.code}: ${removed.out.slice(0, 300)})`
    : "removed";
}

/** What the hub's rule says of a path's real list now: "closed", or what it found. */
export function listVerdict(path: string, asFolder: boolean): string {
  const bytes = WINDOWS_CALLS.securityDescriptor(path);
  if (bytes.isErr()) return bytes.error.message;
  const checked = checkDescriptor(bytes.value, { hub: ownSid() }, asFolder);
  return checked.isOk() ? "closed" : checked.error.join("; ");
}

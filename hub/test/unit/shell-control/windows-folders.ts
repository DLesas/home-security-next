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
  checkContent,
  checkTopFolder,
  HUB_SERVICE_SID,
  parseSid,
  type RunMode,
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
 * Makes `path` a top folder of the shape the installer sets (m2-design.md section 9, "The top
 * folders"), with the system's own `icacls`, independently of the hub's own code: owner
 * Administrators, inheritance off, Administrators and SYSTEM in full control of it and its
 * contents, and `service` (the real `NT SERVICE\HSNHub` by default) with list, add a file, add a
 * folder, traverse, read attributes, read the list and synchronize on the folder itself (RD, WD,
 * AD, X, RA, RC, S: 0x001200a7) and inherit-only full control of what is inside. `extra` adds
 * entries (`*<sid>:<rights>`), to make it open. The steps fail on the first `icacls` that fails.
 */
export function shapeFolder(
  path: string,
  service: string = HUB_SERVICE_SID,
  extra: readonly string[] = [],
): Ran {
  mkdirSync(path, { recursive: true });
  const steps: string[][] = [
    ["/inheritance:r", "/grant:r", `*${ADMINISTRATORS_SID}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`],
    ["/grant", `*${service}:(RD,WD,AD,X,RA,RC,S)`],
    ["/grant", `*${service}:(OI)(CI)(IO)F`],
    ...extra.map((entry) => ["/grant", entry]),
    ["/setowner", `*${ADMINISTRATORS_SID}`],
  ];
  const outs: string[] = [];
  for (const step of steps) {
    const ran = icacls(path, ...step);
    outs.push(ran.out);
    if (ran.code !== 0) return { code: ran.code, out: outs.join(" / ") };
  }
  return { code: 0, out: outs.join(" / ") };
}

/** A folder as Windows makes it: its list inherited from the folder above. */
export function ordinaryFolder(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** A junction (a directory link) at `link`, pointing at `target`. */
export function junction(link: string, target: string): Ran {
  return runProgram(system32("cmd.exe"), ["/d", "/c", "mklink", "/J", link, target]);
}

/** Makes `path`, owned by Administrators, locked to exactly `sids` (full control, passed on). */
export function lockFolderTo(path: string, sids: readonly string[]): Ran {
  mkdirSync(path, { recursive: true });
  const granted = icacls(
    path,
    "/inheritance:r",
    "/grant:r",
    ...sids.map((sid) => `*${sid}:(OI)(CI)F`),
  );
  return granted.code === 0 ? icacls(path, "/setowner", `*${ADMINISTRATORS_SID}`) : granted;
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

/**
 * What the hub's rules say of a path's real list now: "closed", or what they found. `top` judges
 * it as a top folder in `mode`; otherwise as something inside one.
 */
export function listVerdict(
  path: string,
  as: { readonly top: true; readonly mode: RunMode } | { readonly top: false },
  service: string = HUB_SERVICE_SID,
): string {
  const bytes = WINDOWS_CALLS.securityDescriptor(path);
  if (bytes.isErr()) return bytes.error.message;
  const checked = as.top
    ? checkTopFolder(bytes.value, service, as.mode)
    : checkContent(bytes.value, service);
  return checked.isOk() ? "closed" : checked.error.join("; ");
}

/**
 * Folders with real access lists, for the tests that run on Windows (the hosted runner of
 * `.github/workflows/windows-control-socket.yml`): set with the system's own `icacls`, by
 * well-known SIDs so nothing depends on the system's language, as spike W2 set them.
 */
import { dlopen, FFIType } from "bun:ffi";
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
  topShapeSddl,
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
 * folders"), as A8's `tree.ps1` sets it: the SDDL text (`topShapeSddl`, the text of
 * `hub-folder.sddl`) turned into a descriptor by Windows itself
 * (`ConvertStringSecurityDescriptorToSecurityDescriptorW`), not by the hub's own byte builder,
 * and set on the folder's handle by `SetKernelObjectSecurity`. Not `icacls`: it will not grant a
 * SID it cannot name, and `NT SERVICE\HSNHub` has no name on a runner where the service is not
 * installed (run 43866716434: "No mapping between account names and security IDs was done").
 * `extra` adds SDDL entries, `(A;…)` after the shape's and `(D;…)` before them, to make it open
 * or add a deny. `out` says what failed.
 */
export function shapeFolder(
  path: string,
  service: string = HUB_SERVICE_SID,
  extra: readonly string[] = [],
): Ran {
  mkdirSync(path, { recursive: true });
  const shape = topShapeSddl(service);
  const at = shape.indexOf("(");
  const denies = extra.filter((entry) => entry.startsWith("(D;")).join("");
  const allows = extra.filter((entry) => !entry.startsWith("(D;")).join("");
  const sddl = `${shape.slice(0, at)}${denies}${shape.slice(at)}${allows}`;
  return setSddl(path, sddl);
}

/**
 * Sets `path`'s owner and list from SDDL text, as A8's `tree.ps1` does: Windows' own converter,
 * then `SetKernelObjectSecurity` on the object's no-follow handle. `out` is the SDDL, or what
 * failed.
 */
export function setSddl(path: string, sddl: string): Ran {
  const advapi = dlopen("advapi32.dll", {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    SetKernelObjectSecurity: {
      args: [FFIType.i64, FFIType.u32, FFIType.u64],
      returns: FFIType.i32,
    },
  }).symbols;
  const kernel = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i64,
    },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    LocalFree: { args: [FFIType.u64], returns: FFIType.u64 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
  const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
  const descriptor = new BigUint64Array(1);
  const size = new Uint32Array(1);
  if (
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, descriptor, size) ===
    0
  )
    return {
      code: kernel.GetLastError(),
      out: `ConvertStringSecurityDescriptorToSecurityDescriptorW refused ${sddl}`,
    };
  const sd = descriptor[0] ?? 0n;
  // READ_CONTROL | WRITE_DAC | WRITE_OWNER; share all; OPEN_EXISTING; backup semantics, no follow.
  const handle = kernel.CreateFileW(wide(path), 0x000e_0000, 7, null, 3, 0x0220_0000, null);
  if (handle === -1n) {
    const code = kernel.GetLastError();
    kernel.LocalFree(sd);
    return { code, out: `CreateFileW ${path} failed` };
  }
  // OWNER | DACL; the descriptor's own control bits carry "protected".
  const set = advapi.SetKernelObjectSecurity(handle, 0x5, sd);
  const code = set === 0 ? kernel.GetLastError() : 0;
  kernel.CloseHandle(handle);
  kernel.LocalFree(sd);
  return { code, out: set === 0 ? `SetKernelObjectSecurity ${path} failed with ${code}` : sddl };
}

/** "made" when a folder was made as asked, else what failed, for a test's expectation. */
export function made(ran: Ran): string {
  return ran.code === 0 ? "made" : `code ${String(ran.code)}: ${ran.out}`;
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

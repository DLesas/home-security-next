/**
 * A second local account, and running a program as it, for the Windows test against the real hub
 * (`windows-hub.test.ts`), as spike W2 did: the account made with `net user` (an ordinary member
 * of Users, not an administrator), its password made in the run and never printed, and the
 * program started with `CreateProcessWithLogonW` through `bun:ffi`, no PowerShell. Windows only:
 * nothing here is loaded until a function is called.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { type Ran, runProgram, system32 } from "./windows-folders.ts";

export const OTHER_USER = "hsna11test";

/** 14 characters, the most `net user` takes without asking, with every class the policy wants. */
export function newPassword(): string {
  return `Hs1!${randomBytes(8).toString("base64url").slice(0, 10)}`;
}

/** Makes the account, or resets its password. */
export function ensureOtherUser(password: string): Ran {
  const net = system32("net.exe");
  return runProgram(net, ["user", OTHER_USER]).code === 0
    ? runProgram(net, ["user", OTHER_USER, password])
    : runProgram(net, ["user", OTHER_USER, password, "/add", "/expires:never", "/passwordchg:no"]);
}

export function removeOtherUser(): Ran {
  return runProgram(system32("net.exe"), ["user", OTHER_USER, "/delete"]);
}

const LOGON_WITH_PROFILE = 1;
const CREATE_NO_WINDOW = 0x0800_0000;
const WAIT_OBJECT_0 = 0;
/** sizeof(STARTUPINFOW) and sizeof(PROCESS_INFORMATION) on x64. */
const STARTUPINFO_BYTES = 104;
const PROCESS_INFORMATION_BYTES = 24;

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

export interface Logon {
  readonly started: boolean;
  /** GetLastError when it could not start. */
  readonly error?: number;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
}

/** Runs `application` with `args` as the second account and waits for it, polling. */
export async function runAsOther(
  password: string,
  application: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<Logon> {
  const advapi = dlopen("advapi32.dll", {
    CreateProcessWithLogonW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  }).symbols;
  const kernel = dlopen("kernel32.dll", {
    GetLastError: { args: [], returns: FFIType.u32 },
    WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols;
  const commandLine = [application, ...args].map((a) => `"${a}"`).join(" ");
  const startup = new Uint8Array(STARTUPINFO_BYTES);
  new DataView(startup.buffer).setUint32(0, STARTUPINFO_BYTES, true);
  const info = new Uint8Array(PROCESS_INFORMATION_BYTES);
  const started = advapi.CreateProcessWithLogonW(
    wide(OTHER_USER),
    wide("."),
    wide(password),
    LOGON_WITH_PROFILE,
    wide(application),
    wide(commandLine),
    CREATE_NO_WINDOW,
    null,
    wide(cwd),
    startup,
    info,
  );
  if (started === 0) return { started: false, error: kernel.GetLastError() };
  const view = new DataView(info.buffer);
  const process = view.getBigUint64(0, true);
  const thread = view.getBigUint64(8, true);
  const deadline = Date.now() + timeoutMs;
  let done = false;
  while (!done && Date.now() < deadline) {
    done = kernel.WaitForSingleObject(process, 0) === WAIT_OBJECT_0;
    if (!done) await Bun.sleep(100);
  }
  const code = new Uint32Array(1);
  kernel.GetExitCodeProcess(process, code);
  kernel.CloseHandle(thread);
  kernel.CloseHandle(process);
  return { started: true, exitCode: code[0] ?? 0, timedOut: !done };
}

/** Administrators' SID, as bytes (S-1-5-32-544). */
const ADMINISTRATORS = new Uint8Array([1, 2, 0, 0, 0, 0, 0, 5, 0x20, 0, 0, 0, 0x20, 2, 0, 0]);
const TOKEN_ASSIGN_PRIMARY = 0x1;
const TOKEN_DUPLICATE = 0x2;
const TOKEN_QUERY = 0x8;
const TOKEN_ADJUST_DEFAULT = 0x80;
const DISABLE_MAX_PRIVILEGE = 0x1;

/**
 * Runs `application` as this account from "a normal prompt": a restricted copy of this
 * process's token in which Administrators is deny-only and the privileges are dropped, as UAC's
 * filtered token is for an administrator who has not elevated (the hosted runner's own logons
 * are always elevated, so this is how its normal prompt is made).
 */
export async function runUnelevated(
  application: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<Logon> {
  const advapi = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CreateRestrictedToken: {
      args: [
        FFIType.u64,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    CreateProcessAsUserW: {
      args: [
        FFIType.u64,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  }).symbols;
  const kernel = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: FFIType.u64 },
    GetLastError: { args: [], returns: FFIType.u32 },
    WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols;
  const own = new BigUint64Array(1);
  const access = TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT;
  if (advapi.OpenProcessToken(kernel.GetCurrentProcess(), access, own) === 0)
    return { started: false, error: kernel.GetLastError() };
  // SID_AND_ATTRIBUTES {PSID Sid; DWORD Attributes} on x64: 16 bytes.
  const disable = new Uint8Array(16);
  new DataView(disable.buffer).setBigUint64(0, BigInt(ptr(ADMINISTRATORS)), true);
  const restricted = new BigUint64Array(1);
  const made = advapi.CreateRestrictedToken(
    own[0] ?? 0n,
    DISABLE_MAX_PRIVILEGE,
    1,
    disable,
    0,
    null,
    0,
    null,
    restricted,
  );
  kernel.CloseHandle(own[0] ?? 0n);
  if (made === 0) return { started: false, error: kernel.GetLastError() };
  const token = restricted[0] ?? 0n;
  const commandLine = [application, ...args].map((a) => `"${a}"`).join(" ");
  const startup = new Uint8Array(STARTUPINFO_BYTES);
  new DataView(startup.buffer).setUint32(0, STARTUPINFO_BYTES, true);
  const info = new Uint8Array(PROCESS_INFORMATION_BYTES);
  const started = advapi.CreateProcessAsUserW(
    token,
    wide(application),
    wide(commandLine),
    null,
    null,
    0,
    CREATE_NO_WINDOW,
    null,
    wide(cwd),
    startup,
    info,
  );
  if (started === 0) {
    const error = kernel.GetLastError();
    kernel.CloseHandle(token);
    return { started: false, error };
  }
  const view = new DataView(info.buffer);
  const process = view.getBigUint64(0, true);
  const thread = view.getBigUint64(8, true);
  const deadline = Date.now() + timeoutMs;
  let done = false;
  while (!done && Date.now() < deadline) {
    done = kernel.WaitForSingleObject(process, 0) === WAIT_OBJECT_0;
    if (!done) await Bun.sleep(100);
  }
  const code = new Uint32Array(1);
  kernel.GetExitCodeProcess(process, code);
  kernel.CloseHandle(thread);
  kernel.CloseHandle(process);
  kernel.CloseHandle(token);
  return { started: true, exitCode: code[0] ?? 0, timedOut: !done };
}

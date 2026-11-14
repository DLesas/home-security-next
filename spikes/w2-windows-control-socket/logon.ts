/**
 * Running a program as another local account without PowerShell: `CreateProcessWithLogonW`
 * (advapi32) through `bun:ffi`, the call `Start-Process -Credential` makes underneath. Windows
 * only; imported by lib.ts only there. The process is waited for by polling, so the spike's own
 * server in this process goes on answering meanwhile.
 */
import { dlopen, FFIType } from "bun:ffi";

const LOGON_WITH_PROFILE = 1;
const CREATE_NO_WINDOW = 0x0800_0000;
const WAIT_OBJECT_0 = 0;
/** sizeof(STARTUPINFOW) and sizeof(PROCESS_INFORMATION) on x64. */
const STARTUPINFO_BYTES = 104;
const PROCESS_INFORMATION_BYTES = 24;

const advapi = dlopen("advapi32.dll", {
  CreateProcessWithLogonW: {
    args: [
      FFIType.ptr, // lpUsername
      FFIType.ptr, // lpDomain
      FFIType.ptr, // lpPassword
      FFIType.u32, // dwLogonFlags
      FFIType.ptr, // lpApplicationName
      FFIType.ptr, // lpCommandLine (writable)
      FFIType.u32, // dwCreationFlags
      FFIType.ptr, // lpEnvironment
      FFIType.ptr, // lpCurrentDirectory
      FFIType.ptr, // lpStartupInfo
      FFIType.ptr, // lpProcessInformation
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

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

export interface Logon {
  readonly started: boolean;
  /** GetLastError when it could not start (1326: bad user or password; 1385: logon type not granted). */
  readonly error?: number;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
}

/** Runs `application` with `args` as `.\user`, waits up to `timeoutMs`, and returns its exit code. */
export async function runAs(
  user: string,
  password: string,
  application: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<Logon> {
  const commandLine = [application, ...args].map((a) => `"${a}"`).join(" ");
  const startup = new Uint8Array(STARTUPINFO_BYTES);
  new DataView(startup.buffer).setUint32(0, STARTUPINFO_BYTES, true);
  const info = new Uint8Array(PROCESS_INFORMATION_BYTES);
  const ok = advapi.CreateProcessWithLogonW(
    wide(user),
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
  if (ok === 0) return { started: false, error: kernel.GetLastError() };
  const view = new DataView(info.buffer);
  const process = view.getBigUint64(0, true);
  const thread = view.getBigUint64(8, true);
  const pid = view.getUint32(16, true);
  const deadline = Date.now() + timeoutMs;
  let done = false;
  while (Date.now() < deadline) {
    if (kernel.WaitForSingleObject(process, 0) === WAIT_OBJECT_0) {
      done = true;
      break;
    }
    await Bun.sleep(100);
  }
  const code = new Uint32Array(1);
  kernel.GetExitCodeProcess(process, code);
  kernel.CloseHandle(thread);
  kernel.CloseHandle(process);
  return { started: true, pid, exitCode: code[0] ?? 0, timedOut: !done };
}

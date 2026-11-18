/** W1's Win32 communication calls. The DLL is loaded only on a Windows serial operation. */
import { dlopen, FFIType } from "bun:ffi";
import {
  devicePath,
  isByteClean,
  newDcb,
  serialTimeouts,
  setByteClean,
} from "./serial-windows-layout.ts";

export const WINDOWS_CALLS = {
  CreateFileW: {
    args: [
      FFIType.ptr,
      FFIType.u32,
      FFIType.u32,
      FFIType.ptr,
      FFIType.u32,
      FFIType.u32,
      FFIType.i64,
    ],
    returns: FFIType.i64,
  },
  GetCommState: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  SetCommState: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  SetCommTimeouts: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  PurgeComm: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i32 },
  ReadFile: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  WriteFile: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
} as const;

type SerialSymbols = ReturnType<typeof dlopen<typeof WINDOWS_CALLS>>["symbols"];
/** The Win32 calls, without Bun's wrapper metadata so tests can supply doubles. */
export type WindowsSerialCalls = {
  [Name in keyof SerialSymbols]: (
    ...args: Parameters<SerialSymbols[Name]>
  ) => ReturnType<SerialSymbols[Name]>;
};
let library: SerialSymbols | undefined;

/** The Windows kernel's communication functions, cached for the calling thread. */
export function serialCalls(): SerialSymbols {
  return (library ??= dlopen("kernel32.dll", WINDOWS_CALLS).symbols);
}

/** Converts a zero BOOL to an error with the Win32 code from the same thread. */
function succeeded(
  value: number,
  operation: string,
  calls: Pick<WindowsSerialCalls, "GetLastError">,
): void {
  if (value === 0) throw new Error(`${operation} failed (Win32 ${calls.GetLastError()})`);
}

/** Opens an exclusive device and verifies the DCB before the worker can read it. */
export function configuredPort(path: string, calls: WindowsSerialCalls): bigint {
  const device = devicePath(path);
  if (device === undefined) throw new Error("expected a Windows COM port name");
  const name = Uint16Array.from(device + "\0", (char) => char.charCodeAt(0));
  // GENERIC_READ | GENERIC_WRITE, no sharing, OPEN_EXISTING, no overlapped I/O.
  const handle = calls.CreateFileW(name, 0xc000_0000, 0, null, 3, 0, 0n);
  if (handle === -1n) throw new Error(`CreateFileW failed (Win32 ${calls.GetLastError()})`);
  let ready = false;
  try {
    const dcb = newDcb();
    succeeded(calls.GetCommState(handle, dcb), "GetCommState", calls);
    setByteClean(dcb);
    succeeded(calls.SetCommState(handle, dcb), "SetCommState", calls);
    const checked = newDcb();
    succeeded(calls.GetCommState(handle, checked), "GetCommState read-back", calls);
    if (!isByteClean(checked)) throw new Error("the serial port is not byte-clean");
    succeeded(calls.SetCommTimeouts(handle, serialTimeouts()), "SetCommTimeouts", calls);
    // PURGE_RXABORT | PURGE_RXCLEAR | PURGE_TXABORT | PURGE_TXCLEAR.
    succeeded(calls.PurgeComm(handle, 0x0f), "PurgeComm", calls);
    ready = true;
    return handle;
  } finally {
    if (!ready) calls.CloseHandle(handle);
  }
}

/** Reads the available bytes, or zero on timeout. Worker only. */
export function readPort(
  calls: Pick<WindowsSerialCalls, "ReadFile" | "GetLastError">,
  handle: bigint,
  into: Uint8Array,
  count: Uint32Array,
): number {
  succeeded(calls.ReadFile(handle, into, into.length, count, null), "ReadFile", calls);
  return count[0] ?? 0;
}

/** Sends one complete write, failing if Windows times it out partway. Worker only. */
export function writePort(
  calls: Pick<WindowsSerialCalls, "WriteFile" | "GetLastError">,
  handle: bigint,
  bytes: Uint8Array,
  count: Uint32Array,
): void {
  succeeded(calls.WriteFile(handle, bytes, bytes.length, count, null), "WriteFile", calls);
  if (count[0] !== bytes.length)
    throw new Error(`WriteFile sent ${count[0]} of ${bytes.length} bytes`);
}

/** Frees an already-configured port after its worker has stopped. */
export function releasePort(calls: WindowsSerialCalls, handle: bigint): void {
  succeeded(calls.CloseHandle(handle), "CloseHandle", calls);
}

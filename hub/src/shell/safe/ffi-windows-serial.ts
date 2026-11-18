/** W1's Win32 communication calls. The DLL is loaded only on a Windows serial operation. */
import { dlopen, FFIType, JSCallback } from "bun:ffi";
import {
  byteCleanMismatch,
  devicePath,
  newDcb,
  newOverlapped,
  serialTimeouts,
  setByteClean,
  type SerialLines,
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
  ReadFileEx: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  WriteFileEx: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  CreateEventW: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.i64,
  },
  SetEvent: { args: [FFIType.i64], returns: FFIType.i32 },
  WaitForMultipleObjectsEx: {
    args: [FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.i32],
    returns: FFIType.u32,
  },
  CancelIoEx: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  SleepEx: { args: [FFIType.u32, FFIType.i32], returns: FFIType.u32 },
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

/**
 * Converts a zero BOOL to an error. GetLastError is diagnostic only: between FFI calls
 * Bun or the runtime may overwrite the calling thread's last-error slot.
 */
export function succeeded(
  value: number,
  operation: string,
  calls: Pick<WindowsSerialCalls, "GetLastError">,
): void {
  if (value === 0) throw new Error(`${operation} failed (Win32 ${calls.GetLastError()})`);
}

/** Opens an exclusive device and verifies the DCB before the worker can read it. */
export function configuredPort(
  path: string,
  calls: WindowsSerialCalls,
  lines?: SerialLines,
): bigint {
  const device = devicePath(path);
  if (device === undefined) throw new Error("expected a Windows COM port name");
  const name = Uint16Array.from(device + "\0", (char) => char.charCodeAt(0));
  // GENERIC_READ | GENERIC_WRITE, no sharing, OPEN_EXISTING, FILE_FLAG_OVERLAPPED.
  const handle = calls.CreateFileW(name, 0xc000_0000, 0, null, 3, 0x4000_0000, 0n);
  if (handle === -1n) throw new Error(`CreateFileW failed (Win32 ${calls.GetLastError()})`);
  let ready = false;
  try {
    const dcb = newDcb();
    succeeded(calls.GetCommState(handle, dcb), "GetCommState", calls);
    setByteClean(dcb, lines);
    succeeded(calls.SetCommState(handle, dcb), "SetCommState", calls);
    const checked = newDcb();
    succeeded(calls.GetCommState(handle, checked), "GetCommState read-back", calls);
    const mismatch = byteCleanMismatch(checked, lines);
    if (mismatch !== undefined) throw new Error(`the serial port is not byte-clean: ${mismatch}`);
    succeeded(calls.SetCommTimeouts(handle, serialTimeouts()), "SetCommTimeouts", calls);
    // PURGE_RXABORT | PURGE_RXCLEAR | PURGE_TXABORT | PURGE_TXCLEAR.
    succeeded(calls.PurgeComm(handle, 0x0f), "PurgeComm", calls);
    ready = true;
    return handle;
  } finally {
    if (!ready) calls.CloseHandle(handle);
  }
}

export interface SerialWake {
  readonly stop: bigint;
  readonly write: bigint;
}

/** Creates a persistent stop event and a one-shot event for the single queued write. */
export function serialWake(calls: WindowsSerialCalls): SerialWake {
  const stop = calls.CreateEventW(null, 1, 0, null);
  if (stop === 0n) throw new Error(`CreateEventW (stop) failed (Win32 ${calls.GetLastError()})`);
  const write = calls.CreateEventW(null, 0, 0, null);
  if (write !== 0n) return { stop, write };
  const code = calls.GetLastError();
  calls.CloseHandle(stop);
  throw new Error(`CreateEventW (write) failed (Win32 ${code})`);
}

/** Signals a pending worker even if the event arrives before it begins waiting. */
export function signalSerial(calls: WindowsSerialCalls, event: bigint): void {
  succeeded(calls.SetEvent(event), "SetEvent", calls);
}

/** Releases all handles after the worker drains pending operations. */
export function releaseSerial(calls: WindowsSerialCalls, ...handles: bigint[]): void {
  let failed = false;
  for (const handle of handles) if (calls.CloseHandle(handle) === 0) failed = true;
  if (failed) throw new Error("CloseHandle failed");
}

export type SerialIoCalls = Pick<
  WindowsSerialCalls,
  | "ReadFileEx"
  | "WriteFileEx"
  | "WaitForMultipleObjectsEx"
  | "CancelIoEx"
  | "SleepEx"
  | "GetLastError"
>;

export type SerialCompletion = (
  complete: (code: number, count: number) => void,
) => Pick<JSCallback, "ptr" | "close">;

/** Win32 calls this back on the same worker while it is in an alertable wait. */
export const serialCompletion: SerialCompletion = (complete) =>
  new JSCallback(complete, {
    args: [FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.void,
  });

/** Owns an OVERLAPPED, its buffer and callback until Windows has delivered completion. */
export class OverlappedSerialOperation {
  readonly #overlapped = newOverlapped();
  readonly #callback: ReturnType<SerialCompletion>;
  #buffer: Uint8Array | undefined;
  #result: { code: number; count: number } | undefined;

  constructor(
    private readonly calls: SerialIoCalls,
    private readonly handle: bigint,
    private readonly functionName: "ReadFileEx" | "WriteFileEx",
    createCompletion: SerialCompletion,
  ) {
    this.#callback = createCompletion((code, count) => {
      this.#result = { code, count };
    });
  }

  /** A completion must still be delivered before freeing the buffer or callback. */
  get pending(): boolean {
    return this.#buffer !== undefined && this.#result === undefined;
  }

  /** Starts a request. The Ex functions distinguish submission failure by their BOOL return. */
  start(bytes: Uint8Array): void {
    this.#overlapped.fill(0);
    const started = this.calls[this.functionName](
      this.handle,
      bytes,
      bytes.length,
      this.#overlapped,
      this.#callback.ptr,
    );
    succeeded(started, this.functionName, this.calls);
    this.#buffer = bytes;
  }

  /** Takes the completed byte count and releases the buffer once the driver is finished. */
  take(): { bytes: Uint8Array; count: number } | undefined {
    const bytes = this.#buffer;
    const result = this.#result;
    if (bytes === undefined || result === undefined) return;
    this.#buffer = undefined;
    this.#result = undefined;
    if (result.code !== 0)
      throw new Error(`${this.functionName} completed with Windows error ${result.code}`);
    return { bytes, count: result.count };
  }

  /** Frees a callback only after the caller has drained its request. */
  close(): void {
    this.#callback.close();
  }
}

/** W1's registry change notice, with the wait on the serial worker. */
import { dlopen, FFIType } from "bun:ffi";

const KERNEL = {
  CreateEventW: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.i64,
  },
  WaitForSingleObject: { args: [FFIType.i64, FFIType.u32], returns: FFIType.u32 },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
} as const;

const REGISTRY = {
  RegOpenKeyExW: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  RegNotifyChangeKeyValue: {
    args: [FFIType.i64, FFIType.i32, FFIType.u32, FFIType.i64, FFIType.i32],
    returns: FFIType.i32,
  },
  RegCloseKey: { args: [FFIType.i64], returns: FFIType.i32 },
} as const;

/** Waits for port-map changes, including creation of SERIALCOMM on the first plug. */
export function watchDeviceMap(stopping: Int32Array, ready: () => void, changed: () => void): void {
  const kernel = dlopen("kernel32.dll", KERNEL);
  const registry = dlopen("advapi32.dll", REGISTRY);
  const event = kernel.symbols.CreateEventW(null, 0, 0, null);
  if (event === 0n) {
    const code = kernel.symbols.GetLastError();
    registry.close();
    kernel.close();
    throw new Error(`CreateEventW failed (Win32 ${code})`);
  }
  const keyOut = new BigInt64Array(1);
  const path = Uint16Array.from("HARDWARE\\DEVICEMAP\0", (char) => char.charCodeAt(0));
  try {
    // HKEY_LOCAL_MACHINE, no options, KEY_NOTIFY.
    const code = registry.symbols.RegOpenKeyExW(-2_147_483_646n, path, 0, 0x10, keyOut);
    if (code !== 0) throw new Error(`RegOpenKeyExW DEVICEMAP failed (Win32 ${code})`);
    const key = keyOut[0] ?? 0n;
    try {
      /** Rearms the one-shot notice before a scan, including names and values in the subtree. */
      const arm = (): void => {
        // REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET, asynchronous.
        const code = registry.symbols.RegNotifyChangeKeyValue(key, 1, 0x5, event, 1);
        if (code !== 0) throw new Error(`RegNotifyChangeKeyValue failed (Win32 ${code})`);
      };
      arm();
      ready();
      while (Atomics.load(stopping, 0) === 0) {
        const waited = kernel.symbols.WaitForSingleObject(event, 500);
        // WAIT_TIMEOUT lets the worker see a stop; it never causes a scan.
        if (waited === 0x102) continue;
        if (waited !== 0)
          throw new Error(`WaitForSingleObject failed (Win32 ${kernel.symbols.GetLastError()})`);
        if (Atomics.load(stopping, 0) !== 0) return;
        arm();
        changed();
      }
    } finally {
      registry.symbols.RegCloseKey(key);
    }
  } finally {
    kernel.symbols.CloseHandle(event);
    registry.close();
    kernel.close();
  }
}

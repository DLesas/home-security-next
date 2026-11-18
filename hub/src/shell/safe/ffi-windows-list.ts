/** List-only Win32 directory access, shared by the launcher and the hub. */
import { dlopen, FFIType } from "bun:ffi";

const FIND_FILES = {
  GetLastError: { args: [], returns: FFIType.u32 },
  FindFirstFileW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
  FindNextFileW: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  FindClose: { args: [FFIType.i64], returns: FFIType.i32 },
} as const;
let find: ReturnType<typeof dlopen<typeof FIND_FILES>>["symbols"] | undefined;

export const INVALID_HANDLE = -1n;
export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_PATH_NOT_FOUND = 3;
/** sizeof(WIN32_FIND_DATAW) on x64. */
export const FIND_DATA_BYTES = 592;

/** A Win32 failure, by its error code. */
export class Win32Failure extends Error {
  readonly code: string;

  constructor(call: string, code: number) {
    super(`${call} failed with Windows error ${code}`);
    this.code = `WIN32_${code}`;
  }
}

/** Encodes a null-terminated Win32 UTF-16 string. */
export function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

/** Decodes through the first UTF-16 null. */
export function fromWide(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("utf16le");
  const end = text.indexOf("\0");
  return end === -1 ? text : text.slice(0, end);
}

/** Where `cFileName` lies in WIN32_FIND_DATAW, and its length in UTF-16 units. */
const FIND_DATA_NAME = 44;
const FIND_DATA_NAME_UNITS = 260;
const ERROR_NO_MORE_FILES = 18;

/**
 * The names in a folder, by `FindFirstFileW`/`FindNextFileW`, which open it to list only. Not
 * `readdir`: Bun opens the folder for generic read, which asks for `FILE_READ_EA` too, a right the
 * service account does not hold on a top folder (run 43869303145: EPERM as the stand-in service).
 */
export function listWindowsDirectory(path: string): readonly string[] {
  const kernel = (find ??= dlopen("kernel32.dll", FIND_FILES).symbols);
  const data = new Uint8Array(FIND_DATA_BYTES);
  const search = kernel.FindFirstFileW(wide(`${path.replace(/[\\/]+$/u, "")}\\*`), data);
  if (search === INVALID_HANDLE) {
    const code = kernel.GetLastError();
    if (code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND) return [];
    throw new Win32Failure("FindFirstFileW", code);
  }
  const names: string[] = [];
  try {
    for (;;) {
      const name = fromWide(
        data.subarray(FIND_DATA_NAME, FIND_DATA_NAME + FIND_DATA_NAME_UNITS * 2),
      );
      if (name !== "." && name !== "..") names.push(name);
      if (kernel.FindNextFileW(search, data) === 0) {
        const code = kernel.GetLastError();
        if (code === ERROR_NO_MORE_FILES) break;
        throw new Win32Failure("FindNextFileW", code);
      }
    }
  } finally {
    kernel.FindClose(search);
  }
  return names;
}

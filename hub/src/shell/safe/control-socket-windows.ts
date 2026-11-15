/**
 * The Win32 calls the control socket needs on Windows (hub-design.md section 9; m2-design.md
 * section 9, W2), through `bun:ffi`, behind results (section 10). They only read: what is found
 * is decided in `shell/control/windows.ts`, from the bytes and numbers returned here, so the rule
 * is tested on every system with access lists given as data.
 *
 * Why the Win32 calls and not the system's own tool (`icacls`): `icacls` prints account names in
 * the system's language and its `/save` form uses SDDL's two-letter aliases, both of which would
 * have to be parsed back into accounts, and it costs a process per path (tens of milliseconds
 * each) found through `PATH`. These calls return the security descriptor and the process's SID as
 * the system holds them, language-free, in well under a millisecond, from two DLLs every Windows
 * process already has loaded. The bytes are parsed in TypeScript (`control/windows-acl.ts`), not
 * here, so a mistake there shows in tests on every system.
 *
 * One call writes: `setProtectedList`, the list the hub sets on a data folder it finds open
 * (m2-design.md section 9). It opens the folder by handle with `FILE_FLAG_OPEN_REPARSE_POINT`,
 * refuses the handle if it is a link (so a folder swapped for a junction after the check is never
 * followed), and sets the list on that handle with `SetSecurityInfo` as a protected list; Windows
 * passes its inheritable entries on to what the folder holds.
 *
 * Each object is opened with `FILE_FLAG_OPEN_REPARSE_POINT`, so a link is read as itself and
 * never followed, and an AF_UNIX socket file (a reparse point `stat` cannot open: spike W2) is
 * read too. The libraries are opened at the first call, never at import, so the module loads on
 * every system.
 */
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { folderNames } from "./fs.ts";
import { errorFrom } from "./thrown.ts";

const ORIGIN = "shell/safe/control-socket-windows";

/** What `FindFirstFileW` says of a path, without opening it. */
export interface FoundEntry {
  /** `dwFileAttributes`. */
  readonly attributes: number;
  /** `dwReserved0`: the reparse tag, when `attributes` has FILE_ATTRIBUTE_REPARSE_POINT. */
  readonly reparseTag: number;
}

/** The volume a path is on. */
export interface Volume {
  /** Its root, as `GetVolumePathNameW` gives it (`C:\`). */
  readonly root: string;
  /** `GetVolumeInformationW`'s file system flags. */
  readonly flags: number;
  /** `GetDriveTypeW`. */
  readonly driveType: number;
}

/** The calls `shell/control/windows.ts` makes; tests give their own, as data. */
export interface WindowsCalls {
  /** The SID of the account this process runs as (its token's user), as bytes. */
  readonly processSid: () => Result<Uint8Array, HubError>;
  /** The object's owner and access list, as a self-relative security descriptor. */
  readonly securityDescriptor: (path: string) => Result<Uint8Array, HubError>;
  /** `GetFileAttributesW`; undefined when nothing is there. */
  readonly attributes: (path: string) => Result<number | undefined, HubError>;
  /** `FindFirstFileW` on the path itself; undefined when nothing is there. */
  readonly findEntry: (path: string) => Result<FoundEntry | undefined, HubError>;
  readonly volume: (path: string) => Result<Volume, HubError>;
  /** The names in a folder. */
  readonly list: (path: string) => Result<readonly string[], HubError>;
  /** Sets `acl` (an `ACL`'s bytes) as the folder's protected list; refuses a link. */
  readonly setProtectedList: (path: string, acl: Uint8Array) => Result<void, HubError>;
}

const KERNEL32 = {
  GetLastError: { args: [], returns: FFIType.u32 },
  CreateFileW: {
    args: [
      FFIType.ptr, // lpFileName
      FFIType.u32, // dwDesiredAccess
      FFIType.u32, // dwShareMode
      FFIType.ptr, // lpSecurityAttributes
      FFIType.u32, // dwCreationDisposition
      FFIType.u32, // dwFlagsAndAttributes
      FFIType.ptr, // hTemplateFile
    ],
    returns: FFIType.i64,
  },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  LocalFree: { args: [FFIType.u64], returns: FFIType.u64 },
  GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
  FindFirstFileW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
  FindClose: { args: [FFIType.i64], returns: FFIType.i32 },
  GetVolumePathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  GetVolumeInformationW: {
    args: [
      FFIType.ptr, // lpRootPathName
      FFIType.ptr, // lpVolumeNameBuffer
      FFIType.u32, // nVolumeNameSize
      FFIType.ptr, // lpVolumeSerialNumber
      FFIType.ptr, // lpMaximumComponentLength
      FFIType.ptr, // lpFileSystemFlags
      FFIType.ptr, // lpFileSystemNameBuffer
      FFIType.u32, // nFileSystemNameSize
    ],
    returns: FFIType.i32,
  },
  GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
  GetCurrentProcess: { args: [], returns: FFIType.i64 },
  GetFileInformationByHandle: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
} as const;

const ADVAPI32 = {
  GetSecurityInfo: {
    args: [
      FFIType.i64, // handle
      FFIType.u32, // ObjectType
      FFIType.u32, // SecurityInfo
      FFIType.ptr, // ppsidOwner
      FFIType.ptr, // ppsidGroup
      FFIType.ptr, // ppDacl
      FFIType.ptr, // ppSacl
      FFIType.ptr, // ppSecurityDescriptor
    ],
    returns: FFIType.u32,
  },
  SetSecurityInfo: {
    args: [
      FFIType.i64, // handle
      FFIType.u32, // ObjectType
      FFIType.u32, // SecurityInfo
      FFIType.ptr, // psidOwner
      FFIType.ptr, // psidGroup
      FFIType.ptr, // pDacl
      FFIType.ptr, // pSacl
    ],
    returns: FFIType.u32,
  },
  GetSecurityDescriptorLength: { args: [FFIType.u64], returns: FFIType.u32 },
  OpenProcessToken: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GetTokenInformation: {
    args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  GetLengthSid: { args: [FFIType.u64], returns: FFIType.u32 },
} as const;

type Kernel32 = ReturnType<typeof dlopen<typeof KERNEL32>>["symbols"];
type Advapi32 = ReturnType<typeof dlopen<typeof ADVAPI32>>["symbols"];

/** Opened once, at the first call, for the process's life. */
let libraries: { readonly kernel: Kernel32; readonly advapi: Advapi32 } | undefined;

function win32(): { readonly kernel: Kernel32; readonly advapi: Advapi32 } {
  libraries ??= {
    kernel: dlopen("kernel32.dll", KERNEL32).symbols,
    advapi: dlopen("advapi32.dll", ADVAPI32).symbols,
  };
  return libraries;
}

/** `INVALID_HANDLE_VALUE`, as the i64 a handle is returned in. */
const INVALID_HANDLE = -1n;
const INVALID_FILE_ATTRIBUTES = 0xffff_ffff;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const READ_CONTROL = 0x0002_0000;
const WRITE_DAC = 0x0004_0000;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
/** sizeof(BY_HANDLE_FILE_INFORMATION); dwFileAttributes is its first field. */
const HANDLE_INFORMATION_BYTES = 52;
const FILE_SHARE_ALL = 0x7; // read, write, delete
const OPEN_EXISTING = 3;
/** Needed to open a folder; opens a reparse point as itself, not what it points to. */
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const TOKEN_QUERY = 0x8;
const TOKEN_USER_CLASS = 1;
/** sizeof(WIN32_FIND_DATAW) on x64, and where dwReserved0 lies in it. */
const FIND_DATA_BYTES = 592;
const FIND_DATA_RESERVED0 = 36;
/** Room for a volume's root path, in UTF-16 units. */
const PATH_UNITS = 1024;

/** A Win32 failure, by its error code. */
class Win32Failure extends Error {
  readonly code: string;

  constructor(call: string, code: number) {
    super(`${call} failed with Windows error ${code}`);
    this.code = `WIN32_${code}`;
  }
}

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

function fromWide(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("utf16le");
  const end = text.indexOf("\0");
  return end === -1 ? text : text.slice(0, end);
}

function wrap<T>(what: string, run: () => T): Result<T, HubError> {
  return Result.fromThrowable(run, (thrown) => errorFrom("control", ORIGIN, what, thrown))();
}

function processSid(): Uint8Array {
  const { kernel, advapi } = win32();
  const handle = new BigInt64Array(1);
  if (advapi.OpenProcessToken(kernel.GetCurrentProcess(), TOKEN_QUERY, handle) === 0)
    throw new Win32Failure("OpenProcessToken", kernel.GetLastError());
  const token = handle[0] ?? INVALID_HANDLE;
  try {
    const info = new BigUint64Array(64); // TOKEN_USER and its SID: 512 bytes, aligned
    const length = new Uint32Array(1);
    if (advapi.GetTokenInformation(token, TOKEN_USER_CLASS, info, info.byteLength, length) === 0)
      throw new Win32Failure("GetTokenInformation", kernel.GetLastError());
    const sid = info[0] ?? 0n; // TOKEN_USER.User.Sid, which points into `info`
    const sidBytes = advapi.GetLengthSid(sid);
    return new Uint8Array(toArrayBuffer(sid, 0, sidBytes)).slice();
  } finally {
    kernel.CloseHandle(token);
  }
}

function securityDescriptor(path: string): Uint8Array {
  const { kernel, advapi } = win32();
  const file = kernel.CreateFileW(
    wide(path),
    READ_CONTROL,
    FILE_SHARE_ALL,
    null,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    null,
  );
  if (file === INVALID_HANDLE) throw new Win32Failure("CreateFileW", kernel.GetLastError());
  try {
    const descriptor = new BigUint64Array(1);
    const failed = advapi.GetSecurityInfo(
      file,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      null,
      null,
      null,
      null,
      descriptor,
    );
    if (failed !== 0) throw new Win32Failure("GetSecurityInfo", failed);
    const at = descriptor[0] ?? 0n;
    try {
      const bytes = advapi.GetSecurityDescriptorLength(at);
      return new Uint8Array(toArrayBuffer(at, 0, bytes)).slice();
    } finally {
      kernel.LocalFree(at);
    }
  } finally {
    kernel.CloseHandle(file);
  }
}

function setProtectedList(path: string, acl: Uint8Array): void {
  const { kernel, advapi } = win32();
  const file = kernel.CreateFileW(
    wide(path),
    READ_CONTROL | WRITE_DAC,
    FILE_SHARE_ALL,
    null,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    null,
  );
  if (file === INVALID_HANDLE) throw new Win32Failure("CreateFileW", kernel.GetLastError());
  try {
    const information = new Uint8Array(HANDLE_INFORMATION_BYTES);
    if (kernel.GetFileInformationByHandle(file, information) === 0)
      throw new Win32Failure("GetFileInformationByHandle", kernel.GetLastError());
    const found = new DataView(information.buffer).getUint32(0, true);
    if ((found & FILE_ATTRIBUTE_REPARSE_POINT) !== 0)
      throw new Error(`${path} is a link: its list is not set`);
    const failed = advapi.SetSecurityInfo(
      file,
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      null,
      null,
      acl,
      null,
    );
    if (failed !== 0) throw new Win32Failure("SetSecurityInfo", failed);
  } finally {
    kernel.CloseHandle(file);
  }
}

function attributes(path: string): number | undefined {
  const { kernel } = win32();
  const found = kernel.GetFileAttributesW(wide(path));
  if (found !== INVALID_FILE_ATTRIBUTES) return found;
  const code = kernel.GetLastError();
  if (code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND) return undefined;
  throw new Win32Failure("GetFileAttributesW", code);
}

function findEntry(path: string): FoundEntry | undefined {
  const { kernel } = win32();
  const data = new Uint8Array(FIND_DATA_BYTES);
  const search = kernel.FindFirstFileW(wide(path), data);
  if (search === INVALID_HANDLE) {
    const code = kernel.GetLastError();
    if (code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND) return undefined;
    throw new Win32Failure("FindFirstFileW", code);
  }
  kernel.FindClose(search);
  const view = new DataView(data.buffer);
  return {
    attributes: view.getUint32(0, true),
    reparseTag: view.getUint32(FIND_DATA_RESERVED0, true),
  };
}

function volume(path: string): Volume {
  const { kernel } = win32();
  const root = new Uint8Array(PATH_UNITS * 2);
  if (kernel.GetVolumePathNameW(wide(path), root, PATH_UNITS) === 0)
    throw new Win32Failure("GetVolumePathNameW", kernel.GetLastError());
  const flags = new Uint32Array(1);
  if (kernel.GetVolumeInformationW(root, null, 0, null, null, flags, null, 0) === 0)
    throw new Win32Failure("GetVolumeInformationW", kernel.GetLastError());
  return { root: fromWide(root), flags: flags[0] ?? 0, driveType: kernel.GetDriveTypeW(root) };
}

/** The real calls. On any system but Windows each returns the error of loading its DLL. */
export const WINDOWS_CALLS: WindowsCalls = {
  processSid: () => wrap("read the hub's own account", processSid),
  securityDescriptor: (path) =>
    wrap(`read the access list of ${path}`, () => securityDescriptor(path)),
  attributes: (path) => wrap(`read the attributes of ${path}`, () => attributes(path)),
  findEntry: (path) => wrap(`look at ${path}`, () => findEntry(path)),
  volume: (path) => wrap(`read the volume of ${path}`, () => volume(path)),
  list: (path) => folderNames({ kind: "control", origin: ORIGIN }, path),
  setProtectedList: (path, acl) =>
    wrap(`set the access list of ${path}`, () => {
      setProtectedList(path, acl);
    }),
};

/**
 * `hsn.exe`'s own Win32 calls (m2-design.md section 9, "The privilege boundary": the row for an
 * elevated `hsn.exe`, and "Files a person names to `hsn`"), through `bun:ffi`, behind results;
 * the decisions are `shell/control/windows-named-files.ts`, tested on every system.
 *
 * - `processElevation`: whether this process runs with an elevated administrator's token.
 * - `openNamedFileForReading`: a file the person names (`hsn update install`, `hsn restore`),
 *   opened as the person, by a handle that does not follow a reparse point in its last part (one
 *   there is refused), then resolved by that handle (`GetFinalPathNameByHandleW`) and refused if
 *   it lies in a hub tree, each tree resolved by its own handle; read from that handle only.
 * - `beginExport`: `hsn backup export <file>`: the target's folder opened and resolved by its
 *   handle (a reparse point there refused), refused if in a hub tree; whether the service
 *   account may write in it or replace it (its list, and each folder above's) is told in the
 *   result, not refused (D124, section 9 "How far this goes"); then a new temporary file
 *   beside the target (`CREATE_NEW`), checked by its handle to be in that folder, written, flushed
 *   and renamed over the target (`MoveFileExW`, replacing, written through). An existing target
 *   that is a reparse point or a folder is refused.
 *
 * The libraries are opened at the first call, never at import, so the module loads everywhere.
 */
import { dlopen, FFIType } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { win32 as path32 } from "node:path";
import { err, ok, Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { ADMINISTRATORS_SID, parseDescriptor, sidToBytes } from "../control/windows-acl.ts";
import {
  decideElevation,
  type Elevation,
  finalPathKey,
  type NamedFileRefusal,
  outsideHubTrees,
  serviceMayWrite,
  type SidKind,
} from "../control/windows-named-files.ts";
import { WINDOWS_CALLS } from "./control-socket-windows.ts";
import { errorFrom } from "./thrown.ts";

/** The types `hub/cli` needs with these calls, so it imports this one file. */
export type { Elevation, NamedFileRefusal } from "../control/windows-named-files.ts";

const ORIGIN = "shell/safe/control-socket-hsn";

const KERNEL32 = {
  GetLastError: { args: [], returns: FFIType.u32 },
  GetCurrentProcess: { args: [], returns: FFIType.i64 },
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
  GetFileInformationByHandle: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  GetFinalPathNameByHandleW: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32],
    returns: FFIType.u32,
  },
  GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
  ReadFile: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  WriteFile: {
    args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  FlushFileBuffers: { args: [FFIType.i64], returns: FFIType.i32 },
  MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  DeleteFileW: { args: [FFIType.ptr], returns: FFIType.i32 },
} as const;

const ADVAPI32 = {
  OpenProcessToken: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GetTokenInformation: {
    args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  CheckTokenMembership: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  LookupAccountSidW: {
    args: [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
} as const;

type Kernel32 = ReturnType<typeof dlopen<typeof KERNEL32>>["symbols"];
type Advapi32 = ReturnType<typeof dlopen<typeof ADVAPI32>>["symbols"];
let libraries: { readonly kernel: Kernel32; readonly advapi: Advapi32 } | undefined;

function win32(): { readonly kernel: Kernel32; readonly advapi: Advapi32 } {
  libraries ??= {
    kernel: dlopen("kernel32.dll", KERNEL32).symbols,
    advapi: dlopen("advapi32.dll", ADVAPI32).symbols,
  };
  return libraries;
}

const INVALID_HANDLE = -1n;
const INVALID_FILE_ATTRIBUTES = 0xffff_ffff;
const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const CREATE_NEW = 1;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const MOVEFILE_REPLACE_EXISTING = 0x1;
const MOVEFILE_WRITE_THROUGH = 0x8;
const TOKEN_QUERY = 0x8;
const TOKEN_ELEVATION_CLASS = 20;
const SID_TYPE_USER = 1;
/** sizeof(BY_HANDLE_FILE_INFORMATION); attributes at 0, size high at 32 and low at 36. */
const HANDLE_INFORMATION_BYTES = 52;
const PATH_UNITS = 32_768;

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

function wrap<T>(what: string, run: () => T): Result<T, HubError> {
  return Result.fromThrowable(run, (thrown) => errorFrom("control", ORIGIN, what, thrown))();
}

const failed = (error: HubError): NamedFileRefusal => ({ kind: "failed", message: error.message });

function open(path: string, access: number, share: number, flags: number): bigint {
  const { kernel } = win32();
  const handle = kernel.CreateFileW(wide(path), access, share, null, OPEN_EXISTING, flags, null);
  if (handle === INVALID_HANDLE)
    throw new Win32Failure(`CreateFileW ${path}`, kernel.GetLastError());
  return handle;
}

function information(handle: bigint): { readonly attributes: number; readonly size: number } {
  const { kernel } = win32();
  const info = new Uint8Array(HANDLE_INFORMATION_BYTES);
  if (kernel.GetFileInformationByHandle(handle, info) === 0)
    throw new Win32Failure("GetFileInformationByHandle", kernel.GetLastError());
  const view = new DataView(info.buffer);
  return {
    attributes: view.getUint32(0, true),
    size: view.getUint32(32, true) * 2 ** 32 + view.getUint32(36, true),
  };
}

function finalPath(handle: bigint): string {
  const { kernel } = win32();
  const buffer = new Uint8Array(PATH_UNITS * 2);
  const units = kernel.GetFinalPathNameByHandleW(handle, buffer, PATH_UNITS, 0);
  if (units === 0 || units >= PATH_UNITS)
    throw new Win32Failure("GetFinalPathNameByHandleW", kernel.GetLastError());
  return Buffer.from(buffer.subarray(0, units * 2)).toString("utf16le");
}

/** Each hub tree as Windows resolves it, following links; a tree that does not exist is none. */
function resolvedTrees(trees: readonly string[]): Result<readonly string[], NamedFileRefusal> {
  const out: string[] = [];
  for (const tree of trees) {
    const attributes = wrap(`look at ${tree}`, () => win32().kernel.GetFileAttributesW(wide(tree)));
    if (attributes.isErr()) return err(failed(attributes.error));
    if (attributes.value === INVALID_FILE_ATTRIBUTES) continue;
    const resolved = wrap(`resolve ${tree}`, () => {
      const handle = open(tree, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, FILE_FLAG_BACKUP_SEMANTICS);
      try {
        return finalPath(handle);
      } finally {
        win32().kernel.CloseHandle(handle);
      }
    });
    if (resolved.isErr()) return err(failed(resolved.error));
    out.push(resolved.value);
  }
  return ok(out);
}

/** The two facts `processElevation` decides from, as the token holds them. */
export interface ElevationFacts {
  readonly administratorsEnabled: Result<boolean, HubError>;
  readonly tokenElevated: Result<boolean, HubError>;
}

/** Whether this process runs with an elevated administrator's token. */
export function processElevation(): Elevation {
  const facts = processElevationFacts();
  return decideElevation(facts.administratorsEnabled, facts.tokenElevated);
}

/** Administrators enabled (`CheckTokenMembership`) and `TokenIsElevated`, each read or why not. */
export function processElevationFacts(): ElevationFacts {
  const administrators = sidToBytes(ADMINISTRATORS_SID)._unsafeUnwrap();
  const enabled = wrap("tell whether Administrators is enabled", () => {
    const { kernel, advapi } = win32();
    const member = new Int32Array(1);
    if (advapi.CheckTokenMembership(0n, administrators, member) === 0)
      throw new Win32Failure("CheckTokenMembership", kernel.GetLastError());
    return (member[0] ?? 0) !== 0;
  });
  const elevated = wrap("read the token's elevation", () => {
    const { kernel, advapi } = win32();
    const handle = new BigInt64Array(1);
    if (advapi.OpenProcessToken(kernel.GetCurrentProcess(), TOKEN_QUERY, handle) === 0)
      throw new Win32Failure("OpenProcessToken", kernel.GetLastError());
    const token = handle[0] ?? INVALID_HANDLE;
    try {
      const value = new Uint32Array(1);
      const length = new Uint32Array(1);
      if (advapi.GetTokenInformation(token, TOKEN_ELEVATION_CLASS, value, 4, length) === 0)
        throw new Win32Failure("GetTokenInformation(TokenElevation)", kernel.GetLastError());
      return (value[0] ?? 0) !== 0;
    } finally {
      kernel.CloseHandle(token);
    }
  });
  return { administratorsEnabled: enabled, tokenElevated: elevated };
}

/** What Windows says an account is; "other" when it will not say. */
export function sidKind(sid: string): SidKind {
  const bytes = sidToBytes(sid);
  if (bytes.isErr()) return "other";
  const looked = wrap(`look up ${sid}`, () => {
    const { advapi } = win32();
    const name = new Uint8Array(512);
    const nameUnits = new Uint32Array([256]);
    const domain = new Uint8Array(512);
    const domainUnits = new Uint32Array([256]);
    const use = new Uint32Array(1);
    if (
      advapi.LookupAccountSidW(null, bytes.value, name, nameUnits, domain, domainUnits, use) === 0
    )
      return "other";
    return use[0] === SID_TYPE_USER ? "user" : "other";
  });
  return looked.isOk() ? looked.value : "other";
}

/** A file opened for reading by `hsn.exe`, read from its handle only. */
export interface NamedFileReader {
  /** The file as Windows resolved it. */
  readonly finalPath: string;
  readonly size: number;
  /** Reads into `into`; 0 at the end. */
  readonly read: (into: Uint8Array) => Result<number, HubError>;
  readonly close: () => void;
}

/** Opens a file a person names, as the person: see the top of this file. */
export function openNamedFileForReading(
  path: string,
  hubTrees: readonly string[],
): Result<NamedFileReader, NamedFileRefusal> {
  const trees = resolvedTrees(hubTrees);
  if (trees.isErr()) return err(trees.error);
  const opened = wrap(`open ${path}`, () =>
    open(path, GENERIC_READ, FILE_SHARE_READ, FILE_FLAG_OPEN_REPARSE_POINT),
  );
  if (opened.isErr()) return err(failed(opened.error));
  const handle = opened.value;
  const close = (): void => {
    win32().kernel.CloseHandle(handle);
  };
  const looked = wrap(`look at ${path}`, () => ({
    info: information(handle),
    at: finalPath(handle),
  }));
  if (looked.isErr()) {
    close();
    return err(failed(looked.error));
  }
  const { info, at } = looked.value;
  const refusal: NamedFileRefusal | undefined =
    (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
      ? {
          kind: "reparsePoint",
          message: `${path} is a link (a reparse point): hsn does not follow it`,
        }
      : (info.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0
        ? { kind: "notAFile", message: `${path} is a folder, not a file` }
        : outsideHubTrees(at, trees.value).match(
            () => undefined,
            (inside) => inside,
          );
  if (refusal !== undefined) {
    close();
    return err(refusal);
  }
  return ok({
    finalPath: at,
    size: info.size,
    read: (into) =>
      wrap(`read ${path}`, () => {
        const { kernel } = win32();
        const got = new Uint32Array(1);
        if (kernel.ReadFile(handle, into, into.length, got, null) === 0)
          throw new Win32Failure("ReadFile", kernel.GetLastError());
        return got[0] ?? 0;
      }),
    close,
  });
}

/** An export being written: write, then finish (rename over the target) or abandon. */
export interface ExportFile {
  /** The target's folder as Windows resolved it. */
  readonly folder: string;
  /** Why the hub's service account could also write in that folder; none when it cannot. */
  readonly serviceMayWrite: readonly string[];
  /** One line for the person when it could (D124: told, not refused); undefined when not. */
  readonly warning: string | undefined;
  readonly write: (bytes: Uint8Array) => Result<void, HubError>;
  /** Flushes, closes and renames the temporary file over the target. */
  readonly finish: () => Result<void, HubError>;
  /** Closes and removes the temporary file. */
  readonly abandon: () => void;
}

/** Why the service account may write in, or replace, the folder at `final`; none when not. */
function serviceWritesAt(final: string): readonly string[] {
  const reasons: string[] = [];
  const plain = finalPathKey(final);
  const { root } = path32.parse(plain);
  let first = true;
  for (let at = plain; at.length >= root.length; at = path32.dirname(at)) {
    const bytes = WINDOWS_CALLS.securityDescriptor(at);
    const descriptor = bytes.isOk() ? parseDescriptor(bytes.value).unwrapOr(undefined) : undefined;
    for (const reason of serviceMayWrite(descriptor, sidKind, first ? "folder" : "ancestor"))
      reasons.push(`${at}: ${reason}`);
    first = false;
    if (path32.dirname(at) === at) break;
  }
  return reasons;
}

/** Starts writing an export to `target`: see the top of this file. */
export function beginExport(
  target: string,
  hubTrees: readonly string[],
): Result<ExportFile, NamedFileRefusal> {
  const trees = resolvedTrees(hubTrees);
  if (trees.isErr()) return err(trees.error);
  const full = path32.resolve(target);
  const folderPath = path32.dirname(full);
  const existing = wrap(`look at ${full}`, () => win32().kernel.GetFileAttributesW(wide(full)));
  if (existing.isErr()) return err(failed(existing.error));
  if (existing.value !== INVALID_FILE_ATTRIBUTES) {
    if ((existing.value & FILE_ATTRIBUTE_REPARSE_POINT) !== 0)
      return err({
        kind: "reparsePoint",
        message: `${full} is a link (a reparse point): hsn does not write through it`,
      });
    if ((existing.value & FILE_ATTRIBUTE_DIRECTORY) !== 0)
      return err({ kind: "notAFile", message: `${full} is a folder` });
  }
  const folder = wrap(`open ${folderPath}`, () => {
    const handle = open(
      folderPath,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_ALL,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    );
    try {
      return { info: information(handle), at: finalPath(handle) };
    } finally {
      win32().kernel.CloseHandle(handle);
    }
  });
  if (folder.isErr()) return err(failed(folder.error));
  if ((folder.value.info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0)
    return err({
      kind: "reparsePoint",
      message: `${folderPath} is a link (a reparse point): hsn does not write through it`,
    });
  const inside = outsideHubTrees(folder.value.at, trees.value);
  if (inside.isErr()) return err(inside.error);
  // Not refused (D124: the hub's computer is its owner's to secure): told, for one line.
  const reasons = serviceWritesAt(folder.value.at);
  const warning =
    reasons.length === 0
      ? undefined
      : `the hub's service account could also write in ${finalPathKey(folder.value.at)}, where this export goes`;
  const temporary = `${full}.hsn-${randomBytes(6).toString("hex")}.part`;
  const created = wrap(`create ${temporary}`, () => {
    const { kernel } = win32();
    const handle = kernel.CreateFileW(
      wide(temporary),
      GENERIC_WRITE,
      0,
      null,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      null,
    );
    if (handle === INVALID_HANDLE)
      throw new Win32Failure("CreateFileW (CREATE_NEW)", kernel.GetLastError());
    return handle;
  });
  if (created.isErr()) return err(failed(created.error));
  const handle = created.value;
  let open_ = true;
  const closeHandle = (): void => {
    if (open_) win32().kernel.CloseHandle(handle);
    open_ = false;
  };
  const abandon = (): void => {
    closeHandle();
    win32().kernel.DeleteFileW(wide(temporary));
  };
  const where = wrap(`resolve ${temporary}`, () => finalPath(handle));
  if (
    where.isErr() ||
    finalPathKey(path32.dirname(finalPathKey(where.value))) !== finalPathKey(folder.value.at)
  ) {
    abandon();
    return err({
      kind: "failed",
      message: `the temporary file did not land in ${finalPathKey(folder.value.at)}`,
    });
  }
  return ok({
    folder: folder.value.at,
    serviceMayWrite: reasons,
    warning,
    write: (bytes) =>
      wrap(`write ${temporary}`, () => {
        const { kernel } = win32();
        const wrote = new Uint32Array(1);
        if (
          kernel.WriteFile(handle, bytes, bytes.length, wrote, null) === 0 ||
          wrote[0] !== bytes.length
        )
          throw new Win32Failure("WriteFile", kernel.GetLastError());
      }),
    finish: () =>
      wrap(`finish ${full}`, () => {
        const { kernel } = win32();
        if (kernel.FlushFileBuffers(handle) === 0)
          throw new Win32Failure("FlushFileBuffers", kernel.GetLastError());
        closeHandle();
        if (
          kernel.MoveFileExW(
            wide(temporary),
            wide(full),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
          ) === 0
        ) {
          const code = kernel.GetLastError();
          kernel.DeleteFileW(wide(temporary));
          throw new Win32Failure("MoveFileExW", code);
        }
      }),
    abandon,
  });
}

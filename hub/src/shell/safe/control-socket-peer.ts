/**
 * `hsn.exe`'s check of who serves the command socket on Windows (m2-design.md section 9, "The
 * Windows peer check, and what protects the socket"): connect to the socket, ask Windows for the
 * process at the other end (`SIO_AF_UNIX_GETPEERPID`), open that process at once and read its
 * token's user, and compare it with the hub's service account, `NT SERVICE\HSNHub`. The Win32 part
 * is here (`try` lives in `shell/safe/`, HD 10); `hub/cli` (A2) calls `checkHubPeer` after it has
 * connected and before it sends anything, and refuses when it errs.
 *
 * Its limits, as the design states them: it does not close the window between the two calls, in
 * which the peer could exit and its id be reused (the connection `hsn` holds is then to a
 * process that has ended and carries nothing); and it says nothing of the code the hub's account
 * runs: a taken-over hub passes it. It is a second check, behind the data folder's list.
 *
 * It makes its own connection, through Winsock by `bun:ffi`, since `node:net` does not hand out
 * its socket's handle: the hub sees one more connection that closes without a line, which it
 * takes as nothing (`server.ts`). The libraries are opened at the first call, never at import.
 */
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { err, ok, Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { parseSid } from "../control/windows-acl.ts";

// Step 0 owner: the service's SID, for `hub/cli/hsn.ts`, which may import this one file of the
// shell's (the CLI's lint allowance) and so takes it from here.
export { HUB_SERVICE_SID } from "../control/windows-acl.ts";
import { errorFrom } from "./thrown.ts";

const ORIGIN = "shell/safe/control-socket-peer";

const WS2_32 = {
  WSAStartup: { args: [FFIType.u16, FFIType.ptr], returns: FFIType.i32 },
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.u64 },
  connect: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  WSAIoctl: {
    args: [
      FFIType.u64, // s
      FFIType.u32, // dwIoControlCode
      FFIType.ptr, // lpvInBuffer
      FFIType.u32, // cbInBuffer
      FFIType.ptr, // lpvOutBuffer
      FFIType.u32, // cbOutBuffer
      FFIType.ptr, // lpcbBytesReturned
      FFIType.ptr, // lpOverlapped
      FFIType.ptr, // lpCompletionRoutine
    ],
    returns: FFIType.i32,
  },
  closesocket: { args: [FFIType.u64], returns: FFIType.i32 },
  WSAGetLastError: { args: [], returns: FFIType.i32 },
} as const;

const KERNEL32 = {
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.i64 },
  CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
} as const;

const ADVAPI32 = {
  OpenProcessToken: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GetTokenInformation: {
    args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  GetLengthSid: { args: [FFIType.u64], returns: FFIType.u32 },
} as const;

type Ws2 = ReturnType<typeof dlopen<typeof WS2_32>>["symbols"];
type Kernel32 = ReturnType<typeof dlopen<typeof KERNEL32>>["symbols"];
type Advapi32 = ReturnType<typeof dlopen<typeof ADVAPI32>>["symbols"];

let libraries:
  { readonly ws2: Ws2; readonly kernel: Kernel32; readonly advapi: Advapi32 } | undefined;

function win32(): { readonly ws2: Ws2; readonly kernel: Kernel32; readonly advapi: Advapi32 } {
  if (libraries === undefined) {
    const ws2 = dlopen("ws2_32.dll", WS2_32).symbols;
    const data = new Uint8Array(512); // WSADATA, with room to spare
    const started = ws2.WSAStartup(0x0202, data);
    if (started !== 0) throw new PeerFailure("WSAStartup", started);
    libraries = {
      ws2,
      kernel: dlopen("kernel32.dll", KERNEL32).symbols,
      advapi: dlopen("advapi32.dll", ADVAPI32).symbols,
    };
  }
  return libraries;
}

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const INVALID_SOCKET = 0xffff_ffff_ffff_ffffn;
/** `_WSAIOR(IOC_VENDOR, 256)` (afunix.h). */
export const SIO_AF_UNIX_GETPEERPID = 0x5800_0100;
/** `sizeof(SOCKADDR_UN)`: a 2-byte family and a 108-byte path. */
const SOCKADDR_UN_BYTES = 110;
const UNIX_PATH_MAX = 108;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x8;
const TOKEN_USER_CLASS = 1;

class PeerFailure extends Error {
  readonly code: string;

  constructor(call: string, code: number) {
    super(`${call} failed with Windows error ${code}`);
    this.code = `WIN32_${code}`;
  }
}

/** The process at the other end of the socket, and the account it runs as. */
export interface SocketPeer {
  readonly pid: number;
  readonly sid: string;
}

function peerPid(path: string): number {
  const { ws2 } = win32();
  const encoded = Buffer.from(path, "utf8");
  if (encoded.length >= UNIX_PATH_MAX) throw new Error(`the socket path is too long: ${path}`);
  const address = new Uint8Array(SOCKADDR_UN_BYTES);
  new DataView(address.buffer).setUint16(0, AF_UNIX, true);
  address.set(encoded, 2);
  const socket = ws2.socket(AF_UNIX, SOCK_STREAM, 0);
  if (socket === INVALID_SOCKET) throw new PeerFailure("socket", ws2.WSAGetLastError());
  try {
    if (ws2.connect(socket, address, SOCKADDR_UN_BYTES) !== 0)
      throw new PeerFailure("connect", ws2.WSAGetLastError());
    const pid = new Uint32Array(1);
    const returned = new Uint32Array(1);
    if (ws2.WSAIoctl(socket, SIO_AF_UNIX_GETPEERPID, null, 0, pid, 4, returned, null, null) !== 0)
      throw new PeerFailure("WSAIoctl(SIO_AF_UNIX_GETPEERPID)", ws2.WSAGetLastError());
    return pid[0] ?? 0;
  } finally {
    ws2.closesocket(socket);
  }
}

function accountOf(pid: number): Uint8Array {
  const { kernel, advapi } = win32();
  const process = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (process === 0n) throw new PeerFailure("OpenProcess", kernel.GetLastError());
  try {
    const handle = new BigInt64Array(1);
    if (advapi.OpenProcessToken(process, TOKEN_QUERY, handle) === 0)
      throw new PeerFailure("OpenProcessToken", kernel.GetLastError());
    const token = handle[0] ?? 0n;
    try {
      const info = new BigUint64Array(64);
      const length = new Uint32Array(1);
      if (advapi.GetTokenInformation(token, TOKEN_USER_CLASS, info, info.byteLength, length) === 0)
        throw new PeerFailure("GetTokenInformation", kernel.GetLastError());
      const sid = info[0] ?? 0n;
      return new Uint8Array(toArrayBuffer(sid, 0, advapi.GetLengthSid(sid))).slice();
    } finally {
      kernel.CloseHandle(token);
    }
  } finally {
    kernel.CloseHandle(process);
  }
}

/** Who serves the socket at `path`: its process id and account. */
export function socketPeer(path: string): Result<SocketPeer, HubError> {
  return Result.fromThrowable(
    () => {
      const pid = peerPid(path);
      const sid = parseSid(accountOf(pid), 0);
      if (sid.isErr()) throw new Error(`the peer's account is not a SID: ${sid.error}`);
      return { pid, sid: sid.value.sid };
    },
    (thrown) =>
      errorFrom("control", ORIGIN, `ask who serves the command socket at ${path}`, thrown),
  )();
}

/** Why `hsn.exe` will not talk to what serves the socket. */
export type PeerRefusal =
  /** Another account serves it. */
  | { readonly kind: "notTheHub"; readonly peer: SocketPeer; readonly expected: string }
  /** Windows would not say who serves it. */
  | { readonly kind: "cannotTell"; readonly error: HubError };

/**
 * `hsn.exe`'s check: the socket at `path` is served by a process running as `expected`, the
 * hub's service account (`HUB_SERVICE_SID`; a test names the account its hub runs as).
 */
export function checkHubPeer(path: string, expected: string): Result<SocketPeer, PeerRefusal> {
  return socketPeer(path)
    .mapErr((error): PeerRefusal => ({ kind: "cannotTell", error }))
    .andThen((peer) =>
      peer.sid === expected
        ? ok<SocketPeer, PeerRefusal>(peer)
        : err<SocketPeer, PeerRefusal>({ kind: "notTheHub", peer, expected }),
    );
}

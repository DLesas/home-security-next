/** The bench's cable to a real hub: a Unix PTY or the Windows test entry's loopback stream. */
import { close, constants, openSync, renameSync, symlinkSync, write, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { ReadStream } from "node:tty";
import { CString, dlopen, FFIType } from "bun:ffi";
import { makeByteClean } from "../../../hub/src/shell/safe/serial.ts";

export interface BenchPort {
  readonly plug: () => void;
  readonly send: (bytes: Uint8Array) => void;
  readonly receive: (data: (chunk: Buffer) => void) => void;
  readonly close: () => void;
}

const SOCKET_BOARDS = process.env.HSN_E2E_SOCKET_BOARDS === "1";
const LIBRARY = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const O_RDWR = 2;
const O_NOCTTY = process.platform === "darwin" ? 0x20000 : 0o400;
const libc = SOCKET_BOARDS
  ? undefined
  : dlopen(LIBRARY, {
      posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
      grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
      unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
      ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
    }).symbols;

/** Publishes a link to the terminal when this board is plugged into a Unix host. */
function terminalPort(port: string): BenchPort | undefined {
  if (libc === undefined) return undefined;
  const master = libc.posix_openpt(O_RDWR | O_NOCTTY);
  if (master < 0 || libc.grantpt(master) !== 0 || libc.unlockpt(master) !== 0) return undefined;
  const name = libc.ptsname(master);
  if (name === null) return undefined;
  // CString is a boxed string even though its type extends string.
  const path = new CString(name).slice();
  // Our copy keeps the terminal up until the hub opens it.
  const slave = openSync(path, constants.O_RDWR | constants.O_NOCTTY);
  if (makeByteClean(slave).isErr()) return undefined;
  return {
    plug: () => {
      symlinkSync(path, port);
    },
    send: (bytes) => {
      write(master, bytes, () => undefined);
    },
    receive: (data) => {
      const stream = new ReadStream(master);
      stream.on("data", data);
      stream.on("error", () => undefined);
    },
    close: () => {
      close(slave, () => undefined);
      close(master, () => undefined);
    },
  };
}

/** Publishes the already-listening byte stream with an atomic marker for the hub's watcher. */
async function socketPort(port: string): Promise<BenchPort> {
  let peer: Socket | undefined;
  let receive: ((chunk: Buffer) => void) | undefined;
  const server = createServer((socket) => {
    peer = socket;
    socket.setNoDelay();
    socket.on("data", (chunk: Buffer) => {
      receive?.(chunk);
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      if (peer === socket) peer = undefined;
    });
  });
  const number = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("no bench address"));
      else resolve(address.port);
    });
  });
  return {
    plug: () => {
      writeFileSync(`${port}.tmp`, String(number));
      renameSync(`${port}.tmp`, port);
    },
    send: (bytes) => {
      peer?.write(bytes);
    },
    receive: (data) => {
      receive = data;
    },
    close: () => {
      peer?.destroy();
      server.close();
    },
  };
}

/** Selects the physical byte-stream substitute for this browser test. */
export async function benchPort(port: string): Promise<BenchPort | undefined> {
  return SOCKET_BOARDS ? socketPort(port) : terminalPort(port);
}

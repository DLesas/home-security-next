/**
 * Serial ports behind results (hub-design.md sections 3 and 10): listing them with `serialport`,
 * and opening, writing and closing one as a terminal through `node:tty`. `serialport`'s native
 * binding stops Bun 1.4.2 when it opens a port ("unsupported uv function: uv_default_loop", open
 * item O18), while listing works; a USB CDC port and a pseudo-terminal are both terminals, so the
 * hub opens them as such, and the line speed means nothing to either (§10).
 *
 * A link must be byte-clean: every byte the board sends arrives, and every byte the hub writes
 * leaves, as it is. `setRawMode(true)` is not enough: it leaves output processing on, so each
 * 0x0A written leaves as 0x0D 0x0A. So after it the terminal is set again through the C library
 * (`tcgetattr`, `cfmakeraw`, `tcsetattr`, by `bun:ffi`), then read back and checked:
 * - input: no break, parity, stripping or CR/NL translation, no start/stop flow control
 *   (IGNBRK BRKINT PARMRK ISTRIP INLCR IGNCR ICRNL IXON IXOFF IXANY INPCK all off);
 * - output: no processing (OPOST off);
 * - local: no echo, no canonical lines, no signals, no extended characters
 *   (ECHO ECHONL ICANON ISIG IEXTEN off);
 * - control: eight bits, no parity, the receiver on, modem lines ignored, no hardware flow
 *   control (CS8 CREAD CLOCAL on; PARENB and CRTSCTS off);
 * - a read returns as soon as one byte is there (VMIN 1, VTIME 0).
 * The layout of `struct termios` and the flag values are those of macOS and Linux; Windows has no
 * terminals (open item O18).
 */
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, openSync, write } from "node:fs";
import { ReadStream } from "node:tty";
import { err, Result, ResultAsync } from "neverthrow";
import { SerialPort } from "serialport";
import type { HubError } from "../../core/model/errors.ts";
import type { LinkError } from "../../ports/links.ts";
import { linkError } from "./link-error.ts";
import { errorFrom } from "./thrown.ts";

const ORIGIN = "shell/safe/serial";

/** A serial port the system lists, with its USB vendor number when it has one. */
export interface ListedPort {
  readonly path: string;
  /** Lowercase hex, as `serialport` reports it ("303a" for Espressif). */
  readonly vendorId: string | undefined;
}

/**
 * The name to open a listed port by. On macOS each port has two names, and opening `/dev/tty.X`
 * waits for the modem's carrier on the hub's only thread, while `/dev/cu.X` (call-out) opens at
 * once; `serialport` lists the `tty.` names, so they are opened as `cu.` ones. Elsewhere, as listed.
 */
export function callOutPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" && path.startsWith("/dev/tty.")
    ? `/dev/cu.${path.slice("/dev/tty.".length)}`
    : path;
}

/** The system's serial ports, listed once (never on a timer, section 3), by the names to open. */
export function listSerialPorts(): ResultAsync<readonly ListedPort[], HubError> {
  // `serialport`'s port type comes from a package the type checker cannot resolve here, so the
  // listing is read as unknown and checked field by field.
  const list: () => Promise<unknown> = SerialPort.list.bind(SerialPort);
  return ResultAsync.fromPromise(list(), (thrown) =>
    errorFrom("link", ORIGIN, "list serial ports", thrown),
  ).map((listing) => listedPorts(listing));
}

export function listedPorts(
  listing: unknown,
  platform: NodeJS.Platform = process.platform,
): readonly ListedPort[] {
  if (!Array.isArray(listing)) return [];
  return listing.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("path" in entry)) return [];
    const { path } = entry;
    const vendor = "vendorId" in entry ? entry.vendorId : undefined;
    if (typeof path !== "string") return [];
    return [
      {
        path: callOutPath(path, platform),
        vendorId: typeof vendor === "string" ? vendor.toLowerCase() : undefined,
      },
    ];
  });
}

/**
 * An open serial port, read through `node:tty` in raw mode (see above: not `serialport`, O18).
 */
export interface TtyPort {
  readonly path: string;
  readonly fd: number;
  readonly stream: ReadStream;
}

/** Where each field of `struct termios` is, and the flag values, on one system. */
export interface TermiosLayout {
  readonly library: string;
  readonly size: number;
  /** `tcflag_t`: 8 bytes on macOS, 4 on Linux. */
  readonly flagBytes: 4 | 8;
  readonly iflag: number;
  readonly oflag: number;
  readonly cflag: number;
  readonly lflag: number;
  readonly cc: number;
  readonly vmin: number;
  readonly vtime: number;
  readonly flags: Readonly<Record<TermiosFlag, number>>;
}

type TermiosFlag =
  | "IGNBRK"
  | "BRKINT"
  | "PARMRK"
  | "ISTRIP"
  | "INLCR"
  | "IGNCR"
  | "ICRNL"
  | "IXON"
  | "IXOFF"
  | "IXANY"
  | "INPCK"
  | "OPOST"
  | "ECHO"
  | "ECHONL"
  | "ICANON"
  | "ISIG"
  | "IEXTEN"
  | "CSIZE"
  | "CS8"
  | "CREAD"
  | "CLOCAL"
  | "PARENB"
  | "CRTSCTS";

const MACOS: TermiosLayout = {
  library: "/usr/lib/libSystem.B.dylib",
  size: 72,
  flagBytes: 8,
  iflag: 0,
  oflag: 8,
  cflag: 16,
  lflag: 24,
  cc: 32,
  vmin: 16,
  vtime: 17,
  flags: {
    IGNBRK: 0x1,
    BRKINT: 0x2,
    PARMRK: 0x8,
    INPCK: 0x10,
    ISTRIP: 0x20,
    INLCR: 0x40,
    IGNCR: 0x80,
    ICRNL: 0x100,
    IXON: 0x200,
    IXOFF: 0x400,
    IXANY: 0x800,
    OPOST: 0x1,
    ECHONL: 0x10,
    ECHO: 0x8,
    ISIG: 0x80,
    ICANON: 0x100,
    IEXTEN: 0x400,
    CSIZE: 0x300,
    CS8: 0x300,
    CREAD: 0x800,
    PARENB: 0x1000,
    CLOCAL: 0x8000,
    // CCTS_OFLOW | CRTS_IFLOW
    CRTSCTS: 0x30000,
  },
};

const LINUX: TermiosLayout = {
  library: "libc.so.6",
  size: 60,
  flagBytes: 4,
  iflag: 0,
  oflag: 4,
  cflag: 8,
  lflag: 12,
  // After `c_line`, one byte.
  cc: 17,
  vmin: 6,
  vtime: 5,
  flags: {
    IGNBRK: 0o1,
    BRKINT: 0o2,
    PARMRK: 0o10,
    INPCK: 0o20,
    ISTRIP: 0o40,
    INLCR: 0o100,
    IGNCR: 0o200,
    ICRNL: 0o400,
    IXON: 0o2000,
    IXANY: 0o4000,
    IXOFF: 0o10000,
    OPOST: 0o1,
    ISIG: 0o1,
    ICANON: 0o2,
    ECHO: 0o10,
    ECHONL: 0o100,
    IEXTEN: 0o100000,
    CSIZE: 0o60,
    CS8: 0o60,
    CREAD: 0o200,
    PARENB: 0o400,
    CLOCAL: 0o4000,
    CRTSCTS: 0o20000000000,
  },
};

/** What a terminal is set to, as `tcgetattr` reads it back. */
export interface TerminalSettings {
  readonly iflag: number;
  readonly oflag: number;
  readonly cflag: number;
  readonly lflag: number;
  readonly vmin: number;
  readonly vtime: number;
}

const INPUT_OFF: readonly TermiosFlag[] = [
  "IGNBRK",
  "BRKINT",
  "PARMRK",
  "ISTRIP",
  "INLCR",
  "IGNCR",
  "ICRNL",
  "IXON",
  "IXOFF",
  "IXANY",
  "INPCK",
];
const LOCAL_OFF: readonly TermiosFlag[] = ["ECHO", "ECHONL", "ICANON", "ISIG", "IEXTEN"];

export function layoutFor(platform: NodeJS.Platform): TermiosLayout | undefined {
  if (platform === "darwin") return MACOS;
  if (platform === "linux") return LINUX;
  return undefined;
}

function readFlag(view: DataView, offset: number, layout: TermiosLayout): number {
  return layout.flagBytes === 8
    ? Number(view.getBigUint64(offset, true))
    : view.getUint32(offset, true);
}

/**
 * Clears the bits of `clear` and sets those of `set` in one flag field, in place. On macOS the
 * field is 64 bits wide and is changed as a 64-bit integer, so its upper half stays as it was;
 * both masks are non-negative constants, so no sign can spread into it.
 */
export function changeFlag(
  view: DataView,
  offset: number,
  layout: TermiosLayout,
  clear: number,
  set: number,
): void {
  if (layout.flagBytes === 8) {
    const value = view.getBigUint64(offset, true);
    view.setBigUint64(offset, (value & ~BigInt(clear)) | BigInt(set), true);
  } else {
    view.setUint32(offset, ((view.getUint32(offset, true) & ~clear) | set) >>> 0, true);
  }
}

function settingsOf(buffer: Uint8Array, layout: TermiosLayout): TerminalSettings {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return {
    iflag: readFlag(view, layout.iflag, layout),
    oflag: readFlag(view, layout.oflag, layout),
    cflag: readFlag(view, layout.cflag, layout),
    lflag: readFlag(view, layout.lflag, layout),
    vmin: buffer[layout.cc + layout.vmin] ?? -1,
    vtime: buffer[layout.cc + layout.vtime] ?? -1,
  };
}

/** Whether `settings` are byte-clean, as the comment at the top says; the first problem if not. */
export function byteCleanProblem(
  settings: TerminalSettings,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const layout = layoutFor(platform);
  if (layout === undefined) return `no terminal settings on ${platform}`;
  const { flags } = layout;
  const on = (field: number, flag: TermiosFlag) => (field & flags[flag]) !== 0;
  for (const flag of INPUT_OFF) if (on(settings.iflag, flag)) return `${flag} is on`;
  if (on(settings.oflag, "OPOST")) return "OPOST is on";
  for (const flag of LOCAL_OFF) if (on(settings.lflag, flag)) return `${flag} is on`;
  if ((settings.cflag & flags.CSIZE) !== flags.CS8) return "the character size is not 8 bits";
  if (!on(settings.cflag, "CREAD")) return "CREAD is off";
  if (!on(settings.cflag, "CLOCAL")) return "CLOCAL is off";
  if (on(settings.cflag, "PARENB")) return "PARENB is on";
  if ((settings.cflag & flags.CRTSCTS) !== 0) return "CRTSCTS is on";
  if (settings.vmin !== 1 || settings.vtime !== 0)
    return `VMIN ${settings.vmin}, VTIME ${settings.vtime}`;
  return undefined;
}

/** `tcsetattr` at once. */
const TCSANOW = 0;
/** `tcsetattr` once written output is sent, discarding input not yet read: 2 on both systems. */
const TCSAFLUSH = 2;

const LIBC_SYMBOLS = {
  tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  cfmakeraw: { args: [FFIType.ptr], returns: FFIType.void },
  // Variadic in C; called on Linux only, where its third argument goes in a register as here
  // (on Apple's arm64 a variadic argument goes on the stack, so macOS never calls it).
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const;

/** Linux's `fcntl` commands and `O_NONBLOCK` (the same on x86-64 and arm64). */
const F_GETFL = 3;
const F_SETFL = 4;
const LINUX_O_NONBLOCK = 0o4000;

type Libc = ReturnType<typeof dlopen<typeof LIBC_SYMBOLS>>["symbols"];

/** The C library, opened once for the process's life: never closed, so never opened again. */
const libraries = new Map<string, Libc>();

function libcFor(layout: TermiosLayout): Libc {
  const open = libraries.get(layout.library);
  if (open !== undefined) return open;
  const libc = dlopen(layout.library, LIBC_SYMBOLS).symbols;
  libraries.set(layout.library, libc);
  return libc;
}

function noLayout(platform: NodeJS.Platform): LinkError {
  return linkError("writeFailed", ORIGIN, `no terminal settings on ${platform}`, undefined);
}

/** Reads the terminal's `struct termios`, with room to spare. */
function getTermios(libc: Libc, fd: number, layout: TermiosLayout): Uint8Array {
  const termios = new Uint8Array(layout.size + 16);
  if (libc.tcgetattr(fd, termios) !== 0) throw new Error("tcgetattr failed");
  return termios;
}

/**
 * Sets the terminal on `fd` byte-clean (see the top of this file) and reads it back: the
 * settings, or why not. Set with TCSAFLUSH, so bytes that arrived while the terminal was still
 * as it was opened are discarded, never read as a frame.
 */
export function makeByteClean(
  fd: number,
  platform: NodeJS.Platform = process.platform,
): Result<TerminalSettings, LinkError> {
  const layout = layoutFor(platform);
  if (layout === undefined) return err(noLayout(platform));
  return Result.fromThrowable(
    () => {
      const libc = libcFor(layout);
      const termios = getTermios(libc, fd, layout);
      libc.cfmakeraw(termios);
      const view = new DataView(termios.buffer);
      const { flags } = layout;
      const mask = (names: readonly TermiosFlag[]) => names.reduce((m, f) => m | flags[f], 0) >>> 0;
      changeFlag(view, layout.iflag, layout, mask(INPUT_OFF), 0);
      changeFlag(view, layout.oflag, layout, flags.OPOST, 0);
      changeFlag(view, layout.lflag, layout, mask(LOCAL_OFF), 0);
      changeFlag(
        view,
        layout.cflag,
        layout,
        (flags.CSIZE | flags.PARENB | flags.CRTSCTS) >>> 0,
        (flags.CS8 | flags.CREAD | flags.CLOCAL) >>> 0,
      );
      termios[layout.cc + layout.vmin] = 1;
      termios[layout.cc + layout.vtime] = 0;
      if (libc.tcsetattr(fd, TCSAFLUSH, termios) !== 0) throw new Error("tcsetattr failed");
      const settings = settingsOf(getTermios(libc, fd, layout), layout);
      const problem = byteCleanProblem(settings, platform);
      if (problem !== undefined) throw new Error(`the terminal is not byte-clean: ${problem}`);
      return settings;
    },
    (thrown) => linkError("writeFailed", ORIGIN, "set the terminal byte-clean", thrown),
  )();
}

/** Reads what the terminal on `fd` is set to. */
export function terminalSettings(
  fd: number,
  platform: NodeJS.Platform = process.platform,
): Result<TerminalSettings, LinkError> {
  const layout = layoutFor(platform);
  if (layout === undefined) return err(noLayout(platform));
  return Result.fromThrowable(
    () => settingsOf(getTermios(libcFor(layout), fd, layout), layout),
    (thrown) => linkError("writeFailed", ORIGIN, "read the terminal's settings", thrown),
  )();
}

/**
 * Makes the read Bun's `tty.ReadStream` keeps waiting on the terminal return at once: the stream
 * only lets go of its descriptor when that read returns, and a read left waiting after a close
 * would take the first bytes meant for the next opener.
 * - macOS: VMIN 0 and VTIME 0, set at once; the waiting read re-reads them and returns nothing.
 * - Linux: a waiting read keeps the VMIN it began with, so the open file is made non-blocking
 *   first (`fcntl`, O_NONBLOCK), and setting the terminal (the same VMIN 0) wakes the read,
 *   which then returns EAGAIN. Either way the stream ends and closes the descriptor itself.
 */
function releaseRead(fd: number, platform: NodeJS.Platform): void {
  const layout = layoutFor(platform);
  if (layout === undefined) return;
  const libc = libcFor(layout);
  if (platform === "linux") {
    const flags = libc.fcntl(fd, F_GETFL, 0);
    if (flags < 0 || libc.fcntl(fd, F_SETFL, flags | LINUX_O_NONBLOCK) !== 0)
      throw new Error("fcntl failed");
  }
  const termios = getTermios(libc, fd, layout);
  termios[layout.cc + layout.vmin] = 0;
  termios[layout.cc + layout.vtime] = 0;
  if (libc.tcsetattr(fd, TCSANOW, termios) !== 0) throw new Error("tcsetattr failed");
}

/**
 * Opens the terminal at `path` for reading and writing, not as a controlling terminal, sets it
 * byte-clean (see the top of this file), and only then starts reading it. Node's
 * `setRawMode(true)` is not used: the settings above are all a link needs.
 */
export function openTty(path: string): Result<TtyPort, LinkError> {
  const opened = Result.fromThrowable(
    () => openSync(path, constants.O_RDWR | constants.O_NOCTTY),
    (thrown) => linkError("writeFailed", ORIGIN, `open serial port ${path}`, thrown),
  )();
  if (opened.isErr()) return err(opened.error);
  const fd = opened.value;
  const clean = makeByteClean(fd);
  if (clean.isErr()) {
    // Nothing reads it yet, so it closes at once.
    // Nothing reads it yet, so it closes at once; a failure to close changes nothing more.
    return Result.fromThrowable(
      () => {
        closeSync(fd);
      },
      (): LinkError => clean.error,
    )().andThen((): Result<TtyPort, LinkError> => err(clean.error));
  }
  return Result.fromThrowable(
    () => {
      const stream = new ReadStream(fd);
      // The read a close ends may report EAGAIN or EIO after the stream is destroyed: never an
      // unhandled 'error', which would be an uncaught exception (section 10).
      stream.on("error", () => undefined);
      return { path, fd, stream };
    },
    (thrown) => linkError("writeFailed", ORIGIN, `read serial port ${path}`, thrown),
  )();
}

/** Writes all of `bytes`; resolves when the terminal has taken them. */
export function writeTty(port: TtyPort, bytes: Uint8Array): ResultAsync<void, LinkError> {
  const written = new Promise<void>((resolve, reject) => {
    const from = (offset: number): void => {
      write(port.fd, bytes, offset, bytes.length - offset, null, (error, count) => {
        if (error !== null) reject(error);
        else if (offset + count < bytes.length) from(offset + count);
        else resolve();
      });
    };
    from(0);
  });
  return ResultAsync.fromPromise(written, (thrown) =>
    linkError("writeFailed", ORIGIN, `write to serial port ${port.path}`, thrown),
  );
}

/**
 * Closes the terminal at once, so the far end sees it hang up (its stream owns the descriptor).
 * Destroying a `tty.ReadStream` alone does not close it under Bun 1.4.2 until the read it keeps
 * waiting returns, which is at the next byte from the board, and closing the descriptor under
 * that read blocks the process. So the waiting read is made to return first (`releaseRead`);
 * the stream then ends and closes the descriptor itself.
 */
export function closeTty(
  port: TtyPort,
  platform: NodeJS.Platform = process.platform,
): Result<void, LinkError> {
  return Result.fromThrowable(
    () => {
      // Closed already (by the far end, or before): its number may be another file's now.
      if (port.stream.destroyed) return;
      releaseRead(port.fd, platform);
      port.stream.destroy();
    },
    (thrown) => linkError("closed", ORIGIN, `close serial port ${port.path}`, thrown),
  )();
}

#!/usr/bin/env bun
/**
 * A pseudo-terminal for the serial adapter's tests, without Python (so the tests also run in the
 * Linux container, `hub/test/linux/serial.sh`): prints the device's path, then relays bytes
 * between the terminal and this process's standard input and output, unchanged.
 *
 * - With no option the terminal is set raw (as `tty.setraw` would).
 * - With `--cooked` it is left as a new one is (canonical input, echo, output processing, flow
 *   control), as a USB serial port or the bench's terminal is, so the hub's own settings are what
 *   the test sees.
 * - With `--watch` (cooked too) it lets go of its own copy of the device once the far end has
 *   written something, and writes `open` then `closed` to standard error: the far end's first
 *   bytes, then its hang-up.
 */
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { ReadStream } from "node:tty";
import { CString, dlopen, FFIType } from "bun:ffi";
import { Result } from "neverthrow";
import { makeByteClean } from "../../../src/shell/safe/serial.ts";

const LIBRARY = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const O_RDWR = 2;
const O_NOCTTY = process.platform === "darwin" ? 0x20000 : 0o400;

const libc = dlopen(LIBRARY, {
  posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
  grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
  unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
  ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
}).symbols;

const watch = process.argv.includes("--watch");
const cooked = watch || process.argv.includes("--cooked");

const master = libc.posix_openpt(O_RDWR | O_NOCTTY);
if (master < 0 || libc.grantpt(master) !== 0 || libc.unlockpt(master) !== 0) {
  process.stderr.write("pty-relay: no pseudo-terminal\n");
  process.exit(1);
}
const name = libc.ptsname(master);
if (name === null) process.exit(1);
const path = new CString(name);
// Its own copy of the device, so the terminal stays up until the far end opens it.
let slave: number | undefined = openSync(path, constants.O_RDWR | constants.O_NOCTTY);
if (!cooked) makeByteClean(slave)._unsafeUnwrap();
process.stdout.write(`${path}\n`);

const say = (state: string): void => {
  if (watch) process.stderr.write(`${state}\n`);
};
let seen = false;
const stream = new ReadStream(master);
stream.on("data", (chunk: Buffer) => {
  if (!seen) {
    seen = true;
    say("open");
    if (watch && slave !== undefined) {
      closeSync(slave);
      slave = undefined;
    }
  }
  process.stdout.write(chunk);
});
const gone = (): void => {
  if (watch) {
    say("closed");
    return;
  }
  process.exit(0);
};
stream.on("error", gone);
stream.on("end", gone);
// A far end that is gone has nothing to deliver to: the write's failure is let go.
const deliver = Result.fromThrowable((chunk: Buffer) => writeSync(master, chunk));
process.stdin.on("data", (chunk: Buffer) => {
  deliver(chunk).match(
    () => undefined,
    () => undefined,
  );
});
process.stdin.on("end", () => process.exit(0));

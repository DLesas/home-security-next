#!/usr/bin/env bun
/**
 * `bun terminal-relay.ts <terminal>`: holds one of the bench's pseudo-terminals open, byte-clean
 * (`hub/src/shell/safe/serial.ts`), and relays bytes unchanged: the terminal's to standard output,
 * standard input's to the terminal. It ends when standard input ends or the terminal goes.
 *
 * Why a process of its own: so a stuck terminal can never block the bridge's own process, and
 * letting go of one is as sure as ending a process. (The hub's own serial links close in-process,
 * `hub/src/shell/safe/serial.ts`, `closeTty`.)
 */
import { openUnixTty, writeTty } from "@hsn/hub/src/shell/safe/serial.ts";

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write("usage: terminal-relay <terminal>\n");
  process.exit(2);
}
const port = openUnixTty(path);
if (port.isErr()) {
  process.stderr.write(`terminal-relay: ${port.error.message}\n`);
  process.exit(1);
}
const { stream } = port.value;
const end = (code: number): void => {
  process.exit(code);
};
stream.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk);
});
stream.on("error", () => {
  end(0);
});
stream.on("close", () => {
  end(0);
});
stream.on("end", () => {
  end(0);
});
// One write at a time, in order.
let writing: Promise<void> = Promise.resolve();
process.stdin.on("data", (chunk: Buffer) => {
  const bytes = new Uint8Array(chunk);
  writing = writing.then(async () => {
    const written = await writeTty(port.value, bytes);
    if (written.isErr()) end(1);
  });
});
process.stdin.on("end", () => {
  end(0);
});

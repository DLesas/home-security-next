/**
 * The file calls the hub makes off its thread (`shell/safe/off-loop.ts`, and the firmware store's
 * `syncFolderOffLoop`) leave the loop's timers running while a call waits: the proof design P
 * rests on, that Bun 1.4.2 runs `node:fs/promises` on its own pool, not on the calling thread.
 *
 * Each call is made to wait on purpose, about 500 ms, on a FIFO (Linux's and macOS's), until
 * another process comes to its other end: an open for reading with no writer, a write into a pipe
 * whose buffer is full with no reader, and a folder sync's open of a path that is a FIFO. While it
 * waits, a 10 ms timer on this thread is never late by half of the wait: had the call run on the
 * thread, the timer would have been late by the whole of it. (Half, not section 3's 50 ms: this
 * process's own collections pause it up to 186 ms on the hosted runners.) The calls that cannot
 * be made to wait so (a close, a removal) are measured on the hosted runners instead.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFolderOffLoop } from "../../../src/shell/safe/firmware-io.ts";
import {
  closeOffLoop,
  openNewOffLoop,
  readHeadOffLoop,
  removeOffLoop,
  writeAllOffLoop,
} from "../../../src/shell/safe/off-loop.ts";

const POSIX = process.platform !== "win32";
const root = mkdtempSync(join(tmpdir(), "hsn-off-loop-"));
const children: ReturnType<typeof Bun.spawn>[] = [];
/** How long the other end keeps the call waiting. */
const WAIT_MS = 500;

afterAll(() => {
  for (const child of children) child.kill(9);
  rmSync(root, { recursive: true, force: true });
});

let fifos = 0;
function fifo(): string {
  const path = join(root, `fifo-${(fifos += 1)}`);
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  return path;
}

/** Another process that, after `WAIT_MS`, runs `shell` (the FIFO's other end). */
function later(shell: string): void {
  children.push(Bun.spawn(["sh", "-c", `sleep ${WAIT_MS / 1000}; ${shell}`]));
}

/** `call` awaited, with a 10 ms timer on this thread: how long it took, and the timer's worst lateness. */
async function timed(call: () => Promise<unknown>): Promise<{ tookMs: number; lateMs: number }> {
  let last = performance.now();
  let lateMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    lateMs = Math.max(lateMs, now - last - 10);
    last = now;
  }, 10);
  const start = performance.now();
  await call();
  const tookMs = performance.now() - start;
  clearInterval(timer);
  return { tookMs, lateMs };
}

function offTheThread({ tookMs, lateMs }: { tookMs: number; lateMs: number }): void {
  console.log(
    `waited ${tookMs.toFixed(0)} ms; the loop's timer at most ${lateMs.toFixed(1)} ms late`,
  );
  // It did wait for the other end...
  expect(tookMs).toBeGreaterThan(WAIT_MS * 0.8);
  // ...and the loop went on meanwhile.
  expect(lateMs).toBeLessThan(WAIT_MS / 2);
}

describe.skipIf(!POSIX)("the file calls off the hub's thread leave the loop running", () => {
  test("an open for reading that waits for a writer (readHeadOffLoop)", async () => {
    const path = fifo();
    later(`printf 'HSNB' > ${path}`);
    let head: Uint8Array = new Uint8Array();
    offTheThread(
      await timed(async () => {
        head = (await readHeadOffLoop(path, 4))._unsafeUnwrap();
      }),
    );
    expect(new TextDecoder().decode(head)).toBe("HSNB");
  });

  test("a write into a full pipe that waits for a reader (writeAllOffLoop)", async () => {
    const path = fifo();
    // Opened for reading and writing, so the open itself does not wait; nobody reads it yet.
    const file = await open(path, "r+");
    later(`cat ${path} > /dev/null`);
    offTheThread(
      await timed(async () => {
        // A pipe holds 64 KB at most: a megabyte waits for the reader.
        expect((await writeAllOffLoop(file, new Uint8Array(1024 * 1024).fill(7))).isOk()).toBe(
          true,
        );
      }),
    );
    await file.close();
  });

  test("a folder sync whose open waits (syncFolderOffLoop, a removal's second call)", async () => {
    const path = fifo();
    later(`printf x > ${path}`);
    offTheThread(
      await timed(async () => {
        // A FIFO cannot be synced: what is tested is the open's wait, not the sync's result.
        (await syncFolderOffLoop(path)).match(
          () => undefined,
          () => undefined,
        );
      }),
    );
  });
});

describe("what the calls promise, on every system", () => {
  test("an open of a new file refuses a file that is already there, and leaves it as it was", async () => {
    const path = join(root, "there");
    writeFileSync(path, "kept");
    expect((await openNewOffLoop(path)).isErr()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("kept");
    const fresh = join(root, "fresh");
    const opened = await openNewOffLoop(fresh);
    expect(opened.isOk()).toBe(true);
    if (opened.isOk()) expect((await closeOffLoop(opened.value)).isOk()).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  test("a removal of a path that is not there succeeds, as a removal already made", async () => {
    expect((await removeOffLoop(join(root, "never-made"))).isOk()).toBe(true);
    const made = join(root, "made");
    writeFileSync(made, "x");
    expect((await removeOffLoop(made)).isOk()).toBe(true);
    expect(existsSync(made)).toBe(false);
  });
});

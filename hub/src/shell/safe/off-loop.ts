/**
 * File calls off the hub's thread (D145, design P): `node:fs/promises`, whose calls Bun 1.4.2 runs
 * on its own pool, not on the calling thread, so the loop's turns go on while a call waits on a
 * slow disk (Windows C: with the antivirus scanning: 513 ms for one create, 130 ms for a close;
 * stage 2's audit). Each settles with a result, never rejects; the error is the thrown value,
 * which the caller turns into its own kind (`thrown.ts`'s `errorFrom`, `backup/files.ts`'s
 * `fileError`). That the calls leave the thread free is tested where they can be made to wait
 * (`test/unit/safe/off-loop.test.ts`: an open, a read and a write on a FIFO) and measured where
 * they cannot (a close, a removal, a sync).
 */
import { type FileHandle, open, rm } from "node:fs/promises";
import { err, ok, type Result } from "neverthrow";

export type { FileHandle };

async function settled<T>(run: () => Promise<T>): Promise<Result<T, unknown>> {
  try {
    return ok(await run());
  } catch (thrown) {
    return err(thrown);
  }
}

/** Creates `path`, which must not exist, for writing, readable only by the hub's account. */
export function openNewOffLoop(path: string): Promise<Result<FileHandle, unknown>> {
  return settled(() => open(path, "wx", 0o600));
}

/** Writes all of `bytes` at the file's end. */
export function writeAllOffLoop(
  file: FileHandle,
  bytes: Uint8Array,
): Promise<Result<void, unknown>> {
  return settled(async () => {
    let at = 0;
    while (at < bytes.length) at += (await file.write(bytes, at, bytes.length - at)).bytesWritten;
  });
}

/** Closes the file. */
export function closeOffLoop(file: FileHandle): Promise<Result<void, unknown>> {
  return settled(() => file.close());
}

/** Removes a file, or a folder and what is in it, if it is there. */
export function removeOffLoop(path: string): Promise<Result<void, unknown>> {
  return settled(() => rm(path, { recursive: true, force: true }));
}

/** The first `length` bytes of the file at `path` (fewer if it is shorter). */
export function readHeadOffLoop(
  path: string,
  length: number,
): Promise<Result<Uint8Array, unknown>> {
  return settled(async () => {
    const file = await open(path, "r");
    try {
      const into = new Uint8Array(length);
      // From where the open left it, the start: so a pipe can be read as well as a file.
      const { bytesRead } = await file.read(into, 0, length, null);
      return into.slice(0, bytesRead);
    } finally {
      await file.close();
    }
  });
}

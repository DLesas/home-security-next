/**
 * The backup folder's and the data folder's file work for backups, restore and updates, behind
 * results (hub-design.md section 10): `node:fs` throws, so each call is wrapped by neverthrow's
 * `Result.fromThrowable`, as `shell/calendar/temporal.ts` wraps Temporal. A failure says which of
 * `FileOutcome`'s reasons it is: a folder that is not there or not ours is `unreachable`, a full
 * disk `full`, anything else `io`.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { err, ok, Result } from "neverthrow";
import type { FileFailure } from "../../core/model/events.ts";

export interface FileError {
  readonly reason: FileFailure;
  readonly message: string;
}

const UNREACHABLE = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EROFS", "ENODEV", "EIO"]);
const FULL = new Set(["ENOSPC", "EDQUOT", "EFBIG"]);

function codeOf(thrown: unknown): string | undefined {
  return typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    typeof thrown.code === "string"
    ? thrown.code
    : undefined;
}

export function fileError(what: string): (thrown: unknown) => FileError {
  return (thrown) => {
    const code = codeOf(thrown);
    const reason: FileFailure =
      code !== undefined && FULL.has(code)
        ? "full"
        : code !== undefined && UNREACHABLE.has(code)
          ? "unreachable"
          : "io";
    return {
      reason,
      message: `${what}: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    };
  };
}

function call<T>(what: string, run: () => T): Result<T, FileError> {
  return Result.fromThrowable(run, fileError(what))();
}

/** Syncs a folder so a rename in it survives a power cut (POSIX; Windows has no folder sync). */
export function syncFolder(path: string): Result<void, FileError> {
  if (process.platform === "win32") return ok(undefined);
  return call(`sync ${path}`, () => {
    const fd = openSync(path, "r");
    const synced = Result.fromThrowable(
      () => {
        fsyncSync(fd);
      },
      fileError(`sync ${path}`),
    )();
    closeSync(fd);
    return synced;
  }).andThen((synced) => synced);
}

/**
 * Writes `bytes` to `path` durably (section 9, "Where and how"): to a temporary file beside it,
 * synced, renamed, the folder synced. On a failure the temporary file is removed.
 */
export function writeDurably(
  path: string,
  temporary: string,
  bytes: Uint8Array,
): Result<void, FileError> {
  const written = call(`write ${temporary}`, () => {
    const fd = openSync(temporary, "wx", 0o600);
    const done = Result.fromThrowable(
      () => {
        let at = 0;
        while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
        fsyncSync(fd);
      },
      fileError(`write ${temporary}`),
    )();
    closeSync(fd);
    return done;
  })
    .andThen((done) => done)
    .andThen(() =>
      call(`rename ${temporary}`, () => {
        renameSync(temporary, path);
      }),
    )
    .andThen(() => syncFolder(dirname(path)));
  if (written.isErr()) removeQuietly(temporary);
  return written;
}

/** Removes a file if it is there; a failure is ignored (a temporary file left after a failure). */
export function removeQuietly(path: string): void {
  Result.fromThrowable(() => {
    rmSync(path, { force: true });
  })().match(
    () => undefined,
    () => undefined,
  );
}

export function remove(path: string): Result<void, FileError> {
  return call(`remove ${path}`, () => {
    rmSync(path, { force: true });
  });
}

export function rename(from: string, to: string): Result<void, FileError> {
  return call(`rename ${from}`, () => {
    renameSync(from, to);
  });
}

/** A folder's names; the folder must exist (an unplugged drive is `unreachable`). */
export function listFolder(path: string): Result<readonly string[], FileError> {
  return call(`list ${path}`, () => readdirSync(path));
}

export function readWhole(path: string): Result<Uint8Array, FileError> {
  return call(`read ${path}`, () => new Uint8Array(readFileSync(path)));
}

/** The first `length` bytes of a file, fewer if it is shorter. */
export function readHead(path: string, length: number): Result<Uint8Array, FileError> {
  return call(`read ${path}`, () => {
    const fd = openSync(path, "r");
    const into = new Uint8Array(length);
    const n = Result.fromThrowable(
      () => readSync(fd, into, 0, length, 0),
      fileError(`read ${path}`),
    )();
    closeSync(fd);
    return n.map((count) => into.slice(0, count));
  }).andThen((read) => read);
}

/** Whether two paths are on one device (`stat`'s `dev`): false when either cannot be read. */
export function sameDevice(a: string, b: string): boolean {
  return call(`stat ${a} and ${b}`, () => statSync(a).dev === statSync(b).dev).unwrapOr(false);
}

export function exists(path: string): boolean {
  return call(
    `stat ${path}`,
    () => statSync(path, { throwIfNoEntry: false }) !== undefined,
  ).unwrapOr(false);
}

/** An error result, for callers that build one. */
export function failure<T>(reason: FileFailure, message: string): Result<T, FileError> {
  return err({ reason, message });
}

/** Bytes joined into one array without a copy element by element (`Uint8Array.from` iterates). */
export function joined(parts: readonly Uint8Array[]): Uint8Array {
  const buffer = Buffer.concat(parts);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

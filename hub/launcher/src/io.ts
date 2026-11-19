/**
 * The launcher's file work, behind results (hub-design.md section 10: our own code never throws;
 * `node:fs` does, so each call is wrapped by neverthrow's `Result.fromThrowable`, as
 * `shell/calendar/temporal.ts` wraps Temporal). The launcher depends only on Bun, neverthrow and
 * the shared list-only Win32 adapter, so it can start without the hub or its control socket.
 */
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { err, ok, Result } from "neverthrow";
import { listWindowsDirectory } from "../../src/shell/safe/ffi-windows-list.ts";

export interface IoError {
  readonly what: string;
  readonly code: string | undefined;
  readonly message: string;
}

function ioError(what: string): (thrown: unknown) => IoError {
  return (thrown) => ({
    what,
    code:
      typeof thrown === "object" &&
      thrown !== null &&
      "code" in thrown &&
      typeof thrown.code === "string"
        ? thrown.code
        : undefined,
    message: thrown instanceof Error ? thrown.message : String(thrown),
  });
}

function call<T>(what: string, run: () => T): Result<T, IoError> {
  return Result.fromThrowable(run, ioError(what))();
}

/** A text file, or undefined when it does not exist. */
export function readText(path: string): Result<string | undefined, IoError> {
  return call<string | undefined>(`read ${path}`, () => readFileSync(path, "utf8")).orElse(
    (error) => (error.code === "ENOENT" ? ok(undefined) : err(error)),
  );
}

/** Syncs a folder, so a rename in it survives a power cut (POSIX; Windows has no folder sync). */
function syncFolder(path: string): Result<void, IoError> {
  if (process.platform === "win32") return ok(undefined);
  return call(`sync ${path}`, () => {
    const fd = openSync(path, "r");
    const synced = Result.fromThrowable(
      () => {
        fsyncSync(fd);
      },
      ioError(`sync ${path}`),
    )();
    closeSync(fd);
    return synced;
  }).andThen((synced) => synced);
}

/** Writes a file durably: beside it, synced, renamed over it, the folder synced. */
export function writeDurably(path: string, data: string | Uint8Array): Result<void, IoError> {
  const temporary = `${path}.new`;
  return call(`write ${temporary}`, () => {
    const fd = openSync(temporary, "w", 0o600);
    const written = Result.fromThrowable(
      () => {
        writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
        fsyncSync(fd);
      },
      ioError(`write ${temporary}`),
    )();
    closeSync(fd);
    return written;
  })
    .andThen((written) => written)
    .andThen(() =>
      call(`rename ${temporary}`, () => {
        renameSync(temporary, path);
      }),
    )
    .andThen(() => syncFolder(dirname(path)));
}

export function removePath(path: string): Result<void, IoError> {
  return call(`remove ${path}`, () => {
    rmSync(path, { force: true, recursive: true });
  });
}

export function makeFolder(path: string): Result<void, IoError> {
  return call(`create ${path}`, () => {
    mkdirSync(path, { recursive: true });
  });
}

/** The names in a folder; none when it does not exist. */
export function names(path: string): Result<readonly string[], IoError> {
  const what = `list ${path}`;
  // Bun's generic read asks for FILE_READ_EA. The service can list its data folder without it.
  if (process.platform === "win32") return call(what, () => listWindowsDirectory(path));
  return call<readonly string[]>(what, () => readdirSync(path)).orElse((error) =>
    error.code === "ENOENT" ? ok([]) : err(error),
  );
}

/** A file's modification time and size, or undefined when it does not exist. */
export function stamp(
  path: string,
): Result<{ readonly mtimeMs: number; readonly size: number } | undefined, IoError> {
  return call(`stat ${path}`, () => {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats === undefined ? undefined : { mtimeMs: stats.mtimeMs, size: stats.size };
  });
}

export function isFolder(path: string): Result<boolean, IoError> {
  return call(
    `stat ${path}`,
    () => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
  );
}

/** Copies `from` over `to` durably: to a file beside it, synced, renamed. */
export function copyDurably(from: string, to: string): Result<void, IoError> {
  const temporary = `${to}.new`;
  return call(`copy ${from}`, () => {
    copyFileSync(from, temporary);
  })
    .andThen(() =>
      call(`sync ${temporary}`, () => {
        const fd = openSync(temporary, "r+");
        const synced = Result.fromThrowable(
          () => {
            fsyncSync(fd);
          },
          ioError(`sync ${temporary}`),
        )();
        closeSync(fd);
        return synced;
      }).andThen((synced) => synced),
    )
    .andThen(() =>
      call(`rename ${temporary}`, () => {
        renameSync(temporary, to);
      }),
    )
    .andThen(() => syncFolder(dirname(to)));
}

/**
 * Points the link `path` at `target`: a symbolic link on macOS and Linux, made beside it and
 * renamed over it; a directory junction on Windows, which needs no privilege but cannot be
 * renamed over another, so it is replaced.
 */
export function pointLink(path: string, target: string): Result<void, IoError> {
  if (process.platform === "win32") {
    return removePath(path).andThen(() =>
      call(`link ${path}`, () => {
        symlinkSync(target, path, "junction");
      }),
    );
  }
  const temporary = `${path}.new`;
  return removePath(temporary)
    .andThen(() =>
      call(`link ${temporary}`, () => {
        symlinkSync(target, temporary);
      }),
    )
    .andThen(() =>
      call(`rename ${temporary}`, () => {
        renameSync(temporary, path);
      }),
    );
}

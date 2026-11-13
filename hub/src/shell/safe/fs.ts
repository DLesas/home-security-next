/**
 * `node:fs` and `node:net` behind results (hub-design.md section 10): the data folder, the
 * control socket's file and listener, `fatal.log`, the database's companion files, and standard
 * error. Each call says which kind of `HubError` its failure is, since the same call serves the
 * storage, the control socket and the top-level handler.
 */
import {
  type FSWatcher,
  appendFileSync,
  chmodSync,
  lstatSync,
  type Stats,
  unlinkSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { HubError, HubErrorKind } from "../../core/model/errors.ts";
import { errorFrom, thrownCode } from "./thrown.ts";

type FsError<K extends HubErrorKind> = HubError & { readonly kind: K };

/** Who is asking, for the error: its kind and origin. */
export interface FsCaller<K extends HubErrorKind> {
  readonly kind: K;
  readonly origin: string;
}

function attempt<T, K extends HubErrorKind>(
  caller: FsCaller<K>,
  what: string,
  run: () => T,
): Result<T, FsError<K>> {
  try {
    return ok(run());
  } catch (thrown) {
    return err(errorFrom(caller.kind, caller.origin, what, thrown));
  }
}

/** Like `attempt`, but a missing file (`ENOENT`) is `missing`, not an error. */
function attemptUnlessMissing<T, K extends HubErrorKind>(
  caller: FsCaller<K>,
  what: string,
  missing: T,
  run: () => T,
): Result<T, FsError<K>> {
  try {
    return ok(run());
  } catch (thrown) {
    if (thrownCode(thrown) === "ENOENT") return ok(missing);
    return err(errorFrom(caller.kind, caller.origin, what, thrown));
  }
}

/** Creates a folder and its parents, readable only by the hub's account (section 6). */
export function ensureDir<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
  mode = 0o700,
): Result<void, FsError<K>> {
  return attempt(caller, `create folder ${path}`, () => {
    mkdirSync(path, { recursive: true, mode });
  });
}

/** Whether a file or folder exists; any error but "not found" is an error. */
export function pathExists<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
): Result<boolean, FsError<K>> {
  return attemptUnlessMissing(caller, `look for ${path}`, false, () => {
    statSync(path);
    return true;
  });
}

/** A file's size in bytes, or undefined when it does not exist. */
export function fileSize<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
): Result<number | undefined, FsError<K>> {
  return attemptUnlessMissing<number | undefined, K>(
    caller,
    `size of ${path}`,
    undefined,
    () => statSync(path).size,
  );
}

/** A text file's contents, or undefined when it does not exist. */
export function readTextIfExists<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
): Result<string | undefined, FsError<K>> {
  return attemptUnlessMissing<string | undefined, K>(caller, `read ${path}`, undefined, () =>
    readFileSync(path, "utf8"),
  );
}

/** Appends `text` and syncs it to the disk before returning (`fatal.log`, section 10). */
export function appendDurably<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
  text: string,
  mode = 0o600,
): Result<void, FsError<K>> {
  return attempt(caller, `append to ${path}`, () => {
    const fd = openSync(path, "a", mode);
    try {
      appendFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}

/**
 * Replaces a file's contents with `text`, durably: written to a file beside it, synced, then
 * renamed over it, so a power cut leaves either the old contents or the new.
 */
export function replaceDurably<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
  text: string,
  mode = 0o600,
): Result<void, FsError<K>> {
  return attempt(caller, `replace ${path}`, () => {
    const temporary = `${path}.new`;
    const fd = openSync(temporary, "w", mode);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  });
}

/** The names in a folder; none when it does not exist. */
export function folderNames<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
): Result<readonly string[], FsError<K>> {
  return attemptUnlessMissing<readonly string[], K>(caller, `list ${path}`, [], () =>
    readdirSync(path),
  );
}

/** Copies a file, replacing the target. */
export function copyFile<K extends HubErrorKind>(
  caller: FsCaller<K>,
  from: string,
  to: string,
): Result<void, FsError<K>> {
  return attempt(caller, `copy ${from} to ${to}`, () => {
    copyFileSync(from, to);
  });
}

/** Removes a file if it exists. */
export function removeFile<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
): Result<void, FsError<K>> {
  return attempt(caller, `remove ${path}`, () => {
    rmSync(path, { force: true });
  });
}

/** Reads up to `into.length` bytes of a file from its start; 0 when it does not exist. */
export function readStart<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
  into: Uint8Array,
): Result<number, FsError<K>> {
  return attemptUnlessMissing(caller, `read ${path}`, 0, () => {
    const fd = openSync(path, "r");
    try {
      return readSync(fd, into, 0, into.length, 0);
    } finally {
      closeSync(fd);
    }
  });
}

/** Writes to standard error, synchronously, so it is out before the process exits (section 10). */
export function writeStandardError<K extends HubErrorKind>(
  caller: FsCaller<K>,
  text: string,
): Result<void, FsError<K>> {
  return attempt(caller, "write to standard error", () => {
    writeSync(2, text);
  });
}

/**
 * Listens on a Unix domain socket at `path` (the control socket, section 9); resolves once
 * listening, or with the error that stopped it (a path in use, a folder that does not exist).
 */
export function listenUnixSocket<K extends HubErrorKind>(
  caller: FsCaller<K>,
  path: string,
  onConnection: (socket: Socket) => void,
): ResultAsync<Server, FsError<K>> {
  const listening = new Promise<Server>((resolve, reject) => {
    const server = createServer(onConnection);
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
  return ResultAsync.fromPromise(listening, (thrown) =>
    errorFrom(caller.kind, caller.origin, `listen on ${path}`, thrown),
  );
}

/**
 * Watches `folder` for new and removed entries (section 3: the hub watches `/dev` rather than
 * listing ports on a timer). A watcher that fails later calls `failed` and stops.
 */
export function watchFolder(
  folder: string,
  changed: (name: string | null) => void,
  failed: (error: HubError) => void,
): Result<FSWatcher, HubError> {
  const start = Result.fromThrowable(
    () =>
      watch(folder, { persistent: false }, (_event, name) => {
        changed(name);
      }),
    (thrown) => errorFrom("link", "shell/safe/fs", `watch ${folder}`, thrown),
  );
  return start().map((watcher) => {
    watcher.on("error", (thrown) => {
      failed(errorFrom("link", "shell/safe/fs", `watching ${folder}`, thrown));
    });
    return watcher;
  });
}

/** Stops a watcher. */
export function stopWatching(watcher: FSWatcher): Result<void, HubError> {
  return Result.fromThrowable(
    () => {
      watcher.close();
    },
    (thrown) => errorFrom("link", "shell/safe/fs", "stop watching", thrown),
  )();
}

/** A path's status (following links). */
export function statPath<K extends HubErrorKind>(
  caller: FsCaller<K>,
  what: string,
  path: string,
): Result<Stats, FsError<K>> {
  return attempt(caller, what, () => statSync(path));
}

/** A path's own status (not following a link), or undefined when there is nothing there. */
export function lstatPath<K extends HubErrorKind>(
  caller: FsCaller<K>,
  what: string,
  path: string,
): Result<Stats | undefined, FsError<K>> {
  return attempt(caller, what, () => lstatSync(path, { throwIfNoEntry: false }));
}

/** Makes a folder and its parents with `mode`. */
export function makeFolder<K extends HubErrorKind>(
  caller: FsCaller<K>,
  what: string,
  path: string,
  mode: number,
): Result<void, FsError<K>> {
  return attempt(caller, what, () => {
    mkdirSync(path, { recursive: true, mode });
  });
}

/** Sets a path's permission bits. */
export function setMode<K extends HubErrorKind>(
  caller: FsCaller<K>,
  what: string,
  path: string,
  mode: number,
): Result<void, FsError<K>> {
  return attempt(caller, what, () => {
    chmodSync(path, mode);
  });
}

/** Removes a file (a socket file included). */
export function unlinkPath<K extends HubErrorKind>(
  caller: FsCaller<K>,
  what: string,
  path: string,
): Result<void, FsError<K>> {
  return attempt(caller, what, () => {
    unlinkSync(path);
  });
}

/**
 * The control socket's file (hub-design.md section 9; D61, D62): `control.sock` in the hub's data
 * folder, which only the hub's account may open. The folder is made, or tightened, to mode 0700
 * and must belong to the hub's account, so no other user can reach the socket even in the moment
 * between its creation and its own mode being set; the socket is then set to 0600 and checked on
 * the file itself. A socket file left by a hub that is gone is removed; one a running hub answers
 * on is not.
 *
 * The socket's permissions are the real check (section 9). A client's user id cannot be read
 * from Node's `net` module, so the hub cannot name the peer; the actor is the user name the CLI
 * reports, recorded as such.
 *
 * The `node:fs` calls are the wrappers of `shell/safe/fs.ts` (section 10).
 */
import { connect } from "node:net";
import { dirname } from "node:path";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { lstatPath, makeFolder, setMode, statPath, unlinkPath } from "../safe/fs.ts";

const ORIGIN = "shell/control/socket-file";

/** Owner read, write and search: the data folder (section 6: readable only by the hub's account). */
export const FOLDER_MODE = 0o700;
/** Owner read and write: the socket. */
export const SOCKET_MODE = 0o600;
/** Any permission for the group or others. */
const GROUP_OR_OTHERS = 0o077;
/** The permission bits of a mode. */
const PERMISSION_BITS = 0o777;

/**
 * The longest socket path, in bytes: `sun_path` holds 104 bytes on macOS and 108 on Linux, each
 * with its terminating zero; the shorter one is used everywhere.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/** How long a probe of an existing socket waits for a hub to answer. */
const PROBE_MS = 500;

function fsError(
  message: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): HubError {
  return detail === undefined
    ? { kind: "config", origin: ORIGIN, message }
    : { kind: "config", origin: ORIGIN, message, detail };
}

const CALLER = { kind: "config", origin: ORIGIN } as const;
const safeStat = (path: string) => statPath(CALLER, "cannot read the data folder", path);
const safeLstat = (path: string) => lstatPath(CALLER, "cannot read the socket file", path);
const safeMkdir = (path: string) =>
  makeFolder(CALLER, "cannot make the data folder", path, FOLDER_MODE);
const safeChmod = (path: string, mode: number) =>
  setMode(CALLER, "cannot set permissions", path, mode);
const safeUnlink = (path: string) => unlinkPath(CALLER, "cannot remove the old socket file", path);

/** This process's user id, or undefined where the system has none (Windows). */
export function ownUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * The data folder exists, belongs to the hub's account (`owner`, this process's by default; a
 * test names another to show a folder of a different account is refused), and is open to it
 * alone.
 */
export function secureFolder(
  folder: string,
  owner: number | undefined = ownUid(),
): Result<void, HubError> {
  return safeMkdir(folder)
    .andThen(() => safeStat(folder))
    .andThen((stats) => {
      const uid = owner;
      if (!stats.isDirectory()) return err(fsError("the data folder is not a folder", { folder }));
      if (uid !== undefined && stats.uid !== uid) {
        return err(
          fsError("the data folder belongs to another account", { folder, owner: stats.uid }),
        );
      }
      return (stats.mode & GROUP_OR_OTHERS) === 0 ? ok(undefined) : safeChmod(folder, FOLDER_MODE);
    })
    .andThen(() => safeStat(folder))
    .andThen((stats) =>
      (stats.mode & GROUP_OR_OTHERS) === 0
        ? ok(undefined)
        : err(
            fsError("the data folder is open to other accounts", {
              folder,
              mode: stats.mode & PERMISSION_BITS,
            }),
          ),
    );
}

/** True when a hub answers on the socket at `path`. */
function answers(path: string): ResultAsync<boolean, HubError> {
  return ResultAsync.fromSafePromise(
    new Promise<boolean>((resolve) => {
      const probe = connect(path);
      const done = (alive: boolean): void => {
        probe.destroy();
        resolve(alive);
      };
      probe.setTimeout(PROBE_MS, () => {
        done(false);
      });
      probe.once("connect", () => {
        done(true);
      });
      probe.once("error", () => {
        done(false);
      });
    }),
  );
}

/**
 * Makes the socket's place ready: the folder secured, the path short enough, and an old socket
 * file removed if no hub answers on it. Anything else at the path is left and refused.
 */
export function prepareSocketPath(
  path: string,
  owner: number | undefined = ownUid(),
): ResultAsync<void, HubError> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    return errAsync(
      fsError(`the socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes`, { path }),
    );
  }
  const folder = secureFolder(dirname(path), owner).andThen(() => safeLstat(path));
  if (folder.isErr()) return errAsync(folder.error);
  const existing = folder.value;
  if (existing === undefined) return okAsync(undefined);
  if (!existing.isSocket())
    return errAsync(fsError("something that is not a socket is at the socket's path", { path }));
  return answers(path).andThen((alive) =>
    alive ? errAsync(fsError("another hub is running on this socket", { path })) : safeUnlink(path),
  );
}

/**
 * Sets the socket to 0600 and checks it on the file itself: its mode, and that it belongs to the
 * hub's account (`owner`, this process's by default), the only one 0600 lets in.
 */
export function secureSocket(
  path: string,
  owner: number | undefined = ownUid(),
): Result<void, HubError> {
  return safeChmod(path, SOCKET_MODE)
    .andThen(() => safeStat(path))
    .andThen((stats) =>
      owner !== undefined && stats.uid !== owner
        ? err(fsError("the socket belongs to another account", { path, owner: stats.uid }))
        : (stats.mode & PERMISSION_BITS) === SOCKET_MODE
          ? ok(undefined)
          : err(
              fsError("the socket's permissions did not take", {
                path,
                mode: stats.mode & PERMISSION_BITS,
              }),
            ),
    );
}

/** Removes the socket file at a clean stop. */
export function removeSocket(path: string): Result<void, HubError> {
  return safeLstat(path).andThen((stats) =>
    stats?.isSocket() === true ? safeUnlink(path) : ok(undefined),
  );
}

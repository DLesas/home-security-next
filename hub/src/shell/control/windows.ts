/**
 * The control socket on Windows (hub-design.md section 9; m2-design.md section 9, W2): an
 * AF_UNIX socket, `control.sock` in the data folder, as on macOS and Linux, opened only when the
 * folder's access list admits nobody but the hub's own account, Administrators and SYSTEM
 * (`windows-acl.ts` has the rule and why). Spike W2 showed the folder's list is the whole
 * protection, and that `stat` of a socket file fails there with EACCES, so nothing here reads
 * POSIX modes or user ids; the Win32 calls are `shell/safe/control-socket-windows.ts`.
 *
 * The steps, in order, each refusing with what it found:
 *
 * 1. **The account**: the SID of the hub's process (the virtual account `NT SERVICE\HSNHub` as a
 *    service, section 9).
 * 2. **The folder's place** (the folder is not made here: the installer makes it with its list):
 *    it exists and is a folder; neither it nor any folder above it is a link (any reparse point:
 *    a symbolic link, a junction, a mount point), since a link can be pointed elsewhere after the
 *    check; it is not on a network drive, whose list another computer keeps, nor on a drive of a
 *    kind Windows cannot tell. Refused, and nothing is changed.
 * 3. **The folder's list.** One that cannot be read, or bytes that are not a descriptor: refused,
 *    nothing changed. One that breaks the rule is **open**, and the hub closes it itself, as the
 *    installer would (section 9, "set twice"), recording the warning `data_folder_was_open`:
 *    - open, and closed by the hub: any entry for another account, inheritance on, an inherited
 *      entry, no list at all, an entry of a kind the hub does not read. The hub sets the
 *      installer's list (`protectedAcl`: full control for the three accounts, passed on to what
 *      is inside, protected), reads it back, and checks the place and the list again; only then
 *      does it go on. The list it sets names those three accounts and no one else, whatever was
 *      there, so setting it never lets anyone in.
 *    - open, and not closed: an owner who is not one of the three (setting the list cannot
 *      change an owner, who can rewrite it); a file system without access lists (FAT, exFAT); a
 *      link anywhere inside the folder (setting the list passes it on to what is inside, and must
 *      not pass through a link); a list the hub has no right to set; a read-back still open.
 *      Refused, with the warning.
 * 4. **The socket's path**: nothing there, or an AF_UNIX socket file (a reparse point tagged
 *    IO_REPARSE_TAG_AF_UNIX) that no hub answers on, which is removed. A running hub's socket,
 *    or anything else, is left and refused.
 * 5. **After listening**: an AF_UNIX socket file is at the path (a path taken as a named pipe
 *    leaves none, and is refused), and its own list, inherited from the folder, passes the rule.
 */
import { win32 } from "node:path";
import { err, errAsync, ok, okAsync, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { FoundEntry, Volume, WindowsCalls } from "../safe/control-socket-windows.ts";
import { unlinkPath } from "../safe/fs.ts";
import { hubAnswers, MAX_SOCKET_PATH_BYTES } from "./socket-file.ts";
import type { SocketSteps } from "./socket-steps.ts";
import {
  type Accounts,
  ADMINISTRATORS_SID,
  checkDescriptor,
  type Descriptor,
  descriptorProblems,
  ownerAllowed,
  parseDescriptor,
  parseSid,
  protectedAcl,
  SYSTEM_SID,
} from "./windows-acl.ts";

const ORIGIN = "shell/control/windows";

export const FILE_ATTRIBUTE_DIRECTORY = 0x10;
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
/** The reparse tag of an AF_UNIX socket file (winnt.h). */
export const IO_REPARSE_TAG_AF_UNIX = 0x8000_0023;
/** `GetVolumeInformationW`: the file system keeps access lists. */
export const FILE_PERSISTENT_ACLS = 0x8;
/** `GetDriveTypeW`. */
export const DRIVE_UNKNOWN = 0;
export const DRIVE_NO_ROOT_DIR = 1;
export const DRIVE_REMOTE = 4;
/** The most entries the hub looks through inside the data folder before setting its list ‡. */
export const MAX_ENTRIES_CHECKED = 10_000;

/** The accounts named in a refusal of the folder. */
const WHO = `the hub's account, Administrators (${ADMINISTRATORS_SID}) and SYSTEM (${SYSTEM_SID})`;

/**
 * The warning recorded when the data folder was found open (m2-design.md section 9): another
 * account may have read the device keys before. `closed` says whether the hub closed it.
 */
export interface ControlWarning {
  readonly code: "data_folder_was_open";
  readonly message: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export type WarningSink = (warning: ControlWarning) => void;

function refused(
  message: string,
  detail: Readonly<Record<string, string | number | boolean>>,
): HubError {
  return { kind: "config", origin: ORIGIN, message, detail };
}

function unreadable(what: string, error: HubError): HubError {
  return refused(`${what}: ${error.message}`, { cause: error.message });
}

function isSocketFile(entry: FoundEntry): boolean {
  return (
    (entry.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 &&
    entry.reparseTag === IO_REPARSE_TAG_AF_UNIX
  );
}

/** The folder, then each folder above it, up to the root (which is not checked). */
function folderAndAbove(full: string): readonly string[] {
  const { root } = win32.parse(full);
  const out: string[] = [];
  for (let at = full; at.length > root.length; at = win32.dirname(at)) {
    out.push(at);
    if (win32.dirname(at) === at) break;
  }
  return out;
}

/** The hub's own account. */
export function accountsOf(calls: WindowsCalls): Result<Accounts, HubError> {
  return calls
    .processSid()
    .mapErr((error) => unreadable("the hub cannot tell which account it runs as", error))
    .andThen((bytes) =>
      parseSid(bytes, 0).mapErr((why) =>
        refused(`the hub cannot tell which account it runs as: ${why}`, {}),
      ),
    )
    .map(({ sid }) => ({ hub: sid }));
}

/** Step 2: the folder exists, is a folder, has no link in its path, and is on a local drive. */
function checkPlace(full: string, calls: WindowsCalls): Result<Volume, HubError> {
  for (const at of folderAndAbove(full)) {
    const found = calls.attributes(at);
    if (found.isErr()) return err(unreadable(`the hub cannot look at ${at}`, found.error));
    const attributes = found.value;
    if (attributes === undefined)
      return err(
        refused(
          at === full
            ? "the data folder does not exist: the installer makes it, with its access list"
            : `a folder above the data folder does not exist: ${at}`,
          { folder: full },
        ),
      );
    if (at === full && (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0)
      return err(refused("the data folder is not a folder", { folder: full }));
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0)
      return err(
        refused(
          `${at === full ? "the data folder" : `${at}, above the data folder,`} is a link (a reparse point: a symbolic link, junction or mount point), which could be pointed elsewhere after the check`,
          { folder: full, link: at },
        ),
      );
  }
  const volume = calls.volume(full);
  if (volume.isErr())
    return err(unreadable("the hub cannot read the data folder's volume", volume.error));
  const { root, driveType } = volume.value;
  if (driveType === DRIVE_REMOTE)
    return err(
      refused(
        `the data folder is on a network drive (${root}), whose access list another computer keeps`,
        { folder: full, volume: root },
      ),
    );
  if (driveType === DRIVE_UNKNOWN || driveType === DRIVE_NO_ROOT_DIR)
    return err(
      refused(`the data folder's drive (${root}) is of a kind the hub cannot tell`, {
        folder: full,
        volume: root,
        driveType,
      }),
    );
  return ok(volume.value);
}

/** The folder's descriptor, read and parsed; an error when it cannot be. */
function readList(full: string, calls: WindowsCalls): Result<Descriptor, HubError> {
  const bytes = calls.securityDescriptor(full);
  if (bytes.isErr())
    return err(unreadable("the data folder's access list cannot be read", bytes.error));
  return parseDescriptor(bytes.value).mapErr((why) =>
    refused(`the data folder's access list cannot be read (${why})`, { folder: full }),
  );
}

/** No link anywhere inside the folder, which setting its list would pass through. */
function noLinkInside(full: string, calls: WindowsCalls): Result<void, HubError> {
  const folders = [full];
  let seen = 0;
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    const names = calls.list(folder);
    if (names.isErr()) return err(unreadable(`the hub cannot list ${folder}`, names.error));
    for (const name of names.value) {
      const child = win32.join(folder, name);
      seen += 1;
      if (seen > MAX_ENTRIES_CHECKED)
        return err(
          refused(`the data folder holds more than ${MAX_ENTRIES_CHECKED} entries to check`, {
            folder: full,
          }),
        );
      const found = calls.attributes(child);
      if (found.isErr()) return err(unreadable(`the hub cannot look at ${child}`, found.error));
      const attributes = found.value;
      if (attributes === undefined) continue;
      if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        const entry = calls.findEntry(child);
        if (entry.isErr()) return err(unreadable(`the hub cannot look at ${child}`, entry.error));
        if (entry.value !== undefined && isSocketFile(entry.value)) continue;
        return err(
          refused(
            `${child}, inside the data folder, is a link, which setting the folder's list would pass through`,
            { folder: full, link: child },
          ),
        );
      }
      if ((attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0) folders.push(child);
    }
  }
  return ok(undefined);
}

/** Sets the installer's list, reads it back, and checks the place and the list again. */
function closeFolder(
  full: string,
  calls: WindowsCalls,
  accounts: Accounts,
  descriptor: Descriptor,
): Result<void, HubError> {
  if (!ownerAllowed(descriptor, accounts))
    return err(
      refused(
        `its owner is not one of ${WHO}, and setting the list cannot change an owner, so the hub does not set it`,
        { folder: full },
      ),
    );
  return noLinkInside(full, calls)
    .andThen(() =>
      protectedAcl(accounts).mapErr((why) =>
        refused(`the hub cannot write the list: ${why}`, { folder: full }),
      ),
    )
    .andThen((acl) =>
      calls
        .setProtectedList(full, acl)
        .mapErr((error) => unreadable("the hub could not set the list", error)),
    )
    .andThen(() => checkPlace(full, calls))
    .andThen(() => readList(full, calls))
    .andThen((after) => {
      const still = descriptorProblems(after, accounts, true);
      return still.length === 0
        ? ok(undefined)
        : err(
            refused(`the list the hub set reads back open: ${still.join("; ")}`, {
              folder: full,
              found: still.join("; "),
            }),
          );
    });
}

/** Steps 2 and 3 of the top of this file: the data folder, closed by the hub if it was open. */
export function checkFolder(
  folder: string,
  calls: WindowsCalls,
  accounts: Accounts,
  warn: WarningSink,
): Result<void, HubError> {
  const full = win32.resolve(folder);
  const place = checkPlace(full, calls);
  if (place.isErr()) return err(place.error);
  const { root, flags } = place.value;
  if ((flags & FILE_PERSISTENT_ACLS) === 0) {
    const message = `the data folder's file system (${root}) keeps no access lists (FAT or exFAT?): any account could open the socket`;
    warn({
      code: "data_folder_was_open",
      message: `${message}; the hub cannot close it`,
      detail: { folder: full, closed: false, found: "no access lists" },
    });
    return err(refused(message, { folder: full, volume: root }));
  }
  const read = readList(full, calls);
  if (read.isErr()) return err(read.error);
  const problems = descriptorProblems(read.value, accounts, true);
  if (problems.length === 0) return ok(undefined);
  const found = problems.join("; ");
  const closed = closeFolder(full, calls, accounts, read.value);
  warn({
    code: "data_folder_was_open",
    message: closed.isOk()
      ? `the data folder was open (${found}): another account may have read the device keys; the hub set its list to ${WHO}`
      : `the data folder is open (${found}) and the hub could not close it: ${closed.error.message}`,
    detail: { folder: full, closed: closed.isOk(), found },
  });
  return closed.mapErr((error) =>
    refused(`the data folder's access list admits more than ${WHO}: ${found}; ${error.message}`, {
      folder: full,
      found,
    }),
  );
}

/** Step 5: after listening, the socket file is there and its own list passes the rule. */
export function checkSocketFile(
  path: string,
  calls: WindowsCalls,
  accounts: Accounts,
): Result<void, HubError> {
  const entry = calls.findEntry(path);
  if (entry.isErr()) return err(unreadable("the hub cannot look at its socket file", entry.error));
  if (entry.value === undefined)
    return err(
      refused(
        "listening left no socket file at the path (was it taken as a named pipe?), so its access cannot be checked",
        { path },
      ),
    );
  if (!isSocketFile(entry.value))
    return err(refused("what is at the socket's path is not an AF_UNIX socket file", { path }));
  const descriptor = calls.securityDescriptor(path);
  if (descriptor.isErr())
    return err(unreadable("the socket file's access list cannot be read", descriptor.error));
  return checkDescriptor(descriptor.value, accounts, false).mapErr((problems) =>
    refused(`the socket file's access list admits more than ${WHO}: ${problems.join("; ")}`, {
      path,
      found: problems.join("; "),
    }),
  );
}

const CALLER = { kind: "config", origin: ORIGIN } as const;

/** The steps on Windows; `warn` records `data_folder_was_open`. */
export function windowsSocketSteps(calls: WindowsCalls, warn: WarningSink): SocketSteps {
  return {
    prepare: (path) => {
      if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES)
        return errAsync(
          refused(`the socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes`, { path }),
        );
      const checked = accountsOf(calls).andThen((accounts) =>
        checkFolder(win32.dirname(path), calls, accounts, warn).andThen(() =>
          calls.findEntry(path),
        ),
      );
      if (checked.isErr()) return errAsync(checked.error);
      const entry = checked.value;
      if (entry === undefined) return okAsync(undefined);
      if (!isSocketFile(entry))
        return errAsync(
          refused("something that is not a socket is at the socket's path", { path }),
        );
      return hubAnswers(path).andThen((alive) =>
        alive
          ? errAsync(refused("another hub is running on this socket", { path }))
          : unlinkPath(CALLER, "cannot remove the old socket file", path),
      );
    },
    secure: (path) =>
      accountsOf(calls).andThen((accounts) => checkSocketFile(path, calls, accounts)),
    remove: (path) =>
      calls
        .findEntry(path)
        .mapErr((error) => unreadable("the hub cannot look at its socket file", error))
        .andThen((entry) =>
          entry !== undefined && isSocketFile(entry)
            ? unlinkPath(CALLER, "cannot remove the socket file", path)
            : ok(undefined),
        ),
  };
}

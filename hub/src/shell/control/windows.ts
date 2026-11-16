/**
 * The control socket on Windows (hub-design.md section 9; m2-design.md section 9, W2, "The
 * privilege boundary" and "The top folders"): an AF_UNIX socket, `control.sock` in the data
 * folder, opened only when each of the hub's top folders has exactly the shape `windows-acl.ts`
 * describes. Spike W2 showed the folder's list is the whole protection, and that `stat` of a
 * socket file fails there with EACCES, so nothing here reads POSIX modes or user ids; the Win32
 * calls are `shell/safe/control-socket-windows.ts`.
 *
 * **Who the hub runs as** decides what it may do (step 1):
 * - **the service**: its process's account is `NT SERVICE\HSNHub` (`HUB_SERVICE_SID`). It cannot
 *   change a top folder (it holds no `WRITE_DAC` or `WRITE_OWNER` there), so it makes what is
 *   inside inherit the top folder's list, as itself, and then only checks the top folder;
 * - **an administrator by hand**: any other account whose token holds Administrators enabled (an
 *   elevated prompt), or SYSTEM. It may set a top folder's shape, on the folder's handle alone,
 *   and never touches what is inside (no elevated step may, section 9). What it creates is owned
 *   by Administrators, never by the person;
 * - **anyone else** is refused: the hub must run as its service or from an administrator prompt.
 * The service is told apart by its account alone, which only the service manager can give a
 * process, so a run by hand never gets the service's treatment, and the service never gets an
 * administrator's.
 *
 * The steps, in order, each refusing with what it found:
 *
 * 1. **Who the hub runs as** (above).
 * 2. **Each top folder's place** (not made here: the installer makes them): it exists and is a
 *    folder; neither it nor any folder above it is a link (any reparse point), since a link can
 *    be pointed elsewhere after the check; it is on a local drive Windows can tell, whose file
 *    system keeps access lists.
 * 3. **As the service, what is inside**: walked without following anything, any link inside
 *    refused; each entry but an old socket file judged by `contentProblems`, and only an open one
 *    made to inherit the top folder's list and the service's own, then read back. An open item
 *    the service cannot close is refused with `data_folder_open`.
 * 4. **The top folder's list**, judged by `topFolderProblems`. A list that cannot be read is
 *    refused. One that is not the shape is **open**:
 *    - as the service: refused, with the warning `data_folder_open` (the installer's repair, or
 *      a reinstall, closes it);
 *    - as an administrator: the hub sets the shape (`topShape`) on the folder's handle, reads it
 *      back, checks the place again, and goes on, with the warning `data_folder_was_open`; or, if
 *      it cannot, is refused with that warning saying so.
 * 5. **The socket's path**: nothing there, or an AF_UNIX socket file that no hub answers on,
 *    which is removed. A running hub's socket, or anything else, is left and refused.
 * 6. **After listening**: an AF_UNIX socket file is at the path (a path taken as a named pipe
 *    leaves none), and its own list, inherited from the folder, passes `contentProblems`.
 */
import { win32 } from "node:path";
import { err, errAsync, ok, okAsync, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { FoundEntry, Volume, WindowsCalls } from "../safe/control-socket-windows.ts";
import { unlinkPath } from "../safe/fs.ts";
import { hubAnswers, MAX_SOCKET_PATH_BYTES } from "./socket-file.ts";
import type { SocketSteps } from "./socket-steps.ts";
import {
  ADMINISTRATORS_SID,
  checkContent,
  deniedAccounts,
  type Descriptor,
  EMPTY_ACL,
  HUB_SERVICE_SID,
  nameOf,
  parseDescriptor,
  parseSid,
  type RunMode,
  sidToBytes,
  SYSTEM_SID,
  topFolderProblems,
  topShape,
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
/** The most entries the hub looks through inside a top folder ‡. */
export const MAX_ENTRIES_CHECKED = 10_000;

/** The shape, as a person reads it in a refusal. */
const SHAPE =
  "owned by Administrators, Administrators and SYSTEM in full control, the hub's service account only adding to the folder and in full control of what is inside";

/**
 * The warnings about a top folder (m2-design.md section 9, "The top folders"):
 * `data_folder_open`, the service found it open and cannot close it; `data_folder_was_open`, an
 * administrator's run found it open and closed it (`closed`), or could not; `data_folder_denies`,
 * it denies the service account, Administrators or SYSTEM something, which the rule accepts but
 * which may stop the hub or the uninstaller later (FROZEN-CHANGE: a new `ShellWarningCode`).
 */
export interface ControlWarning {
  readonly code: "data_folder_open" | "data_folder_was_open" | "data_folder_denies";
  readonly message: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export type WarningSink = (warning: ControlWarning) => void;

/** What the Windows steps need besides the calls. */
export interface WindowsStepOptions {
  readonly warn: WarningSink;
  /** The service's account: `NT SERVICE\HSNHub` but in tests, which stand in another. */
  readonly service?: string;
  /** Top folders to check besides the data folder (the program folder, section 9). */
  readonly otherTopFolders?: readonly string[];
}

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

/** Step 1: whether the hub runs as its service or as an administrator by hand; else refused. */
export function runModeOf(calls: WindowsCalls, service: string): Result<RunMode, HubError> {
  const own = calls
    .processSid()
    .mapErr((error) => unreadable("the hub cannot tell which account it runs as", error))
    .andThen((bytes) =>
      parseSid(bytes, 0).mapErr((why) =>
        refused(`the hub cannot tell which account it runs as: ${why}`, {}),
      ),
    );
  if (own.isErr()) return err(own.error);
  const { sid } = own.value;
  if (sid === service) return ok("service");
  if (sid === SYSTEM_SID) return ok("administrator");
  return calls
    .isAdministrator()
    .mapErr((error) => unreadable("the hub cannot tell whether it runs elevated", error))
    .andThen((elevated) =>
      elevated
        ? ok<RunMode, HubError>("administrator")
        : err(
            refused(
              `the hub runs as ${sid}, which is neither its service account nor an elevated administrator: run it as the service, or by hand from an administrator prompt`,
              { account: sid },
            ),
          ),
    );
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
            ? `the folder ${full} does not exist: the installer makes it, with its access list`
            : `a folder above ${full} does not exist: ${at}`,
          { folder: full },
        ),
      );
    if (at === full && (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0)
      return err(refused(`${full} is not a folder`, { folder: full }));
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0)
      return err(
        refused(
          `${at === full ? full : `${at}, above ${full},`} is a link (a reparse point: a symbolic link, junction or mount point), which could be pointed elsewhere after the check`,
          { folder: full, link: at },
        ),
      );
  }
  const volume = calls.volume(full);
  if (volume.isErr())
    return err(unreadable(`the hub cannot read the volume of ${full}`, volume.error));
  const { root, driveType } = volume.value;
  if (driveType === DRIVE_REMOTE)
    return err(
      refused(`${full} is on a network drive (${root}), whose access list another computer keeps`, {
        folder: full,
        volume: root,
      }),
    );
  if (driveType === DRIVE_UNKNOWN || driveType === DRIVE_NO_ROOT_DIR)
    return err(
      refused(`the drive of ${full} (${root}) is of a kind the hub cannot tell`, {
        folder: full,
        volume: root,
        driveType,
      }),
    );
  return ok(volume.value);
}

/** The folder's descriptor, read and parsed; an error when it cannot be. */
function readTop(full: string, calls: WindowsCalls): Result<Descriptor, HubError> {
  const bytes = calls.securityDescriptor(full);
  if (bytes.isErr())
    return err(unreadable(`the access list of ${full} cannot be read`, bytes.error));
  return parseDescriptor(bytes.value).mapErr((why) =>
    refused(`the access list of ${full} cannot be read (${why})`, { folder: full }),
  );
}

/** Everything inside a top folder, parents before children; refused at the first link. */
function entriesInside(full: string, calls: WindowsCalls): Result<readonly string[], HubError> {
  const folders = [full];
  const found: string[] = [];
  for (let folder = folders.shift(); folder !== undefined; folder = folders.shift()) {
    const names = calls.list(folder);
    if (names.isErr()) return err(unreadable(`the hub cannot list ${folder}`, names.error));
    for (const name of names.value) {
      const child = win32.join(folder, name);
      if (found.length >= MAX_ENTRIES_CHECKED)
        return err(
          refused(`${full} holds more than ${MAX_ENTRIES_CHECKED} entries to check`, {
            folder: full,
          }),
        );
      const looked = calls.attributes(child);
      if (looked.isErr()) return err(unreadable(`the hub cannot look at ${child}`, looked.error));
      const attributes = looked.value;
      if (attributes === undefined) continue;
      if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        const entry = calls.findEntry(child);
        if (entry.isErr()) return err(unreadable(`the hub cannot look at ${child}`, entry.error));
        // An old socket file is the hub's own and is replaced, not changed.
        if (entry.value !== undefined && isSocketFile(entry.value)) continue;
        return err(
          refused(`${child}, inside ${full}, is a link, which the hub does not follow or change`, {
            folder: full,
            link: child,
          }),
        );
      }
      found.push(child);
      if ((attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0) folders.push(child);
    }
  }
  return ok(found);
}

/** Step 3, as the service: what is inside made to inherit the top folder's list, and read back. */
function tightenInside(full: string, calls: WindowsCalls, service: string): Result<void, HubError> {
  // As the service, what is inside becomes its own: the service's SID, which it is.
  const owner = sidToBytes(service).mapErr((why) => refused(why, { folder: full }));
  const judged = (entry: string): Result<readonly string[], HubError> =>
    calls
      .securityDescriptor(entry)
      .mapErr((error) => unreadable(`the access list of ${entry} cannot be read`, error))
      .map((bytes) =>
        checkContent(bytes, service).match(
          () => [],
          (problems) => problems,
        ),
      );
  return entriesInside(full, calls).andThen((entries) => {
    // Parents before children: a parent changed passes its list on, and each item is judged as
    // it is when its turn comes. Only an item that is open is changed; one made by another
    // allowed account (Administrators, SYSTEM) that admits nobody else is left as it is, though
    // the service could not change it (run 43872833188: WinSW's `logs`).
    for (const entry of entries) {
      const before = judged(entry);
      if (before.isErr()) return err(before.error);
      if (before.value.length === 0) continue;
      const found = before.value.join("; ");
      const set = owner.andThen((sid) => calls.inheritFromParent(entry, EMPTY_ACL, sid));
      if (set.isErr())
        return err(
          refused(
            `${entry} is open (${found}) and the hub could not close it: ${set.error.message}`,
            {
              folder: full,
              entry,
              found,
            },
          ),
        );
      const after = judged(entry);
      if (after.isErr()) return err(after.error);
      if (after.value.length > 0)
        return err(
          refused(`${entry} reads back open: ${after.value.join("; ")}`, {
            folder: full,
            entry,
            found: after.value.join("; "),
          }),
        );
    }
    return ok(undefined);
  });
}

/** Step 4, as an administrator: the shape set on the folder's handle, read back and checked. */
function setShape(full: string, calls: WindowsCalls, service: string): Result<void, HubError> {
  return topShape(service)
    .mapErr((why) => refused(`the hub cannot write the shape: ${why}`, { folder: full }))
    .andThen((shape) =>
      calls
        .setTopShape(full, shape)
        .mapErr((error) => unreadable("the hub could not set the shape", error)),
    )
    .andThen(() => checkPlace(full, calls))
    .andThen(() => readTop(full, calls))
    .andThen((after) => {
      const still = topFolderProblems(after, service, "service");
      return still.length === 0
        ? ok(undefined)
        : err(
            refused(`the shape the hub set reads back otherwise: ${still.join("; ")}`, {
              folder: full,
              found: still.join("; "),
            }),
          );
    });
}

/** Steps 2 to 4 for one top folder. */
export function checkTopFolderAt(
  folder: string,
  calls: WindowsCalls,
  service: string,
  mode: RunMode,
  warn: WarningSink,
): Result<void, HubError> {
  const full = win32.resolve(folder);
  const place = checkPlace(full, calls);
  if (place.isErr()) return err(place.error);
  const { root, flags } = place.value;
  if ((flags & FILE_PERSISTENT_ACLS) === 0) {
    const message = `the file system of ${full} (${root}) keeps no access lists (FAT or exFAT?): any account could open the socket`;
    warn({
      code: mode === "service" ? "data_folder_open" : "data_folder_was_open",
      message: `${message}; the hub cannot close it`,
      detail: { folder: full, closed: false, found: "no access lists" },
    });
    return err(refused(message, { folder: full, volume: root }));
  }
  const inside = mode === "service" ? tightenInside(full, calls, service) : ok(undefined);
  const read = readTop(full, calls);
  if (read.isErr()) return err(read.error);
  const problems = topFolderProblems(read.value, service, mode);
  const denied = deniedAccounts(read.value, service);
  const warnDenied = (): void => {
    if (denied.length === 0) return;
    const names = denied.map((sid) => nameOf(sid, service)).join(", ");
    warn({
      code: "data_folder_denies",
      message: `${full} has deny entries for ${names}: the hub accepts them, but they may stop the hub, or the uninstaller, later; the installer's repair replaces the list`,
      detail: { folder: full, denied: denied.join(", ") },
    });
  };
  if (problems.length === 0) {
    warnDenied();
    if (inside.isOk()) return ok(undefined);
    warn({
      code: "data_folder_open",
      message: `what is inside ${full} could not be closed: ${inside.error.message}`,
      detail: { folder: full, closed: false, found: inside.error.message },
    });
    return err(inside.error);
  }
  const found = problems.join("; ");
  if (mode === "service") {
    warnDenied();
    warn({
      code: "data_folder_open",
      message: `the access list of ${full} is open (${found}); reinstall, or run the installer's repair, to close it`,
      detail: { folder: full, closed: false, found },
    });
    return err(
      refused(
        `the access list of ${full} is not the hub's (${SHAPE}): ${found}; the service cannot change it: reinstall, or run the installer's repair`,
        { folder: full, found },
      ),
    );
  }
  const closed = setShape(full, calls, service);
  if (closed.isErr()) warnDenied();
  warn({
    code: "data_folder_was_open",
    message: closed.isOk()
      ? `${full} was open (${found}): another account may have read the device keys. The hub set the folder's own owner and list to the installer's, and nothing inside it: the files already in ${full} keep their old lists until the hub next starts as its service, and until then hub.db may be readable by other accounts`
      : `${full} is open (${found}) and the hub could not close it: ${closed.error.message}`,
    detail: { folder: full, closed: closed.isOk(), found, insideUntouched: true },
  });
  return closed.mapErr((error) =>
    refused(`the access list of ${full} is not the hub's (${SHAPE}): ${found}; ${error.message}`, {
      folder: full,
      found,
    }),
  );
}

/**
 * Before anything is made in a top folder (`main.ts`, before the storage opens): on an
 * administrator's run, a top folder that does not exist yet is made with the shape from its first
 * moment (`CreateDirectoryW` with the descriptor), so all the hub then makes inside inherits it;
 * its parent must exist, with no link on the way, on a local drive with access lists. As the
 * service nothing is made (the installer makes the folders). "made", or "there" when something
 * already is (it is then judged, as always, when the socket opens).
 */
export function createTopFolderIfMissing(
  folder: string,
  calls: WindowsCalls,
  service: string = HUB_SERVICE_SID,
): Result<"made" | "there", HubError> {
  const full = win32.resolve(folder);
  const found = calls.attributes(full);
  if (found.isErr()) return err(unreadable(`the hub cannot look at ${full}`, found.error));
  if (found.value !== undefined) return ok("there");
  return runModeOf(calls, service).andThen((mode) => {
    if (mode === "service") return ok<"made" | "there", HubError>("there");
    const parent = win32.dirname(full);
    return checkPlace(parent, calls)
      .andThen(({ root, flags }) =>
        (flags & FILE_PERSISTENT_ACLS) === 0
          ? err(
              refused(`the file system of ${full} (${root}) keeps no access lists`, {
                folder: full,
              }),
            )
          : ok(undefined),
      )
      .andThen(() =>
        topShape(service).mapErr((why) => refused(`the hub cannot write the shape: ${why}`, {})),
      )
      .andThen((shape) =>
        calls
          .createFolder(full, shape)
          .mapErr((error) => unreadable(`the hub cannot make ${full}`, error)),
      )
      .andThen((made) =>
        made
          ? checkPlace(full, calls)
              .andThen(() => readTop(full, calls))
              .andThen((after) => {
                const problems = topFolderProblems(after, service, "service");
                return problems.length === 0
                  ? ok<"made" | "there", HubError>("made")
                  : err(
                      refused(`${full} was made otherwise: ${problems.join("; ")}`, {
                        folder: full,
                      }),
                    );
              })
          : ok<"made" | "there", HubError>("there"),
      );
  });
}

/** Step 6: after listening, the socket file is there and its own list passes the rule. */
export function checkSocketFile(
  path: string,
  calls: WindowsCalls,
  service: string,
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
  return checkContent(descriptor.value, service).mapErr((problems) =>
    refused(
      `the socket file's access list admits more than Administrators, SYSTEM and the hub's service account: ${problems.join("; ")}`,
      { path, found: problems.join("; ") },
    ),
  );
}

const CALLER = { kind: "config", origin: ORIGIN } as const;

/** The steps on Windows. */
export function windowsSocketSteps(calls: WindowsCalls, options: WindowsStepOptions): SocketSteps {
  const service = options.service ?? HUB_SERVICE_SID;
  return {
    prepare: (path) => {
      if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES)
        return errAsync(
          refused(`the socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes`, { path }),
        );
      const checked = runModeOf(calls, service)
        .andThen((mode) =>
          mode === "administrator"
            ? sidToBytes(ADMINISTRATORS_SID)
                .mapErr((why) => refused(why, {}))
                .andThen((sid) =>
                  calls
                    .defaultOwnerAdministrators(sid)
                    .mapErr((error) =>
                      unreadable("the hub cannot make what it creates Administrators'", error),
                    ),
                )
                .map(() => mode)
            : ok<RunMode, HubError>(mode),
        )
        .andThen((mode) => {
          for (const top of [win32.dirname(path), ...(options.otherTopFolders ?? [])]) {
            const one = checkTopFolderAt(top, calls, service, mode, options.warn);
            if (one.isErr()) return err(one.error);
          }
          return calls.findEntry(path);
        });
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
    secure: (path) => checkSocketFile(path, calls, service),
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

/**
 * The files a person names to `hsn` (m2-design.md section 9, "The privilege boundary", "Files a
 * person names to `hsn`"): `hsn update install <file>` and `hsn restore <file>` read one, `hsn
 * backup export <file>` writes one. Each is opened without following a link in its last part:
 * read with `O_RDONLY | O_NOFOLLOW`; written to a temporary file beside the target, created with
 * `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` and mode 0600, renamed over the target only once the
 * stream's SHA-256 matches, and removed otherwise.
 *
 * Who opens it is the caller's choice (`hsn.ts`): as the running account when `hsn` is not root;
 * under `sudo`, a helper started as the invoking user (`file-helper.ts`) that streams through a
 * pipe; as root without `sudo`, only in a folder `rootMayUse` allows.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { err, Result } from "neverthrow";

/** How a named file is read and written: directly, or through the invoking user's helper. */
export interface NamedFiles {
  read(path: string): Promise<Result<Uint8Array, string>>;
  /**
   * Writes `bytes` to `path`, but only if they hash to `sha256` (lowercase hex); `warn` prints a
   * line the person should see while the write goes on (Windows: D124's export warning).
   */
  write(
    path: string,
    bytes: Uint8Array,
    sha256: string,
    warn?: (line: string) => void,
  ): Promise<Result<void, string>>;
}

const message = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown);

const NO_FOLLOW = constants.O_NOFOLLOW;

/** `call()`, or its error's message. */
function attempt<T>(call: () => T): Result<T, string> {
  return Result.fromThrowable(call, message)();
}

/** The whole file, opened without following a link in its last part. */
export function readNoFollow(path: string): Result<Uint8Array, string> {
  return attempt(() => openSync(path, constants.O_RDONLY | NO_FOLLOW))
    .andThen((fd) => {
      const read = attempt(() => new Uint8Array(readFileSync(fd)));
      const closed = attempt(() => {
        closeSync(fd);
      });
      return read.andThen((bytes) => closed.map(() => bytes));
    })
    .mapErr((why) => `cannot read the file ${path}: ${why}`);
}

/**
 * Writes `bytes` to `path` through a temporary file created exclusively beside it, mode 0600,
 * never following a link; renamed over `path` once the bytes hash to `sha256`, removed otherwise.
 */
export function writeExclusively(
  path: string,
  bytes: Uint8Array,
  sha256: string,
): Result<void, string> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== sha256) return err("the file's hash is not the one the hub sent: nothing was saved");
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.part`,
  );
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
  const placed = attempt(() => openSync(temporary, flags, 0o600)).andThen((fd) => {
    const wrote = attempt(() => {
      let at = 0;
      while (at < bytes.length) at += writeSync(fd, bytes, at);
      fsyncSync(fd);
    });
    const closed = attempt(() => {
      closeSync(fd);
    });
    return wrote
      .andThen(() => closed)
      .andThen(() =>
        attempt(() => {
          renameSync(temporary, path);
        }),
      );
  });
  if (placed.isErr())
    attempt(() => {
      rmSync(temporary, { force: true });
    }).unwrapOr(undefined);
  return placed.mapErr((why) => `cannot write the file ${path}: ${why}`);
}

/** The files as the running account opens them (`hsn` not root). */
export const directFiles: NamedFiles = {
  read: (path) => Promise.resolve(readNoFollow(path)),
  write: (path, bytes, sha256) => Promise.resolve(writeExclusively(path, bytes, sha256)),
};

/** The folders root may never use for a person's file: the hub's trees (section 9). */
export interface HubTrees {
  readonly data: string;
  readonly program: string;
}

/** Whether `child` is `parent` or inside it, by path. */
function within(child: string, parent: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

/**
 * Run as root without `sudo`, the invoking user is root (section 9): a file is read, or written,
 * only in a folder that is root's and that no other account can write, and under no hub tree.
 * The problem with `path`'s folder, or undefined when root may use it.
 */
export function rootMayUse(
  path: string,
  trees: HubTrees,
  folderStat: (folder: string) => Stats | undefined = (folder) =>
    Result.fromThrowable(
      () => lstatSync(folder),
      () => undefined,
    )().unwrapOr(undefined),
): string | undefined {
  const folder = dirname(resolve(path));
  if (within(folder, trees.data) || within(folder, trees.program))
    return `${path} is in the hub's own folders`;
  const stats = folderStat(folder);
  if (stats?.isDirectory() !== true) return `${folder} is not a folder`;
  if (stats.uid !== 0) return `${folder} is not root's`;
  if ((stats.mode & 0o022) !== 0) return `${folder} can be written by another account`;
  return undefined;
}

/** `directFiles`, as root without `sudo`: only in folders `rootMayUse` allows. */
export function rootFiles(trees: HubTrees): NamedFiles {
  const refused = (path: string): string | undefined => {
    const problem = rootMayUse(path, trees);
    return problem === undefined
      ? undefined
      : `${problem}: run hsn through sudo as yourself, so the file is opened with your own rights`;
  };
  return {
    read: (path) => {
      const problem = refused(path);
      return Promise.resolve(problem === undefined ? readNoFollow(path) : err(problem));
    },
    write: (path, bytes, sha256) => {
      const problem = refused(path);
      return Promise.resolve(
        problem === undefined ? writeExclusively(path, bytes, sha256) : err(problem),
      );
    },
  };
}

/**
 * `node:fs` behind results, for the push role: the publisher's key files, which are read once at
 * start, and the local socket's file.
 *
 * The keys (docs/m4-design.md section 3, "The operator's keys") live "only on the push service's
 * host, in files readable only by the push role's own account, outside the program's folder". So
 * a key file is refused when it is not a regular file, when its group or others may read or write
 * it, when another account owns it, or when it lies inside the program's own folder (the
 * repository, or the folder of a compiled program). Its text is returned and never logged.
 */
import { chmodSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { sep } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { type PushError, pushError } from "../errors.ts";
import { errorFrom, thrownCode } from "./thrown.ts";

const ORIGIN = "push/safe/fs";

/** Whether `inner` is `outer` or inside it. Both real paths. */
function inside(inner: string, outer: string): boolean {
  const base = outer.endsWith(sep) ? outer : `${outer}${sep}`;
  return inner === outer || inner.startsWith(base);
}

/** The folder a path's real path is checked against, as given by the caller. */
export interface SecretFileRules {
  /** The program's own folder: no key may be read from inside it. */
  readonly programFolder: string;
  /** The account the push role runs as; undefined where the system has none (Windows). */
  readonly uid: number | undefined;
}

/**
 * Reads a key or credential file, refusing one others may read, one another account owns, and
 * one inside the program's folder. `what` names it in an error ("the APNs key").
 */
export function readSecretFile(
  path: string,
  what: string,
  rules: SecretFileRules,
): Result<string, PushError> {
  try {
    const real = realpathSync(path);
    const program = realpathSync(rules.programFolder);
    if (inside(real, program)) {
      return err(
        pushError("credentials", ORIGIN, `${what} is inside the program's folder; keep it outside`),
      );
    }
    const stats = statSync(real);
    if (!stats.isFile()) return err(pushError("credentials", ORIGIN, `${what} is not a file`));
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      return err(
        pushError("credentials", ORIGIN, `${what} may be read by others; make it 0600`, {
          mode: (stats.mode & 0o777).toString(8),
        }),
      );
    }
    if (rules.uid !== undefined && stats.uid !== rules.uid) {
      return err(pushError("credentials", ORIGIN, `${what} belongs to another account`));
    }
    return ok(readFileSync(real, "utf8"));
  } catch (thrown) {
    return err(errorFrom("credentials", ORIGIN, `read ${what}`, thrown, "codeOnly"));
  }
}

/** Reads a file that holds no secret (a certificate, the list of refused relay keys). */
export function readPlainFile(path: string, what: string): Result<string, PushError> {
  try {
    return ok(readFileSync(path, "utf8"));
  } catch (thrown) {
    return err(errorFrom("config", ORIGIN, `read ${what}`, thrown, "withMessage"));
  }
}

/** Removes a socket file left by an earlier run; refuses to remove anything but a socket. */
export function removeStaleSocket(path: string): Result<void, PushError> {
  try {
    const stats = lstatSync(path);
    if (!stats.isSocket()) {
      return err(
        pushError("config", ORIGIN, "the socket's path holds something other than a socket"),
      );
    }
    rmSync(path);
    return ok(undefined);
  } catch (thrown) {
    if (thrownCode(thrown) === "ENOENT") return ok(undefined);
    return err(errorFrom("config", ORIGIN, "remove the old socket", thrown, "withMessage"));
  }
}

/** Sets a file's mode: the local socket's, so only the relay's account can open it. */
export function setMode(path: string, mode: number): Result<void, PushError> {
  try {
    chmodSync(path, mode);
    return ok(undefined);
  } catch (thrown) {
    return err(errorFrom("config", ORIGIN, "set the socket's mode", thrown, "withMessage"));
  }
}

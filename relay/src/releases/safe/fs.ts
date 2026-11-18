/**
 * The release folder's files behind results (docs/m4-design.md section 6): listing, a file's
 * head, its SHA-256, a range of it, and writing a file fetched from upstream piece by piece.
 * Every `try` of `relay/src/releases/` is here. Errors keep a library's code only.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { err, ok, type Result } from "neverthrow";
import { relayError, type RelayError } from "../../shell/errors.ts";
import { errorFrom } from "../../shell/safe/thrown.ts";

const ORIGIN = "releases/safe/fs";

function attempt<T>(what: string, run: () => T): Result<T, RelayError> {
  try {
    return ok(run());
  } catch (thrown) {
    return err(errorFrom("releases", ORIGIN, what, thrown));
  }
}

/** A file's size and change time. */
export interface FileFacts {
  readonly bytes: number;
  readonly changedMs: number;
}

/** The names in a folder (files only); the folder is made if it is missing. */
export function listFiles(folder: string): Result<readonly string[], RelayError> {
  return attempt("list the release folder", () => {
    mkdirSync(folder, { recursive: true });
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  });
}

export function fileFacts(path: string): Result<FileFacts, RelayError> {
  return attempt("read a release file's size", () => {
    const facts = statSync(path);
    return { bytes: facts.size, changedMs: facts.mtimeMs };
  });
}

/** Exactly `length` bytes at `offset`, or an error (`short` when the file ends first). */
export function readRange(
  path: string,
  offset: number,
  length: number,
): Result<Uint8Array, RelayError | "short"> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const out = new Uint8Array(length);
    let have = 0;
    while (have < length) {
      const n = readSync(fd, out, have, length - have, offset + have);
      if (n === 0) return err("short");
      have += n;
    }
    return ok(out);
  } catch (thrown) {
    return err(errorFrom("releases", ORIGIN, "read a release file", thrown));
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a file only read: nothing is lost.
      }
    }
  }
}

/**
 * The SHA-256 of a whole file, read in pieces of `pieceBytes` with an `await` between pieces, so
 * hashing a large release never holds the relay's one thread for more than one piece's time:
 * hub links and phone streams are served between pieces.
 */
export async function sha256FileInPieces(
  path: string,
  pieceBytes: number,
): Promise<Result<string, RelayError>> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    const hash = createHash("sha256");
    const buffer = new Uint8Array(pieceBytes);
    let at = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, pieceBytes, at);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
    return ok(hash.digest("hex"));
  } catch (thrown) {
    return err(errorFrom("releases", ORIGIN, "hash a release file", thrown));
  } finally {
    try {
      await file?.close();
    } catch {
      // A file only read: nothing is lost.
    }
  }
}

/** Writes `bytes` at `offset` of `path`, making it if missing. */
export function writeAt(path: string, offset: number, bytes: Uint8Array): Result<void, RelayError> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "a+");
    closeSync(fd);
    fd = openSync(path, "r+");
    let done = 0;
    while (done < bytes.length) {
      done += writeSync(fd, bytes, done, bytes.length - done, offset + done);
    }
    return ok(undefined);
  } catch (thrown) {
    return err(errorFrom("releases", ORIGIN, "write a fetched piece", thrown));
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The write's own error, if any, is the one reported.
      }
    }
  }
}

/** Cuts `path` to `bytes` long (a partial file whose tail is not trusted). */
export function truncate(path: string, bytes: number): Result<void, RelayError> {
  return attempt("cut a partial file", () => {
    const fd = openSync(path, "r+");
    try {
      ftruncateSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  });
}

export function rename(from: string, to: string): Result<void, RelayError> {
  return attempt("move a fetched file into place", () => {
    renameSync(from, to);
  });
}

export function remove(path: string): Result<void, RelayError> {
  return attempt("remove a file", () => {
    unlinkSync(path);
  });
}

/** A file's size, or 0 when it does not exist. */
export function sizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** For callers that need a fixed error. */
export const notAFile = (what: string): RelayError => relayError("releases", ORIGIN, what);

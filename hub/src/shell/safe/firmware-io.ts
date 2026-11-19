/**
 * The firmware store's throwing calls behind results (hub-design.md section 10;
 * docs/m3-updates-design.md sections 3 and 4): `node:fs` for the store's folder and its files,
 * the upload being staged and the pieces served to devices, and `node:crypto` for the publisher's
 * Ed25519 signature, a SHA-256, and the hub's P-256 private scalar read out of its PKCS #8 form.
 *
 * Every failure says which of `FileOutcome`'s reasons it is, as the backup's file work does: a
 * full disk is `full`, a file or folder that is not there or not ours `unreachable`, anything else
 * `io`; `code` keeps the system's own code (`ENOENT`), so a caller can tell a missing file.
 *
 * The private scalar is returned and never put in an error's message.
 */
import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { err, ok, type Result } from "neverthrow";
import type { FileFailure } from "../../core/model/events.ts";
import { thrownCode } from "./thrown.ts";

/** A file call that failed: the reason the core is given, the message, the system's code. */
export interface IoError {
  readonly reason: FileFailure;
  readonly message: string;
  readonly code?: string;
}

const FULL = new Set(["ENOSPC", "EDQUOT", "EFBIG"]);
const UNREACHABLE = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EROFS", "ENODEV", "EIO"]);

function ioError(what: string, thrown: unknown): IoError {
  const code = thrownCode(thrown);
  const reason: FileFailure =
    code !== undefined && FULL.has(code)
      ? "full"
      : code !== undefined && UNREACHABLE.has(code)
        ? "unreachable"
        : "io";
  const why = thrown instanceof Error ? thrown.message : String(thrown);
  return code === undefined
    ? { reason, message: `${what}: ${why}` }
    : { reason, message: `${what}: ${why}`, code };
}

function attempt<T>(what: string, run: () => T): Result<T, IoError> {
  try {
    return ok(run());
  } catch (thrown) {
    return err(ioError(what, thrown));
  }
}

/** A folder and its parents, the hub account's alone. */
export function ensureFolder(path: string): Result<void, IoError> {
  return attempt(`make ${path}`, () => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  });
}

/** A folder's names; a folder that is not there has none. */
export function namesIn(path: string): Result<readonly string[], IoError> {
  try {
    return ok(readdirSync(path));
  } catch (thrown) {
    if (thrownCode(thrown) === "ENOENT") return ok([]);
    return err(ioError(`list ${path}`, thrown));
  }
}

/** A file's size, or undefined when there is none at the path. */
export function sizeOf(path: string): Result<number | undefined, IoError> {
  try {
    return ok(statSync(path, { throwIfNoEntry: false })?.size);
  } catch (thrown) {
    return err(ioError(`stat ${path}`, thrown));
  }
}

/** Opens a file to read. */
export function openToRead(path: string): Result<number, IoError> {
  return attempt(`open ${path}`, () => openSync(path, "r"));
}

/** Creates a new file to write, the hub account's alone; one already there is an error. */
export function openNew(path: string): Result<number, IoError> {
  return attempt(`create ${path}`, () => openSync(path, "wx", 0o600));
}

/** An open file's size. */
export function sizeOfOpen(fd: number, what: string): Result<number, IoError> {
  return attempt(`stat ${what}`, () => fstatSync(fd).size);
}

/**
 * Fills `into` from `position` with as many reads as it takes; fewer bytes than asked when the
 * file ends first (the count read is returned).
 */
export function readAt(
  fd: number,
  into: Uint8Array,
  position: number,
  what: string,
): Result<number, IoError> {
  return attempt(`read ${what}`, () => {
    let got = 0;
    while (got < into.length) {
      const n = readSync(fd, into, got, into.length - got, position + got);
      if (n === 0) break;
      got += n;
    }
    return got;
  });
}

/** Writes every byte. */
export function writeAll(fd: number, bytes: Uint8Array, what: string): Result<void, IoError> {
  return attempt(`write ${what}`, () => {
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
  });
}

/** An open file's contents to disk. */
export function syncOpen(fd: number, what: string): Result<void, IoError> {
  return attempt(`sync ${what}`, () => {
    fsyncSync(fd);
  });
}

/** Closes a file; a failure to close is let go (nothing more can be done with it). */
export function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed, or the system lost it: there is nothing to release.
  }
}

export function renameFile(from: string, to: string): Result<void, IoError> {
  return attempt(`rename ${from}`, () => {
    renameSync(from, to);
  });
}

/** Removes a file if it is there. */
export function removeFile(path: string): Result<void, IoError> {
  return attempt(`remove ${path}`, () => {
    rmSync(path, { force: true });
  });
}

/** Removes a file if it is there; a failure is let go (a temporary file after a failure). */
export function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // What could not be removed is found again by the store's check at the next start.
  }
}

/** Syncs a folder, so a rename or removal in it survives a power cut (POSIX; Windows has none). */
export function syncFolder(path: string): Result<void, IoError> {
  if (process.platform === "win32") return ok(undefined);
  return attempt(`sync ${path}`, () => {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}

/**
 * The SHA-256 of a whole file, read in one call: only at the store's check at start, before the
 * hub listens (m2-design.md section 3: work done before the hub listens blocks nobody).
 */
export function sha256OfFile(path: string): Result<Uint8Array, IoError> {
  return attempt(`hash ${path}`, () => {
    const hash = createHash("sha256");
    const fd = openSync(path, "r");
    try {
      const piece = new Uint8Array(256 * 1024);
      for (let at = 0; ;) {
        const n = readSync(fd, piece, 0, piece.length, at);
        if (n === 0) break;
        hash.update(piece.subarray(0, n));
        at += n;
      }
    } finally {
      closeSync(fd);
    }
    return new Uint8Array(hash.digest());
  });
}

/** Whether `key` (a raw 32-byte Ed25519 public key) signed `message`; a key that is not one, no. */
export function ed25519Verifies(
  message: Uint8Array,
  signature: Uint8Array,
  key: Uint8Array,
): boolean {
  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key).toString("base64url") },
      format: "jwk",
    });
    return verify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * The 32-byte private scalar of the hub's P-256 key, from its PKCS #8 form (`hub_keys`), for the
 * image header's deterministic signature (m3-updates-design section 3). Never in an error.
 */
export function p256ScalarOf(pkcs8: Uint8Array): Result<Uint8Array, string> {
  try {
    const jwk = createPrivateKey({
      key: Buffer.from(pkcs8),
      format: "der",
      type: "pkcs8",
    }).export({ format: "jwk" });
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string")
      return err("the hub's signing key is not a P-256 key");
    const scalar = new Uint8Array(Buffer.from(jwk.d, "base64url"));
    return scalar.length === 32 ? ok(scalar) : err("the hub's signing key is not 32 bytes");
  } catch {
    return err("the hub's signing key could not be read");
  }
}

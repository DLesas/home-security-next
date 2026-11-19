/**
 * `node:fs` behind results, for the relay's shell: its configuration, its data folder and its own
 * static key file. Errors keep a library's code only (`thrown.ts`).
 */
import {
  chmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
  closeSync,
} from "node:fs";
import type { Result } from "neverthrow";
import type { RelayError } from "../errors.ts";
import { attempt } from "./attempt.ts";

const ORIGIN = "shell/safe/fs";

export function readText(path: string, what: string): Result<string, RelayError> {
  return attempt("config", ORIGIN, `read ${what}`, () => readFileSync(path, "utf8"));
}

export function readBytes(path: string, what: string): Result<Uint8Array, RelayError> {
  return attempt("config", ORIGIN, `read ${what}`, () => new Uint8Array(readFileSync(path)));
}

/** The folder, made with mode 0700 if missing. */
export function makeFolder(path: string): Result<void, RelayError> {
  return attempt("config", ORIGIN, "make the data folder", () => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  });
}

/** Whether a file exists. */
export function exists(path: string): boolean {
  return attempt("config", ORIGIN, "look for a file", () => statSync(path).isFile()).unwrapOr(
    false,
  );
}

/** A file's permission bits. */
export function modeOf(path: string): Result<number, RelayError> {
  return attempt("config", ORIGIN, "read a file's mode", () => statSync(path).mode & 0o777);
}

/** Writes a new file readable only by this account (0600); refuses if it exists. */
export function writeSecretFile(path: string, bytes: Uint8Array): Result<void, RelayError> {
  return attempt("crypto", ORIGIN, "write the relay's key", () => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    if (process.platform !== "win32") chmodSync(path, 0o600);
  });
}

/**
 * The upload store's file calls behind results (hub-design.md section 10; m2-design.md section
 * 6): an upload's temporary file in the data folder's `uploads/`, created new and readable only by
 * the hub's account, written chunk by chunk and closed. Uploads are deleted at every start, so they
 * are not synced: a power cut loses one, and the client uploads it again. Owner A2.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { errorFrom } from "./thrown.ts";

const ORIGIN = "shell/safe/upload-files";

/** Creates `path`, which must not exist, for writing; its descriptor. */
export function createUploadFile(path: string): Result<number, HubError> {
  try {
    return ok(openSync(path, "wx", 0o600));
  } catch (thrown) {
    return err(errorFrom("storage", ORIGIN, "create an upload file", thrown));
  }
}

/** Writes all of `bytes` at the end of the file. */
export function writeUploadFile(fd: number, bytes: Uint8Array): Result<void, HubError> {
  try {
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    return ok(undefined);
  } catch (thrown) {
    return err(errorFrom("storage", ORIGIN, "write an upload file", thrown));
  }
}

/** Closes the descriptor. */
export function closeUploadFile(fd: number): Result<void, HubError> {
  try {
    closeSync(fd);
    return ok(undefined);
  } catch (thrown) {
    return err(errorFrom("storage", ORIGIN, "close an upload file", thrown));
  }
}

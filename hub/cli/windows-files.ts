/**
 * `hsn.exe` run elevated on Windows (m2-design.md section 9, "The privilege boundary"): an
 * administrator cannot become the service's virtual account, so `hsn` stays the administrator
 * and keeps to the rules that make that safe, through A11's Win32 calls
 * (`shell/safe/control-socket-hsn.ts`):
 *
 * - **Elevated or not** (`isStrict`): elevated, or Windows will not say (`cannotTell`), takes the
 *   stricter path: fixed paths (`C:\ProgramData\HSN Hub`), the environment ignored, `C:\`.
 * - **A file the person names** (`windowsFiles`): read by its handle, refusing a reparse point in
 *   its last part, a path inside a hub tree, or anything that is not a file; an export written as
 *   a new temporary file and renamed over the target only once `hsn`'s own hash check passed,
 *   abandoned on every other path. A folder the service account could also write is not refused
 *   (D124): A11's one warning line is printed and the export goes on. Each refusal says what to
 *   do; every line goes through the guarded io (`main.ts`).
 */
import { createHash } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import type { NamedFiles } from "./named-files.ts";
import { WINDOWS_DATA_FOLDER } from "./paths.ts";
import type {
  Elevation,
  ExportFile,
  NamedFileReader,
  NamedFileRefusal,
} from "../src/shell/safe/control-socket-hsn.ts";

/** The service's folders at their fixed paths: the hub's trees, never a person's file. */
export const WINDOWS_FIXED = {
  data: WINDOWS_DATA_FOLDER,
  program: "C:\\ProgramData\\HSN Hub Program",
} as const;

/** Elevated, or Windows will not say: the stricter rules (A11's ruling). */
export function isStrict(elevation: Elevation): boolean {
  return elevation.kind !== "notElevated";
}

/** The environment `hsn.exe` uses elevated: the fixed data folder and the actor's name only. */
export function windowsElevatedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return { HSN_DATA_DIR: WINDOWS_FIXED.data, USER: env.USERNAME ?? "administrator" };
}

/** What each refusal tells the person to do. */
export function refusalMessage(refusal: NamedFileRefusal, path: string): string {
  switch (refusal.kind) {
    case "reparsePoint":
      return `${path} is a link or junction, which hsn never follows: name the file itself`;
    case "insideHubTree":
      return `${path} is inside the hub's own folders: choose a file of your own`;
    case "notAFile":
      return `${path} is not a file: name a file`;
    case "failed":
      return `${path} could not be opened: ${refusal.message}`;
  }
}

/** A11's calls, given by `hsn.ts`; tests give their own. */
export interface WindowsFileCalls {
  readonly open: (
    path: string,
    hubTrees: readonly string[],
  ) => Result<NamedFileReader, NamedFileRefusal>;
  readonly begin: (
    target: string,
    hubTrees: readonly string[],
  ) => Result<ExportFile, NamedFileRefusal>;
}

const READ_PIECE = 256 * 1024;

/** `NamedFiles` for an elevated `hsn.exe`: by the handle, inside no hub tree. */
export function windowsFiles(
  calls: WindowsFileCalls,
  hubTrees: readonly string[] = [WINDOWS_FIXED.data, WINDOWS_FIXED.program],
): NamedFiles {
  return {
    read: (path) => {
      const opened = calls.open(path, hubTrees);
      if (opened.isErr()) return Promise.resolve(err(refusalMessage(opened.error, path)));
      const reader = opened.value;
      const parts: Uint8Array[] = [];
      for (;;) {
        const piece = new Uint8Array(READ_PIECE);
        const read = reader.read(piece);
        if (read.isErr()) {
          reader.close();
          return Promise.resolve(err(`${path} could not be read: ${read.error.message}`));
        }
        if (read.value === 0) break;
        parts.push(piece.subarray(0, read.value));
      }
      reader.close();
      return Promise.resolve(ok(new Uint8Array(Buffer.concat(parts))));
    },
    write: (path, bytes, sha256, warn) => {
      const begun = calls.begin(path, hubTrees);
      if (begun.isErr()) return Promise.resolve(err(refusalMessage(begun.error, path)));
      const file = begun.value;
      if (file.warning !== undefined) warn?.(file.warning);
      const written = file.write(bytes);
      // `hsn`'s own hash check, before anything is put in place.
      const whole = createHash("sha256").update(bytes).digest("hex") === sha256;
      if (written.isErr() || !whole) {
        file.abandon();
        return Promise.resolve(
          err(
            written.isErr()
              ? `${path} could not be written: ${written.error.message}: nothing was saved`
              : "the file's hash is not the one the hub sent: nothing was saved",
          ),
        );
      }
      const finished = file.finish();
      if (finished.isErr()) {
        file.abandon();
        return Promise.resolve(
          err(`${path} could not be put in place: ${finished.error.message}: nothing was saved`),
        );
      }
      return Promise.resolve(ok(undefined));
    },
  };
}

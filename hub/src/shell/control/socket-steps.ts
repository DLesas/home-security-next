/**
 * Which checks make the control socket's place safe, by system (hub-design.md section 9): on
 * macOS and Linux the folder's mode 0700, its owner, and the socket's 0600 checked on the file
 * (`socket-file.ts`, unchanged); on Windows the folder's access list (`windows.ts`, W2).
 */
import type { Result, ResultAsync } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { WINDOWS_CALLS } from "../safe/control-socket-windows.ts";
import { writeStandardError } from "../safe/fs.ts";
import { prepareSocketPath, removeSocket, secureSocket } from "./socket-file.ts";
import { type WarningSink, windowsSocketSteps } from "./windows.ts";

/** How the socket's place is made safe, checked after listening, and removed; one set per system. */
export interface SocketSteps {
  /** Before listening: the folder checked, an old socket removed. */
  readonly prepare: (path: string) => ResultAsync<void, HubError>;
  /** After listening: the socket file checked. */
  readonly secure: (path: string) => Result<void, HubError>;
  /** At a clean stop. */
  readonly remove: (path: string) => Result<void, HubError>;
}

/** macOS and Linux, as built in M1a. */
export const UNIX_SOCKET_STEPS: SocketSteps = {
  prepare: (path) => prepareSocketPath(path),
  secure: (path) => secureSocket(path),
  remove: (path) => removeSocket(path),
};

/**
 * Where `data_folder_was_open` goes when no one is told it: standard error, as the hub's other
 * start-up messages. The running hub passes the loop's sink instead (`onWarning` in `main.ts`),
 * which records it as the core's `shellWarning`.
 */
export const STANDARD_ERROR_WARNINGS: WarningSink = (warning) => {
  writeStandardError(
    { kind: "config", origin: "shell/control/socket-steps" },
    `hub: warning ${warning.code}: ${warning.message}\n`,
  ).match(
    () => undefined,
    () => undefined,
  );
};

/**
 * The steps of the system the hub runs on. Only Windows' use `warn`: on macOS and Linux the
 * folder is tightened to 0700 as built in M1a, without a warning.
 */
export function socketStepsFor(
  platform: NodeJS.Platform,
  warn: WarningSink = STANDARD_ERROR_WARNINGS,
): SocketSteps {
  return platform === "win32" ? windowsSocketSteps(WINDOWS_CALLS, warn) : UNIX_SOCKET_STEPS;
}

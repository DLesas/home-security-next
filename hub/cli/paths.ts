/**
 * Where the control socket is (hub-design.md section 9): `control.sock` in the hub's data
 * folder. Shared by the CLI and the hub's socket server, so both find the same file.
 *
 * SPEC-QUESTION: the design names no data folder. It is `--data <folder>`, else `$HSN_DATA_DIR`,
 * else `$HOME/.hsn`; the hub's service is to run with the same. On Windows the socket is a named
 * pipe, `\\.\pipe\hsn-control` (WAITING: shell/control/windows.ts).
 */

/** The socket's file name in the data folder (section 9). */
export const SOCKET_FILE_NAME = "control.sock";

/** The environment variable that names the data folder. */
export const DATA_FOLDER_VARIABLE = "HSN_DATA_DIR";

/** The data folder's name in the home folder when nothing else names it. */
const DEFAULT_FOLDER_NAME = ".hsn";

/** The Windows counterpart of the socket (section 9: a named pipe with the same access rule ‡). */
export const WINDOWS_PIPE = "\\\\.\\pipe\\hsn-control";

/** The data folder from the flag, the environment, or the home folder; undefined if none is known. */
export function dataFolder(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (flag !== undefined && flag !== "") return flag;
  const named = env[DATA_FOLDER_VARIABLE];
  if (named !== undefined && named !== "") return named;
  const home = env.HOME ?? env.USERPROFILE;
  return home === undefined || home === ""
    ? undefined
    : `${home.replace(/[/\\]+$/u, "")}/${DEFAULT_FOLDER_NAME}`;
}

/** The control socket's path in a data folder. */
export function socketPath(folder: string): string {
  return `${folder.replace(/[/\\]+$/u, "")}/${SOCKET_FILE_NAME}`;
}

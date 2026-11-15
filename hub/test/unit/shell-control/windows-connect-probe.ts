/**
 * What one account meets when it tries the hub's socket on Windows (`windows-hub.test.ts`'s
 * diagnostic): the error `node:net` and `Bun.connect` give, by its code, errno and syscall, for
 * the socket's path as `hsn` writes it (`<folder>/control.sock`) and with Windows' separator;
 * whether the account can list the data folder, whether it sees the socket file, and how its token
 * holds Administrators. Written as
 * JSON to a file, since a process started as another account has no pipes back to the test.
 * Nothing secret is written: paths, codes and messages only.
 *
 *   bun windows-connect-probe.ts <result file> <data folder>
 */
import { existsSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { connect } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";

const [resultFile = "", folder = ""] = process.argv.slice(2);

interface Outcome {
  readonly connected: boolean;
  readonly code: string;
  readonly errno: string;
  readonly syscall: string;
  readonly message: string;
}

function field(error: unknown, name: string): string {
  return typeof error === "object" && error !== null && name in error
    ? String((error as Record<string, unknown>)[name])
    : "";
}

function outcomeOf(error: unknown): Outcome {
  return {
    connected: false,
    code: field(error, "code"),
    errno: field(error, "errno"),
    syscall: field(error, "syscall"),
    message: error instanceof Error ? error.message : String(error),
  };
}

const CONNECTED: Outcome = { connected: true, code: "", errno: "", syscall: "", message: "" };

function viaNode(path: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ...outcomeOf(new Error("no answer in 5 s")), code: "TIMEOUT" });
    }, 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(CONNECTED);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(outcomeOf(error));
    });
  });
}

function viaBun(path: string): Promise<Outcome> {
  return Bun.connect({
    unix: path,
    socket: { data: () => undefined, error: () => undefined, close: () => undefined },
  }).then(
    (socket) => {
      socket.end();
      return CONNECTED;
    },
    (error: unknown) => outcomeOf(error),
  );
}

const asHsn = `${folder.replace(/[/\\]+$/u, "")}/control.sock`;
const asWindows = join(folder, "control.sock");
const listing = await readdir(folder).then(
  (names) => `listed (${names.length} names)`,
  (error: unknown) => `refused: ${field(error, "code")}`,
);
/** How the token holds Administrators: enabled (elevated), deny-only (a normal prompt), or not at all. */
const whoamiPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
const administrators = existsSync(whoamiPath)
  ? (Bun.spawnSync([whoamiPath, "/groups", "/fo", "csv", "/nh"])
      .stdout.toString()
      .split(/\r?\n/u)
      .find((line) => line.includes("S-1-5-32-544")) ?? "(not in the token)")
  : "(no whoami here)";
const result = {
  user: userInfo().username,
  administrators,
  folder,
  listFolder: listing,
  socketFileSeen: existsSync(asWindows),
  nodeHsnPath: await viaNode(asHsn),
  nodeWindowsPath: await viaNode(asWindows),
  bunHsnPath: await viaBun(asHsn),
};
writeFileSync(resultFile, JSON.stringify(result));

/**
 * The Windows installer's first opening (m2-design.md section 9, "Opens the setup page"; "Step 1,
 * wave 2: questions settled"): `hsn-hub installer-page --data <data folder> --sid <the installing
 * user's SID> --folder <that user's %LOCALAPPDATA%\HSN Hub>`, run by the `.msi`'s elevated
 * deferred action as LocalSystem, which the data folder admits.
 *
 * It asks the hub for an installer's console token (10 minutes ‡) over the control socket, makes
 * the folder with an access list of that user, SYSTEM and Administrators only (inheritance
 * removed), and only then writes `setup.html` in it: A2's page (`hub/cli/console-page.ts`), which
 * replaces itself with the address. The Finish dialog then opens the page's path, which is no
 * secret, from the installer's own interface, as the installing person, unelevated. The token is
 * on no command line, and in nothing anyone else can read. Neither the SID nor the folder is kept.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";
import { exchange } from "../../cli/client.ts";
import { pageHtml } from "../../cli/console-page.ts";
import { socketPath } from "../../cli/paths.ts";

/** The page's name: fixed, so the Finish dialog can name its path. */
export const SETUP_PAGE = "setup.html";
const SID = /^S-1-5(?:-\d+)+$/u;

export interface InstallerPage {
  readonly dataDir: string;
  readonly sid: string;
  readonly folder: string;
  readonly platform?: NodeJS.Platform;
  /** Runs `icacls` (Windows); tests give their own. */
  readonly run?: (argv: readonly string[]) => number;
}

export function parseInstallerPageArgs(argv: readonly string[]): InstallerPage | string {
  const get = (flag: string) => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  const dataDir = get("--data");
  const sid = get("--sid");
  const folder = get("--folder");
  if (dataDir === undefined || sid === undefined || folder === undefined)
    return "usage: installer-page --data <folder> --sid <SID> --folder <folder>";
  if (!SID.test(sid)) return `not a user's SID: ${sid}`;
  return { dataDir, sid, folder };
}

function spawnCode(argv: readonly string[]): number {
  return Result.fromThrowable(
    () => Bun.spawnSync([...argv], { stdout: "ignore", stderr: "ignore" }).exitCode,
    () => -1,
  )().unwrapOr(-1);
}

/** The folder, closed to everyone but the user, SYSTEM and Administrators, before the page is in it. */
function closedFolder(page: InstallerPage): Result<void, string> {
  const made = Result.fromThrowable(
    () => {
      mkdirSync(page.folder, { recursive: true });
      rmSync(join(page.folder, SETUP_PAGE), { force: true });
    },
    (thrown) => String(thrown),
  )();
  if (made.isErr()) return err(made.error);
  if ((page.platform ?? process.platform) !== "win32")
    return Result.fromThrowable(
      () => {
        chmodSync(page.folder, 0o700);
      },
      (thrown) => String(thrown),
    )();
  const code = (page.run ?? spawnCode)([
    "icacls",
    page.folder,
    "/inheritance:r",
    "/grant:r",
    `*${page.sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ]);
  return code === 0 ? ok(undefined) : err(`icacls answered ${code}`);
}

/** The page written; its path, which is no secret, or why not. */
export async function writeInstallerPage(page: InstallerPage): Promise<Result<string, string>> {
  const asked = await exchange(
    socketPath(page.dataDir),
    { id: 1, actor: "installer", command: { kind: "consoleToken", for: "installer" } },
    15_000,
  );
  if (asked.isErr()) return err(asked.error.message);
  const reply = asked.value.reply.reply;
  if (!reply.ok || reply.result.kind !== "consoleToken")
    return err("the hub gave no console token");
  const url = reply.result.url;
  const closed = closedFolder(page);
  if (closed.isErr()) return err(closed.error);
  const path = join(page.folder, SETUP_PAGE);
  return Result.fromThrowable(
    () => {
      writeFileSync(path, pageHtml(url), { mode: 0o600, flag: "wx" });
      return path;
    },
    (thrown) => String(thrown),
  )();
}

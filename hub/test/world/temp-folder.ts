import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

/** Lets Linux CI use its memory-backed TMPDIR while keeping Unix socket paths short. */
export function shortTempBase(
  platform: NodeJS.Platform,
  linuxTmpdir: string | undefined,
  systemTmpdir: string,
): string {
  if (platform === "win32") return systemTmpdir;
  if (
    platform === "linux" &&
    linuxTmpdir &&
    linuxTmpdir.length <= 40 &&
    posix.isAbsolute(linuxTmpdir)
  )
    return linuxTmpdir;
  // macOS's system temp directory can be too long for test control sockets.
  return "/tmp";
}

/** Makes a fresh temporary folder with room in its path for a control socket. */
export function shortTempFolder(prefix: string): string {
  return mkdtempSync(join(shortTempBase(process.platform, process.env.TMPDIR, tmpdir()), prefix));
}

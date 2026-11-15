/**
 * Where each system's package puts things (m2-design.md section 9's table), in one place for the
 * build scripts and their tests. The values the hub reads at run time are in
 * `hub/src/shell/m2-values.ts` (`SERVICE`); these are the installers' own.
 *
 * - The **program prefix** holds `versions/<version>/` (the program, `drizzle/`, `web/`), `state/`
 *   (the launcher's and the hub's notes) and `current`. It belongs to the hub's service account,
 *   which unpacks updates into it (section 9, "Hub updates").
 * - The **launcher** lives apart, owned by root or Administrators, so the hub cannot change the
 *   program that rolls it back ("not updated by the hub in M2").
 * - The **data folder** is the hub's alone (HD 6, HD 9): mode 0700 owned by its account on macOS and
 *   Linux; on Windows a protected access list for the service account, Administrators and SYSTEM.
 *   The installer sets it at install and at every upgrade; the hub also tightens it at start.
 * - `hsn` is for administrators only, on every system (section 9, W2): `sudo hsn`, or an elevated
 *   prompt on Windows. The installing user's own account is given nothing.
 */
import { SERVICE } from "../../src/shell/m2-values.ts";

export const INSTALL = {
  macos: {
    label: "com.hsn.hub",
    user: SERVICE.macos.user,
    prefix: "/usr/local/hsn-hub",
    launcher: "/usr/local/libexec/hsn-hub/hsn-launcher",
    dataFolder: SERVICE.macos.dataFolder.replace(/\/$/u, ""),
    hsn: "/usr/local/bin/hsn",
    plist: "/Library/LaunchDaemons/com.hsn.hub.plist",
  },
  linux: {
    unit: "hsn-hub.service",
    user: SERVICE.linux.user,
    group: SERVICE.linux.group,
    prefix: "/opt/hsn-hub",
    launcher: "/usr/lib/hsn-hub/hsn-launcher",
    dataFolder: SERVICE.linux.dataFolder.replace(/\/$/u, ""),
    hsn: "/usr/bin/hsn",
  },
  windows: {
    service: "HSNHub",
    account: SERVICE.windows.account,
    prefix: "[ProgramFiles64Folder]HSN Hub",
    launcher: "[ProgramFiles64Folder]HSN Hub Launcher",
    dataFolder: "[CommonAppDataFolder]HSN Hub",
  },
} as const;

/** The program's name in `versions/<version>/bin/` (the launcher's `programOf`). */
export function programName(platform: "macos" | "linux" | "windows"): string {
  return platform === "windows" ? "hsn-hub.exe" : "hsn-hub";
}

/**
 * Where each system's package puts things (m2-design.md section 9, "The privilege boundary"), in
 * one place for the build scripts and their tests. The values the hub reads at run time are in
 * `hub/src/shell/m2-values.ts` (`SERVICE`); these are the installers' own.
 *
 * - **The package's tree** is root's (Administrators' and SYSTEM's): `packaged/<version>/` (the
 *   packaged version and the one before it), `bin/hsn-launcher`, `version` (the package's own),
 *   `installed` (the marker of a done install, which decides "a fresh install"), and the
 *   installers' own scripts. The hub's account may read and run it, never write it. `hsn` is on
 *   the path beside it, root-owned.
 * - **The hub's trees** are the hub's account's: the data folder, and its sibling program tree
 *   (`staged/<version>/`, `state/`). An elevated step touches only their top folders, one at a
 *   time and never following a link (`prepare-hub-folder.sh`), and removes them whole only on a
 *   purge, links as links.
 */
import { SERVICE } from "../../src/shell/m2-values.ts";

export const INSTALL = {
  macos: {
    label: "com.hsn.hub",
    user: SERVICE.macos.user,
    packageTree: "/usr/local/hsn-hub",
    launcher: "/usr/local/hsn-hub/bin/hsn-launcher",
    dataFolder: SERVICE.macos.dataFolder.replace(/\/$/u, ""),
    programTree: "/Library/Application Support/HSN Hub Program",
    hsn: "/usr/local/bin/hsn",
    plist: "/Library/LaunchDaemons/com.hsn.hub.plist",
  },
  linux: {
    unit: "hsn-hub.service",
    sleepUnit: "hsn-hub-inhibit.service",
    user: SERVICE.linux.user,
    group: SERVICE.linux.user,
    supplementaryGroup: SERVICE.linux.group,
    packageTree: "/usr/lib/hsn-hub",
    launcher: "/usr/lib/hsn-hub/bin/hsn-launcher",
    dataFolder: SERVICE.linux.dataFolder.replace(/\/$/u, ""),
    programTree: "/var/lib/hsn-hub-program",
    hsn: "/usr/bin/hsn",
  },
  windows: {
    service: "HSNHub",
    account: SERVICE.windows.account,
    packageTree: "%ProgramFiles%\\HSN Hub",
    dataFolder: "%ProgramData%\\HSN Hub",
    programTree: "%ProgramData%\\HSN Hub Program",
    installedKey: "HKLM\\Software\\HSN Hub",
  },
} as const;

/** The program's name in `packaged/<version>/bin/` (the launcher's `programIn`). */
export function programName(platform: "macos" | "linux" | "windows"): string {
  return platform === "windows" ? "hsn-hub.exe" : "hsn-hub";
}

# `hub/packaging/`: owner A8

M2, step 1 (docs/m2-design.md section 11). The `.deb`, `.pkg` and `.msi` with their services (section 9), WinSW pinned by `windows/winsw.sha256`.

The platform values are in `hub/src/shell/m2-values.ts`, frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A8` (the checks of `bun run check`, failing only for your folders).

## What is here (A8, step 1)

| Folder | What |
| --- | --- |
| `shared/` | `program.ts` (the one executable: the hub, and `cli` for `hsn`), `build-program.ts` (one version's program and the launcher, on a machine of the target's system), `secure-data-folder.sh` and `open-setup-page.sh` (macOS and Linux installers), `layout.ts` (where each package puts things) |
| `linux/` | `build-deb.sh <amd64\|arm64> <out>`, the systemd unit, the `.deb`'s maintainer scripts, `hsn` |
| `macos/` | `build-pkg.sh <out>`, the launchd daemon, the `.pkg`'s scripts, `hsn`, `uninstall.sh` |
| `windows/` | `build-msi.ps1 -Out <out>` (WiX Toolset 5), `hsn-hub.wix.xml`, WinSW's `HSNHub.xml`, `install-service.ps1` and `uninstall-service.ps1` (the elevated custom actions), `hsn.cmd`, `winsw-pin.ts` (the one check of WinSW against `winsw.sha256`) |

Every package, at install and at every upgrade: the data folder closed to the hub's account (macOS and Linux: owner, mode 0700, nothing inside open to others; Windows: a protected access list of `NT SERVICE\HSNHub`, Administrators and SYSTEM, every entry inside reset to inherit it), whatever the hub does at its own start. `hsn` is for administrators only (`sudo hsn`, or an elevated prompt): no user's account is given anything. On a fresh install the macOS and Linux installers, as root, run `hsn open` for the person at the screen (`SUDO_USER`), which opens the page in their own browser without the address ever on a command line; Linux with no desktop prints the first code. On Windows the elevated custom action asks for an installer's token and writes A2's page into the installing user's own folder, closed to everyone but that user, SYSTEM and Administrators (`shared/installer-page.ts`); the Finish dialog's "Open the setup page" opens its path, unelevated. Releases: `shared/make-release.ts`; a build refuses the tests' publisher key.

Tested on the development Mac (`hub/packaging/test/`): the definitions against section 9 and `SERVICE`, every script's syntax, the data folder closed by the installers' script, the WinSW pin, and a real `.pkg` built by `pkgbuild` around a stand-in program, its payload and scripts read back. Not tested here: installing any package, the services running and restarting, the `.deb` (needs `dpkg-deb`: an Ubuntu runner, and a Pi for arm64) and the `.msi` (needs WiX 5 and a Windows runner); A9's installer matrix runs each.

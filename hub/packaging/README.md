# `hub/packaging/`: owner A8

M2, step 1 (docs/m2-design.md section 11). The `.deb`, `.pkg` and `.msi` with their services (section 9), WinSW pinned by `windows/winsw.sha256`.

The platform values are in `hub/src/shell/m2-values.ts`, frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A8` (the checks of `bun run check`, failing only for your folders).

## What is here (A8, step 1; wave 3: "The privilege boundary")

| Folder | What |
| --- | --- |
| `shared/` | `program.ts` (the hub's executable), `build-program.ts` (one version's program, the launcher and `hsn`, each through `compile.ts`), `prepare-hub-folder.sh` (a hub tree's top folder only, never followed, never recursed), `prune-packaged.sh` (two packaged versions), `open-setup-page.sh` (the setup page through the package's own `hsn`), `layout.ts` (where each package puts things) |
| `linux/` | `build-deb.sh <amd64\|arm64> <out>`, the hub's unit and the root sleep unit, the `.deb`'s maintainer scripts, `hsn` |
| `macos/` | `build-pkg.sh <out>`, the launchd daemon (no log path), the `.pkg`'s scripts, `hsn` (with `uninstall`), `uninstall.sh` |
| `windows/` | `build-msi.ps1 -Out <out>` (WiX Toolset 5), `hsn-hub.wix.xml`, WinSW's `HSNHub.xml` and licence, `tree.ps1` (a hub tree's top folder on its own handle; removal that never enters a reparse point), `install-service.ps1`, `uninstall-service.ps1`, `prepare-upgrade.ps1`, `remove-with-data.ps1`, `winsw-pin.ts`; `hub-folder.sddl` is A11's, pending |
| `hosted/` | `check.sh` and `check.ps1`: the checks A9's installer workflows run on the hosted machines (owners and modes, planted links, a top folder replaced by a link, the console with no desktop) |

Two trees on every system: the package's (root's, Administrators' and SYSTEM's: `packaged/<version>/`, `bin/`, `version`, `installed`) and the hub's (the data folder and its sibling program tree, `staged/` and `state/`). No elevated step reads, writes, recurses into or runs anything from the hub's trees; it makes or checks each top folder alone and, on a purge, removes each whole, links as links. Freshness is the package's `installed` marker (the registry on Windows). No installer chooses a version: the launcher, as the hub's account, runs the newest packaged version at its next start, on trial. A silent install makes no token and no page.

Tested on the development Mac (`hub/packaging/test/`): the definitions against section 9 and `SERVICE`, every script's syntax, the rule in every elevated script's text, `prepare-hub-folder.sh`, `prune-packaged.sh` and `open-setup-page.sh` run, the WinSW pin, and a real `.pkg` built by `pkgbuild` around a stand-in program. Not tested here: installing any package; `hosted/` runs on A9's machines.

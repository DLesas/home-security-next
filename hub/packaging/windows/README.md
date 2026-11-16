# `hub/packaging/windows/`: the `.msi` (A8)

See `hub/packaging/README.md` for the whole. Notes kept here because they bind whoever changes the
build:

- **WiX Toolset 5.0.2**, read on 2026-11-15 from the sources themselves:
  - Licence: "This software is released under the Microsoft Reciprocal License (MS-RL)"
    (https://raw.githubusercontent.com/wixtoolset/wix/v5.0.2/LICENSE.TXT). The v5.0.2 tag has no
    OSMF EULA file (`OSMFEULA.txt` at that tag: not found).
  - Fees: "The Open Source Maintenance Fee was first introduced in WiX v6", and EULA acceptance
    is enforced from WiX v7 (https://docs.firegiant.com/wix/osmf/, moved from
    https://wixtoolset.org/osmf/). No fee or EULA is stated for 5.0.2.
  - **Moving to WiX 6 or later brings the Open Source Maintenance Fee's terms** (and from v7 a
    EULA to accept): do not upgrade WiX casually; it is a decision for the product owner.
- **WinSW 2.12.0**: `WinSW-x64.exe` downloaded at build time and refused unless it matches
  `winsw.sha256`; its MIT licence is kept here (`WinSW-LICENSE.txt`, read from the v2.12.0 tag),
  never downloaded.
- **No licence page**: the installer's dialogs are WiX's own without one (`HsnUI` in
  `hsn-hub.wix.xml`); which licence the product carries is the product owner's decision.
- **`hub-folder.sddl`** is A11's, the one list the hub's checker accepts for each hub tree's top
  folder; `tree.ps1` reads it (never a copy of the string) and refuses when its service SID is not
  `sc showsid HSNHub`'s.

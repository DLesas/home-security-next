# `hub/packaging/hosted/`: the installer's checks on hosted machines (A8)

`check.sh` (macOS, Linux) and `check.ps1` (Windows), run as root or elevated by A9's installer
workflows. The installer job runs `owners` and `console` after install and after upgrade.

The privilege boundary's planted-link checks (`plant`, `verify`, `link-top`, and `check.sh`'s
boundary checks) are a separate job run by hand (D124) and are known not to pass as written.

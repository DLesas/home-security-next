# `.github/workflows/`: owner A9

M2, step 1 (docs/m2-design.md section 11): the continuous integration of M2, the installer matrix (macOS arm64, Ubuntu x64 and arm64, Windows x64) and the browser tests (`bun run app:e2e`). `windows-spikes.yml` is the W2 and W3 spikes' and stays as it is.

**Frozen for you** (changed only through the step 0 owner): the root's `bun run check` and its steps.

Check your work with `bun run check:own A9`.

## The workflows

Every action is pinned by its full commit hash, with its version in a comment. Each job writes what it checked to its job summary; none prints a key, a token, a link code or a console address.

| File | Owner | When | What it does |
| --- | --- | --- | --- |
| `check.yml` | A9 | every push; by hand | `bun install --frozen-lockfile`, then the stages of the root's `bun run check` (read from `package.json` at run time: typecheck, lint, format, test, verify:vectors), each run even when one before it failed, so that one run shows every problem. One row per stage in the summary, with its time and its errors (TypeScript errors, lint lines, files prettier would change, failing tests); the job fails if any stage failed. If `check` ever stops being a plain chain of `bun run` stages, it runs `bun run check` itself. Ubuntu, Bun 1.4.2, Node.js from the runner image (for `verify:vectors`). A second job, on Ubuntu and macOS, runs the root-only `hub/test/root/` once under `sudo` (`HSN_TEST_ACCOUNT=daemon`) and fails if those tests were skipped or fewer than three passed. |
| `installers.yml` | A9 | the `.msi`: a push touching `hub/`, `app/`, `packages/`, the lockfile or these files; every job: by hand (`systems`, `boundary`) | Section 10's installer test (below). |
| `installer-checks.sh`, `installer-checks.ps1` | A9 | (sourced by `installers.yml`) | The checks' helpers: one ✅/❌ line per check in the summary, failures counted rather than stopping the job, and the redaction every log goes through before it is shown or uploaded. |
| `m4.yml` | B7 | every push; by hand | `bun install --frozen-lockfile`, then `bun run m4`: M4's proposed "done when" as numbered checks (a local relay program, the push role with its stand-ins for Apple and Google, the real hub, phones on the phone's own code) and the relay's slow integration tests (`hub/test/relay/`, `HSN_M4=1`), about ten minutes. Every check's line (pass, `KNOWN` with its `FOUND` reference, `FAIL`) and the test counts go to the summary; the job fails if any check or test failed. Ubuntu, Bun 1.4.2. |
| `windows-control-socket.yml` | A11 | a push touching the command socket or `hub/cli/` | The command socket on Windows: real access lists, the real hub and `hsn` from elevated and normal prompts and as a second account. |
| `windows-spikes.yml` | W2, W3 | a push touching their spikes | The Windows spikes, kept as they ran. |

## `installers.yml`

Windows first (D124): on a push only the Windows `.msi` job runs (`windows-latest`). The Linux `.deb` jobs (`ubuntu-24.04` amd64, `ubuntu-24.04-arm` arm64) and the macOS `.pkg` job (`macos-15` arm64) run by hand: *Run workflow* with `systems` set to `linux-x64`, `linux-arm64`, `macos`, `windows` or `all` (default `windows`).

Each installer job builds its package with `hub/packaging/`'s own script after `bun run app:export`, puts its size, SHA-256 and file list in the summary, installs it as a person would but without a person (`sudo apt-get install`, `sudo installer -pkg … -target /`, `msiexec /i … /qn`), then checks, each as one line, the two-tree layout of section 9's "The privilege boundary" (the package's tree `/usr/lib/hsn-hub`, `/usr/local/hsn-hub`, `%ProgramFiles%\HSN Hub`; the hub's data folder and program tree beside it):

- the silent install made no token (the "run `sudo hsn open`" message; no setup page on Windows) and set the `installed` marker;
- A8's `hub/packaging/hosted/check.sh owners` / `check.ps1 -Step owners`, then its `console` check;
- the service runs as its account (`hsn`, `_hsnhub`, `NT SERVICE\HSNHub`) with its restart settings, the launcher from the package's `bin/` with `--package --program --data`, the hub from `packaged/<version>/`, sleep held off (`hsn-hub-inhibit.service`, `caffeinate`), the launcher's state in the hub's program tree naming that version, nothing of the old single-tree layout left, and the firewall rules (Windows; Linux's only when `ufw` is on);
- `hsn status` answers an administrator (`sudo hsn status`; on Windows `hsn status` in an elevated prompt with the machine's `PATH`, and `hsn --data … status`), an ordinary account (`nobody`) is refused with exit 77 on macOS and Linux, and the console listener (`127.0.0.1:8445`) serves the web app;
- both hub trees: nothing inside open to others or owned by another account (macOS, Linux); on Windows each top folder owned by Administrators with a protected list equal to `hub-folder.sddl`'s, nothing inside with an entry of its own;
- the launcher restarts a killed hub;
- uninstalling (`apt-get remove`, `sudo hsn uninstall`, `msiexec /x`) removes the service, the package's tree, `hsn` and the firewall rules and keeps both hub trees; removing with data (`apt-get purge`; `sudo hsn uninstall --remove-data --yes` after installing again; `msiexec /x … REMOVEDATA=1` after installing again) removes both hub trees (and the account on macOS and Linux).

With `boundary` ticked, the `boundary-unix` and `boundary-windows` jobs run for the chosen systems instead of in the ordinary run: they build two versions (the checkout's, then the same code with its patch number raised in the runner's copy of `hub/package.json`), install the first, and run A8's `plant` before and `verify` after the upgrade, the uninstall and the removal with data, `owners` after the install and the upgrade, and `link-top` with the installer's own step (a reinstall, or the `.msi`'s repair), checking from the installer's output that it refused because of the link; and that the launcher switched to the new packaged version and ended its trial healthy.

No check stops a job; its last step fails if any failed. The logs (build and install output, the journal, the unified log's lines, WinSW's logs, the Windows event log's lines, `launcher-status.json` and `fatal.log` if present, the msi's verbose logs, A8's checks' output) are redacted and uploaded as the job's artifact. `hub.db` and the hub's keys are never read.

What each job relies on: the runner image's `sudo`, `curl`, `bash`, PowerShell 7 and .NET SDK; the system's own tools (dpkg, apt, systemd, adduser, procps; pkgbuild, pkgutil, installer, launchctl, dscl; msiexec, sc.exe, netsh, icacls, mountvol, robocopy, Windows PowerShell); Bun from `oven-sh/setup-bun`; the npm packages of `bun.lock`. Nothing is installed from Homebrew, winget or Chocolatey. Two things are downloaded: WinSW 2.12.0 by `build-msi.ps1`, refused unless it matches `hub/packaging/windows/winsw.sha256`, and WiX Toolset 5.0.2 with its UI and Util extensions, from nuget.org, refused unless each matches the SHA-512 pinned in the Windows job's `env`, checked before anything in the package is read or run. The pins are nuget.org's own `packageHash` (SHA512, base64) from each package's catalog entry, read from the publisher's index on 2026-11-15 without downloading the packages. They protect against the file changing after that day, not against a wrong first read: whoever reviews them can compare them with the catalog entries named in the job's `env`.

What a hosted runner cannot show: a reboot (section 10's reboot test is in a virtual machine), a real UAC prompt, what a person sees in the browser, an upgrade between two really different versions (the boundary jobs' second version is the same code), a Raspberry Pi. `ubuntu-24.04-arm` runners must be available to this repository's plan, or that job waits for one.

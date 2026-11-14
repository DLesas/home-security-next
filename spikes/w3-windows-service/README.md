# Spike W3: hosting the hub as a Windows service

From `docs/m2-design.md` section 9, "W3", run beside W2 on GitHub's hosted `windows-latest` runner through `.github/workflows/windows-spikes.yml`.

## The question

A Windows service must answer the Service Control Manager, which a Bun program does not do by itself. How is the hub hosted as a service that starts at boot with nobody logged in, restarts after exit code 70 (HD 10, "restart me"), and stops cleanly, under the virtual account `NT SERVICE\HSNHub`, with its data folder `%ProgramData%\HSN Hub\` limited to that account and Administrators?

## The options (from the design)

- (a) WinSW ‡, a small open-source wrapper (MIT) that runs any program as a service;
- (b) the launcher answers the manager itself through `bun:ffi`, which needs a callback from another thread, risky under Bun;
- (c) the launcher written in the helper's language, if W1 chose a helper.

Recommendation: (a), or (c) if W1 chose (b). This spike tests (a).

## Pass criteria (from the design)

> **Spike W3** ‡ (a day, with W2 on the runner, and a reboot in a virtual machine): installed as a service, started at boot with nobody logged in, restarted after exit code 70, stopped cleanly.
>
> **Paths and access lists**: the data folder and `console.secret` are limited to the service account, the installing user (for `console.secret` and the command secret, if W2 chose (c)) and Administrators.

A hosted runner cannot reboot itself, so "started at boot" is checked here as the start type (`AUTO_START`) and a stop and a start by the manager; the reboot stays for the virtual machine.

## What the script tests

`w3.ts` (after W2, in the same job; it reuses W2's helpers and second account) wraps each program in WinSW `v2.12.0` (the workflow downloads it and refuses any file whose SHA-256 is not the one pinned in `WINSW_SHA256`):

- **HSNExit70 / HSNExit0**: `exit-code.ts`, a stand-in that records each start and exits 70 or 0, with "restart on failure": 70 must be restarted (at least three starts in 12 s), 0 must not (one start).
- **HSNHub**: the hub's own entry point, `bun hub/src/shell/main.ts --data "%ProgramData%\HSN Hub" --port 0 --no-usb-watch`, set to run as `NT SERVICE\HSNHub` (`sc.exe config … obj=`), start type automatic. Checked: installed with that account and start type; started by the manager, the hub writes its boot (`boots` in `hub.db`) and runs as that account; the data folder's access list, and the second account unable to list it or read `hub.db`; stopped by the manager, the hub's clean-stop mark written (`boots.clean_stop_ms`); started again, the hub reads the run before as a clean stop (`previous_exit = clean`).
- **HSNProbeUnix / HSNProbeTcp**: W2's stand-in control socket (`server.ts`) as a service under its own virtual account, in a folder admitting that account, the installing user, Administrators and SYSTEM: the installing user is answered; the second account is refused. One for AF_UNIX, one for loopback TCP with a secret file, so whichever W2 chooses is covered.

The hub on Windows does not open its control socket yet (hub-design section 9), so the socket under a service is checked with the stand-in, not the hub.

Each test prints one JSON line, as W2's do, to `--out`. Every service is removed at the end.

## Running it

```sh
WINSW=C:\path\to\WinSW-x64.exe bun spikes/w3-windows-service/w3.ts --out results/w3.jsonl --repo .
```

On macOS or Linux, or without `WINSW`, it writes one WinSW configuration and runs the stand-in once, and skips the rest.

The scripts are outside the root check, as W2's are (see its README).

## Results

### Run 1 (43628502580, Bun 1.4.2, `windows-latest`, WinSW v2.12.0, SHA-256 `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`, now pinned in the workflow)

| What | Result |
| --- | --- |
| Exit code 70 restarted by the service manager; exit code 0 not | pass |
| The hub installed as a service under `NT SERVICE\HSNHub`, start type automatic; its process ran as that account | pass |
| Started by the manager, the hub writes its boot | pass (twice) |
| Stopped by the manager, the hub's clean-stop mark written (`boots.clean_stop_ms`); WinSW's stop reached the hub's own stop handler | pass (twice) |
| Started again, the hub reads the run before as a clean stop | pass |
| The data folder's access list: SYSTEM, Administrators and `NT SERVICE\HSNHub` only, inheritance off | as set; the second account's attempt not run (W2's account was not made; fixed for run 2) |
| The stand-in control socket as a service | not run: the script stopped on `stat` of the socket file (`EACCES`, see W2's README); fixed for run 2 |

**The hub's own data folder check on Windows.** The service's error log: `hub: the control socket could not open: the data folder is open to other accounts`. That is the hub refusing its control socket on Windows as designed today, but this refusal comes from the folder check in `shell/control/socket-file.ts`, which reads POSIX mode bits: on Windows `stat` reports synthetic modes with group and other bits set, so every folder looks "open to other accounts", even this one, whose access list admits only SYSTEM, Administrators and the service account. On Windows the check would need: the folder's DACL read through `GetNamedSecurityInfoW` (`bun:ffi`), protected (no inherited entries), and every allowing entry for one of the hub's account (`NT SERVICE\HSNHub`), Administrators, SYSTEM and, if W2 chose (c) or the design keeps it for `console.secret`, the installing user's SID stored at install; no entry for Users, Authenticated Users or Everyone. The owner check (`uid`) has no meaning there and would be replaced by the DACL's owner SID. The socket file's own `lstat` check fails too (W2's README).

### Run 2

_Pending: the second account against the data folder, and the stand-in control socket as a service (AF_UNIX and loopback TCP)._

Verdict: _pending._

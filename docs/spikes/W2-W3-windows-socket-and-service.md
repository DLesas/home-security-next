# W2 and W3: the command socket and the service on Windows

Run on GitHub's hosted Windows machine (`windows-latest`, x64, Bun 1.4.2) on 2026-11-14, by the scripts in `spikes/w2-windows-control-socket` and `spikes/w3-windows-service` (workflow `windows-spikes.yml`, run 43629289478). They settle two of the three Windows questions of decision D118; the third, W1 (a USB serial port under Bun), needs a real Windows computer and is still open (O18).

## Short answer

- **The command socket on Windows is a Unix-domain socket in a folder whose access list is limited to the hub's account, Administrators and SYSTEM.** Bun reaches it, and a second local account is refused. No other system changes its socket.
- **The hub runs as a Windows service** under its own service account, restarted after a crash and stopped cleanly by the service manager.

## W2: the command socket

A second local account was created on the machine, and a client was run as it against each kind of socket.

| Option | Same user | Second account | Verdict |
| --- | --- | --- | --- |
| Unix-domain socket in a folder locked to the user, Administrators and SYSTEM | answered | refused (`EACCES`) | works |
| The same in the user's temp folder, and in ProgramData | answered | refused | works |
| The same in an ordinary folder with inherited access | answered | **answered** | unsafe: the folder's access list is the whole protection |
| The same in an ordinary folder, with the socket file's own access list limited | answered | refused | works, but one mistake away from the row above |
| Loopback TCP with a secret file the second account cannot read | answered | cannot read the secret, not answered | works: the fallback, not needed |
| Loopback TCP: a web page's request, by `fetch` and by a real browser (headless Edge) | | refused | a page cannot drive it |

Both of Bun's socket interfaces (`node:net` and `Bun.listen`) gave the same results.

What the hub's code must allow for on Windows:

- `stat` of the socket file fails with `EACCES`, so the hub cannot check the file's kind or owner as it does on macOS and Linux. It can check that the file exists.
- The safety check is therefore on the folder: read its access list and refuse to open the socket unless only the hub's account, Administrators and SYSTEM have access. Today the hub refuses on Windows outright ("the data folder is open to other accounts"); that refusal is replaced by this check.
- The second account was refused by a named pipe too, which the hub design did not expect (it says a pipe made this way is open to every user). The run did not find out why, and nothing depends on it: the pipe is not used.

## W3: the service

With WinSW 2.12.0 as the service wrapper (its file's SHA-256, `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`, is pinned in the workflow):

| Check | Result |
| --- | --- |
| The hub installed as a service under `NT SERVICE\HSNHub`, start type automatic | yes |
| Exit code 70 (the hub asking for a restart) | restarted |
| Exit code 0 (a clean stop) | not restarted |
| Stopped by the service manager | the hub wrote its clean-stop mark, and the next start read the run before as clean |
| The data folder limited to the service account, Administrators and SYSTEM | yes; the second account cannot read it |
| The command socket served by the service | the installing user answered, the second account refused, for the Unix-domain socket and for the fallback |

## What is not shown

- A hosted machine has no USB port: nothing here says the hub can open a board's serial port on Windows (W1, O18).
- The account that installed the service was also an administrator. An ordinary user who is not an administrator, given access by the installer, was not tried.
- Start at boot was checked by the start type and by a stop and start, not by restarting the machine.
- One machine, one Windows version, x64 only.

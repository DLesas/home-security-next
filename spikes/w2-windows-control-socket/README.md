# Spike W2: a command socket only the right accounts can reach (Windows)

From `docs/m2-design.md` section 9, "W2". Runs on GitHub's hosted `windows-latest` runner through `.github/workflows/windows-spikes.yml` (manual trigger, or a push touching `spikes/w2-*`, `spikes/w3-*` or the workflow). Nobody on the project has a Windows computer, so the runner is the only place it runs.

## The question

What must hold (HD 9): the hub's own account, the user who installed it and Administrators can send commands; no other user of the computer, and no web page, can.

## The options (from the design)

| Option | How |
| --- | --- |
| (a) A Unix-domain socket on Windows | Windows 10 (1803) and later have `AF_UNIX` sockets, guarded by the socket file's access list as on macOS and Linux. If Bun's `unix` listener and `net.connect(path)` use them on Windows, the hub's existing control server works unchanged, with the file's access list set to the three accounts |
| (b) A named pipe made through `bun:ffi` | `CreateNamedPipeW` with a security descriptor granting the service account, the installing user and Administrators, served from a worker |
| (c) Loopback TCP with a secret | The hub listens on 127.0.0.1 only; a connection's first line must carry a 32-byte secret read from a file whose access list admits only the three accounts; the rest is the existing control protocol |
| (d) A native helper owning the pipe | As W1 (b) |

The design's recommendation: (a) if the spike shows Bun reaching `AF_UNIX` on Windows; otherwise (c). (b) only if both fail.

## Pass criteria (from the design)

> **Spike W2** ‡ (two days, on a hosted Windows runner, since no board is needed): for (a), listen, set the file's access list, and check that the installing user and an administrator connect while a second local user, made in the job, is refused; for (c), the same checks against the secret file, and a browser page's request to the port refused.

## What the scripts test

`w2.ts` runs as the runner's own account, which is both the "installing user" and an administrator. It makes a second local account (`hsnspike2`, an ordinary member of Users, with a 14-character password made in the run and never printed) with `net user … /add`, which needs no PowerShell module, and runs `client.ts` as that account by the first of three ways that works: `CreateProcessWithLogonW` through `bun:ffi` (`logon.ts`, no PowerShell at all); `Start-Process -Credential` in Windows PowerShell started with no `PSModulePath`; a scheduled task run once as the account. The "second account" line says which worked. A second-account test that could not run is "inconclusive", never "pass".

Why: in the first hosted run the account was never made. Windows PowerShell 5, started from a step running under PowerShell 7, inherited 7's `PSModulePath` and could not load `Microsoft.PowerShell.Security` (`ConvertTo-SecureString`), a known clash on these runners. Every PowerShell the scripts start now gets no `PSModulePath`, so it rebuilds its own; and the account and the first way of running as it no longer use PowerShell. (`net user` takes the password on its command line, visible to the runner's other processes for that moment; it is a throwaway account on a throwaway machine.)

- **(a) AF_UNIX**, with both `node:net` and `Bun.listen`, in four folders: the user's temp folder, an ordinary folder (inherited access list, so every user may connect), a folder locked to the user, Administrators and SYSTEM (`icacls /inheritance:r`), and `%ProgramData%`. For each: does it listen; is there a socket file at the path (a path mapped to a named pipe leaves none); does the same user connect with `node:net` and with `Bun.connect`; does the second account connect. In the ordinary folder, the socket file's own access list is then set to the three accounts and the second account tried again.
- **(b) named pipe made by `node:net`** (and by `Bun.listen` on a pipe path): does the second account connect. The design expects yes (open to everyone), which is why the hub refuses it today; that line's "fail" is expected.
- **(c) loopback TCP with a secret file** in the locked folder: the user with the file is answered; a wrong secret is refused; the second account cannot read the file, and connecting without it gets no answer; a page's request is refused, both by `fetch` sending what a browser sends and, when Edge is on the runner, by a headless Edge page posting to the port.

Each test prints one JSON line (`{"spike":"W2","test":…,"result":"pass|fail|skip|inconclusive","expected"?:…,"observed":…}`) and appends it to `--out`. An option that does not work is a result: the scripts never fail the job for it. `summary.ts` turns the lines of W2 and W3 into the job summary's table.

`server.ts` is the stand-in control socket (one line protocol: the secret first when there is one, then `ping` answered `pong`, anything else `refused`); W3 runs it as a service.

## Running it

```sh
bun spikes/w2-windows-control-socket/w2.ts --out results/w2.jsonl
bun spikes/w2-windows-control-socket/summary.ts results/w2.jsonl
```

On macOS or Linux the Windows-only steps print "skip" and the rest runs (AF_UNIX, TCP and the secret, the page's request), which checks the plumbing.

The scripts are outside the root check: `spikes/` is in ESLint's ignores and `.prettierignore`, not in the root `tsconfig.json`, and no file is named `*.test.ts`, so `bun test` does not pick them up.

## Results

### Run 1 (43628502580, Bun 1.4.2, `windows-latest`)

| What | Result |
| --- | --- |
| AF_UNIX listens and leaves a file at the path, `node:net` and `Bun.listen`, in all four folders | pass |
| The same user connects to it with `node:net` and with `Bun.connect` | pass |
| The second account: AF_UNIX, the named pipes, the secret file | not run: the account was not made (above); fixed for run 2 |
| Loopback TCP: the user with the secret answered, a wrong secret refused, a `fetch` request refused | pass |
| A real browser's request (headless Edge) | inconclusive: Edge ran with the spike's server blocked (a synchronous spawn held the event loop) and its result was not checked; fixed for run 2, which tells "the page never ran" from "the browser blocked it" and "the port refused it" |

**`stat` of a socket file fails on Windows.** `fs.statSync` (and so `lstat`) of an AF_UNIX socket file fails with `EACCES` for its own creator (`C:\ProgramData\HSN Spike\unix-node.sock`, and every other folder), though `icacls` reads its access list and connecting works: Windows makes the socket a reparse point that `stat` cannot open. So code that checks a socket file's kind (`isSocket()`) or owner (`uid`), as the hub's `shell/control/socket-file.ts` does after `listen`, cannot run on Windows: it would refuse its own socket. On Windows the checks must be on the access list instead: the folder's (and the file's) DACL read with `GetNamedSecurityInfoW` through `bun:ffi`, or set by the installer and trusted. Existence (`existsSync`) works.

### Run 2

_Pending: the second account (and how it ran), the AF_UNIX access lists, the named pipes, the secret file, and the browser._

Verdict: _pending._

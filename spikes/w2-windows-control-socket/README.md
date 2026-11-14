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

`w2.ts` runs as the runner's own account, which is both the "installing user" and an administrator. It makes a second local account (`hsnspike2`, an ordinary member of Users, with a password made in the run and never printed) and runs `client.ts` as that account through `Start-Process -Credential`, or, if that cannot start a process from the runner's session, through a scheduled task. The first result line says which worked; without either, every second-account line is "inconclusive".

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

_To be filled from the first hosted run: the job's summary table and its `windows-spikes` artifact._

| Test | Result | Observed |
| --- | --- | --- |
| | | |

Verdict: _pending._

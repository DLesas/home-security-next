# `hub/src/shell/control/`: owner A11

M2, step 1 (docs/m2-design.md section 11). The control socket on Windows (W2: an AF_UNIX socket in a folder locked by its access list; the folder check reads the access list there), and the serial path (`hub/src/shell/safe/serial*.ts`) as W1 decides.

- `server.ts`: the socket's server, the same on every system; `socket-steps.ts` picks the checks by system.
- `socket-file.ts`: macOS and Linux, as built in M1a (mode 0700 and 0600, owners).
- `windows.ts`: Windows (the account, the folder, links, the volume, the socket file read back); `windows-acl.ts`: the access-list rule itself, pure, tested on every system with lists given as data. The Win32 calls are `../safe/control-socket-windows.ts`.
- Tests: `hub/test/unit/shell-control/` (`windows-real.test.ts` and `windows-hub.test.ts` run on Windows only, by `.github/workflows/windows-control-socket.yml`) and `hub/test/unit/safe/control-socket-windows.test.ts`.

The control protocol is frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A11` (the checks of `bun run check`, failing only for your folders).

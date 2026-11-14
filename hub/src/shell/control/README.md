# `hub/src/shell/control/`: owner A11

M2, step 1 (docs/m2-design.md section 11). The control socket on Windows (W2: an AF_UNIX socket in a folder locked by its access list; the folder check reads the access list there), and the serial path (`hub/src/shell/safe/serial*.ts`) as W1 decides.

The control protocol is frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A11` (the checks of `bun run check`, failing only for your folders).
